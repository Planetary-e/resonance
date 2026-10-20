import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { openPolicyObserverRecovery, preparePolicyObserverRecovery, POLICY_OBSERVER_RECOVERY_FILENAME } from '../policy-observer-recovery.js';
import { openProtectedPolicyObserver, POLICY_OBSERVER_RECOVERY_FENCE } from '../protected-policy-observer.js';
import { policyObserverRecoveryFixture } from './fixtures/policy-observer-recovery-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { return policyObserverRecoveryFixture(close => cleanup.push(close)); }
async function initialize(n: Awaited<ReturnType<typeof fixture>>, unavailable = false) {
  const review = await preparePolicyObserverRecovery({ ...n.recoveryOptions, source: unavailable ? 'unavailable' : n.observer.reviewRecoverySource() });
  const recovery = await openPolicyObserverRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } });
  cleanup.push(recovery.close); return recovery;
}
async function finish(recovery: Awaited<ReturnType<typeof openPolicyObserverRecovery>>) {
  for (let step = 0; step < 12 && !recovery.status().complete; step++) await recovery.advance({ maxBlocks: 1 });
  expect(recovery.status().complete).toBe(true);
}

it('resumes each real-socket phase, permanently fences the available source and separately restores fresh signing readiness', async () => {
  const n = await fixture(); await n.observer.advance(n.advance);
  let recovery = await initialize(n); const minimum = n.observer.recoveryState();
  expect(n.observer.status().fenced).toBe(true); await expect(n.observer.advance(n.later)).rejects.toThrow('fenced');
  n.observer.close(); const old = await openProtectedPolicyObserver({ ...n.options, mode: 'open-existing' }); cleanup.push(old.close);
  expect(old.recoveryState()).toEqual(minimum); await expect(old.ready()).rejects.toThrow('fenced');
  for (let step = 0; step < 12 && !recovery.status().complete; step++) {
    await recovery.advance({ maxBlocks: 1 }); const status = recovery.status(), calls = n.calls(); recovery.close();
    recovery = await openPolicyObserverRecovery(n.recoveryOptions); cleanup.push(recovery.close);
    expect(recovery.status()).toEqual(status); expect(n.calls()).toBe(calls);
  }
  expect(recovery.status().complete).toBe(true); const calls = n.calls(), destination = join(n.directory, 'restored');
  const { preparation, continuation } = await recovery.reviewRestore(destination); expect(n.calls()).toBe(calls);
  expect(preparation.review.policyRevision).toBe(2);
  const observer = await openProtectedPolicyObserver({ ...n.options, directory: destination, root: continuation, genesis: n.enrolled.root,
    members: n.recoveryMembers, transport: n.recoveryOptions.transport, mode: 'create-new', restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); cleanup.push(observer.close);
  n.online(3); await expect(observer.ready()).rejects.toThrow('Four'); n.online(5); await observer.ready();
  expect(observer.recoveryState()).toEqual(minimum); await observer.advance(n.later); expect(observer.policy()).toEqual(n.third);
}, 60000);

it('requires explicit source loss, an authentic review and unchanged source state before fencing or freezing', async () => {
  const n = await fixture(), before = n.stores.map(store => store.describe());
  const source = n.observer.reviewRecoverySource();
  await expect(preparePolicyObserverRecovery({ ...n.recoveryOptions, source: structuredClone(source) })).rejects.toThrow('capability');
  const review = await preparePolicyObserverRecovery({ ...n.recoveryOptions, source });
  for (const candidate of [review, structuredClone(review)]) await expect(openPolicyObserverRecovery({ ...n.recoveryOptions,
    initialize: { review: candidate, approvedDigest: candidate === review ? 'wrong' : review.approvalDigest } })).rejects.toThrow('reviewed');
  expect(n.stores.map(store => store.describe())).toEqual(before);
  await n.observer.advance(n.advance);
  await expect(openPolicyObserverRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } })).rejects.toThrow('changed');
  expect(n.observer.status().fenced).toBe(false); expect(existsSync(n.recoveryOptions.directory)).toBe(false);
  n.observer.close(); const recovery = await initialize(n, true); expect(recovery.status().localStateDigest).toBeNull();
  await finish(recovery); const result = await recovery.reviewRestore(join(n.directory, 'lost-source'));
  expect(result.preparation.review.policyRevision).toBe(2);
}, 60000);

it.each(['advance', 'conflict'])('confirms pending local %s evidence before source fencing, retaining refusal when four copies are unavailable', async kind => {
  const n = await fixture(); await n.observer.advance(n.advance); n.loseReplies(true);
  await expect(n.observer.advance(kind === 'advance' ? n.later : n.conflict)).rejects.toThrow('Four'); n.loseReplies(false);
  const minimum = n.observer.recoveryState(), review = await preparePolicyObserverRecovery({ ...n.recoveryOptions, source: n.observer.reviewRecoverySource() });
  n.online(3);
  await expect(openPolicyObserverRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } })).rejects.toThrow('Four');
  expect(n.observer.status().fenced).toBe(false); expect(n.observer.status().pending).toBe(true);
  expect(existsSync(n.recoveryOptions.directory)).toBe(false); expect(n.stores.every(store => !store.describe().freeze)).toBe(true);
  n.online(5); const recovery = await openPolicyObserverRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  expect(n.observer.status().pending).toBe(false); expect(n.observer.recoveryState()).toEqual(minimum);
  await finish(recovery); const { preparation, continuation } = await recovery.reviewRestore(join(n.directory, 'restored'));
  expect(preparation.review.blocked).toBe(kind === 'conflict');
  const restored = await openProtectedPolicyObserver({ ...n.options, directory: preparation.review.directory, root: continuation, genesis: n.enrolled.root,
    members: n.recoveryMembers, transport: n.recoveryOptions.transport, mode: 'create-new', restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); cleanup.push(restored.close);
  expect(restored.recoveryState()).toEqual(minimum);
  if (kind === 'conflict') await expect(restored.ready()).rejects.toThrow('equivocated'); else await restored.ready();
}, 60000);

