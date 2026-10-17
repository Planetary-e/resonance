import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionPolicyHeadRequest } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointEnvelopeId, openHistoryCheckpoint, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { replayPolicyObserverHistory } from '../policy-observer-history-replay.js';
import { preparePolicyObserverRestore } from '../policy-observer-history-restore.js';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { policyObserverRestoreFixture } from './fixtures/policy-observer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { return policyObserverRestoreFixture(close => cleanup.push(close)); }
async function restore(selected: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['recover']>>) {
  const preparation = await preparePolicyObserverRestore(selected.restoreOptions);
  const observer = await openProtectedPolicyObserver({ ...selected.openOptions, mode: 'create-new',
    restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); cleanup.push(observer.close);
  return { observer, preparation };
}

it('restores a downloaded complete policy head through two certified generations and requires fresh readiness', async () => {
  const n = await fixture(); await n.observer.advance(n.advance);
  const selected = await n.recover(), { observer } = await restore(selected);
  expect(observer.policy()).toEqual(n.second);
  await expect(n.observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('Four');
  n.online(3); await expect(observer.ready()).rejects.toThrow('Four');
  await expect(observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('pending');
  n.online(5); await observer.ready();
  expect((await observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.advance.commitment.next);
  await observer.advance(n.later); observer.close();
  const reopened = await openProtectedPolicyObserver({ ...selected.openOptions, mode: 'open-existing' }); cleanup.push(reopened.close);
  expect((await reopened.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.later.commitment.next);
  const second = await n.recover(), replay = await replayPolicyObserverHistory(second.replayOptions);
  expect(replay.generations).toBe(2); expect(replay.state.policy).toEqual(n.third);
  const again = await restore(second); await again.observer.ready();
  expect((await again.observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.later.commitment.next);
  await expect(reopened.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('Four');
}, 30000);

it('preserves an update whose owner lost replies before four confirmations and repairs the selected tail before recovery', async () => {
  const n = await fixture(); n.loseReplies(true); await expect(n.observer.advance(n.advance)).rejects.toThrow('Four');
  expect(n.observer.status().pending).toBe(true);
  expect(n.stores.filter(store => store.describe().sequence === 1).length).toBeGreaterThanOrEqual(2);
  n.observer.close(); n.loseReplies(false);
  const selected = await n.recover(), replay = await replayPolicyObserverHistory(selected.replayOptions);
  expect(replay.state.policy).toEqual(n.second); expect(replay.head.sequence).toBe(1);
  const { observer } = await restore(selected); await observer.ready();
  expect((await observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.advance.commitment.next);
}, 30000);

it('reconstructs terminal equivocation evidence without turning a new generation into permission to sign', async () => {
  const n = await fixture(); await n.observer.advance(n.advance); await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated');
  const selected = await n.recover(), { observer, preparation } = await restore(selected);
  expect(preparation.review.blocked).toBe(true); expect(observer.status().evidence).toHaveLength(2);
  await expect(observer.ready()).rejects.toThrow('equivocated'); expect(observer.status().pending).toBe(false);
  await expect(observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('equivocated');
  observer.close(); const reopened = await openProtectedPolicyObserver({ ...selected.openOptions, mode: 'open-existing' }); cleanup.push(reopened.close);
  expect(reopened.status().evidence).toHaveLength(2); await expect(reopened.advance(n.later)).rejects.toThrow('equivocated');
}, 30000);

it('rejects missing, altered, duplicate and misbound replay inputs without returning a partial state', async () => {
  const n = await fixture(); await n.observer.advance(n.advance); await n.observer.advance(n.later); const selected = await n.recover();
  const originalKey = Buffer.from(n.key);
  for (const damage of ['genesis', 'middle', 'duplicate', 'reordered', 'extra', 'key', 'pin', 'blocks', 'bytes', 'cancelled', 'signature'] as const) {
    const input = { ...selected.replayOptions, blocks: structuredClone(selected.replayOptions.blocks) };
    if (damage === 'genesis') input.blocks.shift();
    if (damage === 'middle') input.blocks.splice(1, 1);
    if (damage === 'duplicate') input.blocks.splice(1, 0, input.blocks[0]);
    if (damage === 'reordered') [input.blocks[1], input.blocks[2]] = [input.blocks[2], input.blocks[1]];
    if (damage === 'extra') input.blocks.push(input.blocks.at(-1)!);
    if (damage === 'key') input.encryptionKey = randomBytes(32);
    if (damage === 'pin') input.genesisId = `sha256:${'0'.repeat(64)}`;
    if (damage === 'signature' && input.blocks[1].kind !== 'continuation') input.blocks[1].signature = randomBytes(64).toString('base64url');
    const signal = damage === 'cancelled' ? AbortSignal.abort() : undefined;
    await expect(replayPolicyObserverHistory({ ...input, signal,
      ...(damage === 'blocks' ? { maxBlocks: 2 } : {}), ...(damage === 'bytes' ? { maxBytes: 100 } : {}) })).rejects.toThrow();
  }
  expect(n.key).toEqual(originalKey);
  const controller = new AbortController(); let returned = false;
  function* source() { try { yield selected.blocks[0]; controller.abort(); yield selected.blocks[1]; } finally { returned = true; } }
  await expect(replayPolicyObserverHistory({ ...selected.replayOptions, blocks: source(), signal: controller.signal })).rejects.toThrow('cancelled');
  expect(returned).toBe(true);
}, 30000);

it('binds restore review to the original genesis, certified root, exact destination and authentic in-process capability', async () => {
  const n = await fixture(); await n.observer.advance(n.advance); const selected = await n.recover();
  const preparation = await preparePolicyObserverRestore(selected.restoreOptions), approvedDigest = preparation.review.approvalDigest;
  for (const restore of [undefined, { preparation, approvedDigest: 'wrong' }, { preparation: structuredClone(preparation), approvedDigest }]) {
    await expect(openProtectedPolicyObserver({ ...selected.openOptions, mode: 'create-new', restore })).rejects.toThrow(/reviewed|review/);
    expect(existsSync(selected.openOptions.directory)).toBe(false);
  }
  await expect(openProtectedPolicyObserver({ ...selected.openOptions, directory: `${selected.openOptions.directory}-other`, mode: 'create-new',
    restore: { preparation, approvedDigest } })).rejects.toThrow('reviewed');
  await expect(openProtectedPolicyObserver({ ...selected.openOptions, genesis: undefined, mode: 'create-new',
    restore: { preparation, approvedDigest } })).rejects.toThrow('genesis');
  await expect(openProtectedPolicyObserver({ ...selected.openOptions, mode: 'open-existing' })).rejects.toThrow('missing');
  const observer = await openProtectedPolicyObserver({ ...selected.openOptions, mode: 'create-new', restore: { preparation, approvedDigest } }); cleanup.push(observer.close);
  await expect(preparePolicyObserverRestore(selected.restoreOptions)).rejects.toThrow('empty destination');
  await observer.ready(); expect(observer.policy()).toEqual(n.second);
}, 30000);

it('rejects semantic evidence deletion even if the attacker owns the history signing key and obtains a continuation certificate', async () => {
  const n = await fixture(); await n.observer.advance(n.advance); await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated'); n.observer.close();
  const writer = createRetainedHistoryCheckpointWriter({ directory: n.options.directory, localKey: n.key, context: n.enrolled.context,
    rootId: historyCheckpointEnvelopeId(n.enrolled.root), generation: 0, signingKey: n.owner, members: n.members, transport: n.transport }); cleanup.push(writer.close);
  const previous = writer.read().committed!.envelope, encoded = openHistoryCheckpoint(previous, n.enrolled.context, n.key);
  const state = JSON.parse(encoded.toString()); encoded.fill(0); state.conflict = null;
  const altered = sealHistoryCheckpoint({ context: n.enrolled.context, encryptionKey: n.key, signingKey: n.owner,
    header: { kind: 'checkpoint', generation: 0, sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous) }, plaintext: Buffer.from(JSON.stringify(state)) });
  await writer.replicate(altered); writer.close();
  const selected = await n.recover();
  await expect(preparePolicyObserverRestore(selected.restoreOptions)).rejects.toThrow('continued after equivocation');
  expect(existsSync(selected.openOptions.directory)).toBe(false);
}, 30000);

it('does not recreate a missing writer from the restored baseline when retained archive evidence exists', async () => {
  const n = await fixture(); await n.observer.advance(n.advance); const selected = await n.recover();
  const { observer } = await restore(selected); await observer.ready(); await observer.advance(n.later); observer.close();
  const path = join(selected.openOptions.directory, 'history-writer.json'); rmSync(path);
  await expect(openProtectedPolicyObserver({ ...selected.openOptions, mode: 'open-existing', initializeWriter: true })).rejects.toThrow('retained archive evidence');
  expect(existsSync(path)).toBe(false);
}, 30000);