it.each(['missing', 'corrupt'])('preserves %s registered work without recreating it or transmitting', async damage => {
  const n = await fixture(), recovery = await initialize(n); await recovery.advance(); recovery.close();
  const path = join(n.recoveryOptions.directory, 'freeze', 'history-recovery.json');
  if (damage === 'missing') rmSync(path); else writeFileSync(path, 'damaged');
  const count = n.calls(), journal = readFileSync(join(n.recoveryOptions.directory, POLICY_OBSERVER_RECOVERY_FILENAME));
  if (damage === 'missing') await expect(openPolicyObserverRecovery(n.recoveryOptions)).rejects.toThrow('missing');
  else { const opened = await openPolicyObserverRecovery(n.recoveryOptions); cleanup.push(opened.close); await expect(opened.advance()).rejects.toThrow(); }
  expect(n.calls()).toBe(count); expect(readFileSync(join(n.recoveryOptions.directory, POLICY_OBSERVER_RECOVERY_FILENAME))).toEqual(journal);
});

it('resumes frozen stores after lost freeze replies and keeps source fencing across cancellation', async () => {
  const n = await fixture(); let loseReplies = true, replies = 0, release!: () => void;
  const allStored = new Promise<void>(resolve => { release = resolve; }), transport = n.recoveryOptions.transport;
  n.recoveryOptions.transport = async (member, frame, signal) => {
    const reply = await transport(member, frame, signal);
    if (loseReplies && frame.request.action === 'freeze') {
      if (++replies === 5) release(); await allStored;
      if (n.enrolled.context.members.indexOf(member.publicKey) >= 3) throw new Error('Stored freeze reply lost');
    }
    return reply;
  };
  const recovery = await initialize(n);
  await expect(recovery.advance()).rejects.toThrow('Four'); expect(recovery.status().phase).toBe('freeze');
  expect(n.stores.filter(store => store.describe().freeze).length).toBe(5);
  await expect(recovery.reviewRestore(join(n.directory, 'premature'))).rejects.toThrow('not completed');
  const aborted = new AbortController(); aborted.abort(); await expect(recovery.advance({ signal: aborted.signal })).rejects.toThrow('cancelled');
  loseReplies = false; n.online(4); await finish(recovery); expect(existsSync(join(n.options.directory, POLICY_OBSERVER_RECOVERY_FENCE))).toBe(true);
  // This case includes setup, five durable freezes, cancellation and every
  // recovery phase. Windows CI exceeded Vitest's default five-second case limit.
}, 30000);

it('refuses semantic evidence deletion before confirming or provisioning a new generation', async () => {
  const n = await fixture(); await n.observer.advance(n.advance); await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated');
  const state = n.observer.recoveryState(), recovery = await initialize(n); n.observer.close();
  // A compromised history owner can sign ciphertext; replicas cannot decrypt
  // its policy semantics. Recovery must independently detect the deletion.
  const writer = createRetainedHistoryCheckpointWriter({ directory: n.options.directory, localKey: n.key, context: n.enrolled.context,
    rootId: historyCheckpointEnvelopeId(n.enrolled.root), generation: 0, signingKey: n.owner, members: n.members, transport: n.transport }); cleanup.push(writer.close);
  const previous = writer.read().committed!.envelope;
  const bad = sealHistoryCheckpoint({ context: n.enrolled.context, encryptionKey: n.key, signingKey: n.owner,
    header: { kind: 'checkpoint', generation: 0, sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous) },
    plaintext: Buffer.from(JSON.stringify({ ...state, conflict: null })) });
  await writer.replicate(bad); writer.close();
  await recovery.advance(); await recovery.advance(); await recovery.advance();
  await expect(recovery.advance()).rejects.toThrow('equivocation');
  expect(recovery.status()).toMatchObject({ phase: 'download-and-confirm', complete: false });
  expect(n.stores.every(store => store.activatedContinuation() === null)).toBe(true);
  await expect(recovery.reviewRestore(join(n.directory, 'unsafe'))).rejects.toThrow('not completed');
}, 30000);

it('cancels an active unresponsive freeze, preserves the source fence and resumes only on an explicit new attempt', async () => {
  const n = await fixture(), transport = n.recoveryOptions.transport;
  let stuck = false, started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; });
  n.recoveryOptions.transport = (member, frame, signal) => {
    if (stuck && frame.request.action === 'freeze') { started(); return new Promise(() => {}); }
    return transport(member, frame, signal);
  };
  const recovery = await initialize(n), controller = new AbortController(); stuck = true;
  const operation = recovery.advance({ signal: controller.signal }); await reached;
  // Bound cancellation itself independently of fixture setup and the complete
  // resumed recovery. The injected transport never observes the abort signal.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settlement = Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Active freeze did not settle within 1000ms after abort')), 1000);
    })]);
    const cancelledAt = performance.now(); controller.abort();
    await expect(settlement).rejects.toThrow(/cancelled|closed/);
    expect(performance.now() - cancelledAt).toBeLessThan(1000);
  } finally { clearTimeout(timer); }
  expect(n.observer.status().fenced).toBe(true);
  expect(() => recovery.status()).toThrow('closed'); stuck = false;
  const reopened = await openPolicyObserverRecovery(n.recoveryOptions); cleanup.push(reopened.close); await finish(reopened);
}, 30000);
