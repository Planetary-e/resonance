import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId } from '@resonance/core/history-continuation';
import { parseHistoryAgreementCertificate } from '@resonance/core/history-agreement';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery, ADMISSION_RECOVERY_FILENAME } from '../admission-history-recovery.js';
import { inspectProtectedAdmissionSpendHistory, openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { createHistoryGenerationReplica } from '../history-generation-provisioner.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';
import { openAdmissionRestorationReadiness, openAdmissionInitialReadiness } from '../admission-history-readiness.js';

async function publishedWithoutWriter(sockets = false) {
  const n = await fixture(sockets), recovery = await n.initialize();
  for (let i = 0; i < 8 && !recovery.status().complete; i++) await recovery.advance();
  expect(recovery.status().complete).toBe(true);
  const destination = join(n.directory, 'published-restoration'), preparation = await recovery.reviewRestore(destination, n.policy);
  const history = await openProtectedAdmissionSpendHistory({ directory: destination, encryptionKey: n.key, authority: n.context.authority,
    policy: n.policy, initialize: true, protection: { ...n.options.protection, initializeWriter: true,
      restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  expect(history.read().applied).toBeNull(); history.close();
  // Reproduce the on-disk boundary after image publication but before creating
  // the pristine writer. No accepted writer entry is removed.
  const writer = join(destination, 'admission-history-writer'); rmSync(writer, { recursive: true });
  return { ...n, recovery, destination, writer };
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(sockets = false) {
  const n = await admissionRestoreFixture(); cleanup.push(() => n.close());
  const roles = n.context.members.map((_, i) => createHistoryGenerationReplica({ directory: join(n.directory, `new-slot-${i}`),
    localKey: n.localKey, context: n.context, signingKey: n.memberKeys[i], parent: n.generations[1][i],
    ancestors: [n.generations[0][i]], initialize: true }));
  cleanup.push(() => roles.forEach(r => r.close()));
  if (sockets) for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryAgreementReplica(roles[i]); cleanup.push(() => listener.close());
    n.members[i].endpoint = listener.checkpointEndpoint;
  }
  const errors: string[] = []; let calls = 0, online = 5;
  function role(member: { publicKey: string }) { calls++; const i = n.context.members.indexOf(member.publicKey);
    if (i >= online) throw new Error('offline'); return roles[i]; }
  const options = { directory: join(n.directory, 'workflow'), encryptionKey: n.key, genesis: n.root,
    protection: { context: n.context, signingKey: n.owner, members: n.members,
      transport: async (member: { publicKey: string }, frame: unknown) => role(member).checkpoint(frame) },
    agreementTransport: async (member: { publicKey: string }, frame: unknown) => {
      try { return role(member).exchange(frame); } catch (error) { errors.push(String(error)); throw error; }
    },
    dataTransport: async (member: { publicKey: string }, frame: unknown) => role(member).transfer(frame),
    provisionTransport: async (member: { publicKey: string }, frame: unknown) => role(member).provision(frame),
  };
  async function initialize(view = 1) {
    const review = await prepareAdmissionHistoryRecovery({ ...options, view });
    const recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } });
    cleanup.push(() => recovery.close()); return recovery;
  }
  return { ...n, roles, options, errors, initialize, calls: () => calls, online: (count: number) => { online = count; } };
}

it('resumes every workflow phase without replaying completed phases and preserves all semantic ancestry', async () => {
  const n = await fixture(); let recovery = await n.initialize();
  expect(recovery.status().phase).toBe('freeze');
  let iterations = 0;
  while (!recovery.status().complete && iterations++ < 16) {
    await recovery.advance({ maxBlocks: 1 }).catch(error => { throw new Error(`${error}; member errors: ${n.errors.join('; ')}`); });
    const before = n.calls(), state = recovery.status(); recovery.close();
    recovery = await openAdmissionHistoryRecovery(n.options); cleanup.push(() => recovery.close());
    expect(recovery.status()).toEqual(state); expect(n.calls()).toBe(before);
  }
  expect(recovery.status().complete).toBe(true);
  const destination = join(n.directory, 'recovered'), before = n.calls();
  const preparation = await recovery.reviewRestore(destination, n.policy); expect(n.calls()).toBe(before);
  expect(preparation.review.permanentDenials).toBe(1); expect(preparation.review.spends).toBe(2);
  const history = await openProtectedAdmissionSpendHistory({ directory: destination, encryptionKey: n.key, authority: n.context.authority,
    policy: n.policy, initialize: true, protection: { ...n.options.protection, initializeWriter: true,
      restore: { preparation, approvedDigest: preparation.review.approvalDigest } } }); cleanup.push(() => history.close());
  n.online(3); await expect(history.ready()).rejects.toThrow('Four');
  n.online(4); await history.ready(); expect(history.isRetired(n.oldKey)).toBe(true);
  expect(history.get(n.currentRow.spend)).toEqual(n.currentRow); expect(history.get(n.legacy.spend)).toEqual(n.legacy);
}, 60000);

it('refuses forged or changed freeze approval, wrong payload keys and nonempty destinations before mutation', async () => {
  const n = await fixture(), before = n.generations[1].map(s => s.describe());
  const review = await prepareAdmissionHistoryRecovery(n.options);
  for (const candidate of [review, structuredClone(review)]) {
    await expect(openAdmissionHistoryRecovery({ ...n.options, initialize: { review: candidate,
      approvedDigest: candidate === review ? 'wrong' : review.approvalDigest } })).rejects.toThrow('reviewed');
  }
  expect(existsSync(n.options.directory)).toBe(false);
  await expect(prepareAdmissionHistoryRecovery({ ...n.options, encryptionKey: randomBytes(32) })).rejects.toThrow();
  expect(n.generations[1].map(s => s.describe())).toEqual(before);
  const recovery = await n.initialize(); recovery.close();
  await expect(prepareAdmissionHistoryRecovery(n.options)).rejects.toThrow('empty');
});

it('retains a carried hidden decision instead of downloading its different preferred proposal', async () => {
  const n = await fixture(), recovery = await n.initialize(2); await recovery.advance();
  const slot = { rootId: recovery.status().rootId, generation: 1, nextGeneration: 2 };
  const freeze = createHistoryCheckpointRecovery({ ...slot, directory: join(n.options.directory, 'freeze'), localKey: n.key,
    context: n.context, signingKey: n.owner, members: n.members });
  const proposal = createHistorySuccessorProposal(freeze.read().prepared!, n.context, n.owner); freeze.close();
  const votes: unknown[] = [];
  const old = createHistoryAgreementCoordinator({ ...slot, directory: join(n.directory, 'lost-agreement'), localKey: n.key,
    context: n.context, signingKey: n.owner, members: n.members, initialize: { proposal }, transport: async (member, frame) => {
      const response = n.roles[n.context.members.indexOf(member.publicKey)].exchange(frame);
      if (frame.request.action === 'confirm') { votes.push(response); throw new Error('lost confirmation'); }
      return response;
    } });
  await expect(old.run()).rejects.toThrow('Four'); old.close();
  const certificate = parseHistoryAgreementCertificate({ version: 2, kind: 'history-agreement-certificate', phase: 'confirmed', votes: votes.slice(0, 4) }, n.context, 'confirmed');
  const rootId = historyContinuationRootId(createHistoryContinuationRoot(proposal, certificate, n.context));
  for (let step = 0; step < 8 && !recovery.status().complete; step++) await recovery.advance();
  const preparation = await recovery.reviewRestore(join(n.directory, 'carried-restore'), n.policy);
  expect(preparation.review.rootId).toBe(rootId); expect(preparation.review.spends).toBe(2);
}, 60000);

it.each(['before-intent', 'after-intent', 'before-register', 'after-register', 'before-phase', 'after-phase',
  'after-select', 'after-confirm', 'after-provision'])(
  'retains recovery intent, accepted history and completed work across SIGKILL at %s', async boundary => {
    const n = await fixture(true), recovery = await n.initialize();
    const prefix = boundary === 'after-select' ? 1 : boundary === 'after-confirm' ? 3 : boundary === 'after-provision' ? 4 : 0;
    for (let step = 0; step < prefix; step++) await recovery.advance();
    recovery.close();
    const child = fork(new URL('./fixtures/admission-recovery-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Recovery process exited before ready'); })]))[0]).toBe('ready');
    child.send({ directory: n.options.directory, encryptionKey: n.key.toString('hex'), genesis: n.root, context: n.context,
      members: n.members, owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') }, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    const reopened = await openAdmissionHistoryRecovery(n.options); cleanup.push(() => reopened.close());
    for (let step = 0; step < 8 && !reopened.status().complete; step++) await reopened.advance();
    expect(reopened.status().complete).toBe(true);
    const preparation = await reopened.reviewRestore(join(n.directory, 'after-kill'), n.policy);
    expect(preparation.review.spends).toBe(2); expect(preparation.review.permanentDenials).toBe(1);
    expect(n.generations[0][0].read().envelopes).toEqual(n.replayOptions().blocks);
  }, 60000,
);

it.each(['missing', 'corrupt'])('preserves a %s registered phase journal instead of recreating it or sending requests', async damage => {
  const n = await fixture(), recovery = await n.initialize(); await recovery.advance(); recovery.close();
  const path = join(n.options.directory, 'freeze', 'history-recovery.json');
  if (damage === 'missing') rmSync(path); else writeFileSync(path, 'damaged');
  const before = n.calls(), manifest = readFileSync(join(n.options.directory, ADMISSION_RECOVERY_FILENAME));
  if (damage === 'missing') await expect(openAdmissionHistoryRecovery(n.options)).rejects.toThrow('missing');
  else {
    const reopened = await openAdmissionHistoryRecovery(n.options); cleanup.push(() => reopened.close());
    await expect(reopened.advance()).rejects.toThrow(); expect(readFileSync(path, 'utf8')).toBe('damaged');
  }
  expect(n.calls()).toBe(before); expect(readFileSync(join(n.options.directory, ADMISSION_RECOVERY_FILENAME))).toEqual(manifest);
});

it('keeps an incomplete freeze after three replies and resumes explicitly when a fourth volunteer returns', async () => {
  const n = await fixture(), recovery = await n.initialize(); n.online(3);
  await expect(recovery.advance()).rejects.toThrow('Four'); expect(recovery.status().phase).toBe('freeze');
  expect(n.generations[1].filter(s => s.describe().freeze).length).toBe(3);
  await expect(recovery.reviewRestore(join(n.directory, 'premature'), n.policy)).rejects.toThrow('not completed');
  recovery.close(); n.online(4);
  const reopened = await openAdmissionHistoryRecovery(n.options); cleanup.push(() => reopened.close());
  for (let step = 0; step < 8 && !reopened.status().complete; step++) await reopened.advance();
  expect(reopened.status().complete).toBe(true);
}, 30000);

it('cancels an in-flight workflow without replacing its pending phase or using late responses', async () => {
  const n = await fixture(), initialized = await n.initialize(); initialized.close();
  const controller = new AbortController(); let sends = 0;
  const interrupted = await openAdmissionHistoryRecovery({ ...n.options, protection: { ...n.options.protection,
    transport: async (member, frame) => {
      const response = await n.options.protection.transport(member, frame); sends++; controller.abort(); return response;
    } } }); cleanup.push(() => interrupted.close());
  await expect(interrupted.advance({ signal: controller.signal })).rejects.toThrow();
  const before = sends; await Promise.resolve(); expect(sends).toBe(before);
  const reopened = await openAdmissionHistoryRecovery(n.options); cleanup.push(() => reopened.close());
  expect(reopened.status().phase).toBe('freeze'); await reopened.advance(); expect(reopened.status().phase).toBe('select');
});

it('reviews a published restoration offline, preserves missing pristine setup and requires fresh approval after a failed readiness attempt', async () => {
  const n = await publishedWithoutWriter(), before = n.calls(), path = join(n.destination, 'admission-spends-v2.jsonl'), bytes = readFileSync(path);
  let readiness = await n.recovery.reviewReadiness(n.destination, n.policy); cleanup.push(() => readiness.close());
  const plan = readiness.review();
  expect(plan).toMatchObject({ pending: true, appliedSpends: 2, permanentDenials: 1, initializeWriter: true, initializeArchive: true, readiness: 'unverified' });
  expect(existsSync(n.writer)).toBe(false); expect(n.calls()).toBe(before);
  await expect(readiness.apply('wrong')).rejects.toThrow('approval'); expect(existsSync(n.writer)).toBe(false); expect(n.calls()).toBe(before);
  n.online(3); await expect(readiness.apply(plan.approvalDigest)).rejects.toThrow('Four'); readiness.close();
  expect(readFileSync(path)).toEqual(bytes); expect(existsSync(n.writer)).toBe(true);
  readiness = await n.recovery.reviewReadiness(n.destination, n.policy);
  expect(readiness.review().approvalDigest).not.toBe(plan.approvalDigest);
  const retried = n.calls(); await expect(readiness.apply(plan.approvalDigest)).rejects.toThrow('approval'); expect(n.calls()).toBe(retried);
  n.online(4); n.recovery.close(); // The review owns its key copies after its parent closes.
  expect(await readiness.apply(readiness.review().approvalDigest)).toMatchObject({ result: 'history-ready', readiness: 'confirmed', startsService: false }); readiness.close();
  const inspected = await inspectProtectedAdmissionSpendHistory({ directory: n.destination, encryptionKey: n.key, authority: n.context.authority,
    policy: n.policy, protection: n.options.protection });
  try { const state = inspected.read(); expect(state.pending).toBeNull(); expect(state.image.state.spends).toHaveLength(2); expect(state.image.state.retiredIssuerKeys).toContain(n.oldKey); }
  finally { inspected.close(); }
}, 60000);

it('refuses a changed retained image before writer creation and never lets inspection initialize missing state', async () => {
  const n = await publishedWithoutWriter(), before = n.calls(), path = join(n.destination, 'admission-spends-v2.jsonl'), bytes = readFileSync(path);
  const options = { directory: n.destination, encryptionKey: n.key, authority: n.context.authority, policy: n.policy, protection: n.options.protection };
  await expect(inspectProtectedAdmissionSpendHistory({ ...options, protection: { ...options.protection, initializeWriter: true } })).rejects.toThrow('cannot initialize');
  await expect(openProtectedAdmissionSpendHistory({ ...options, expectedStateDigest: 'sha256:' + '0'.repeat(64),
    protection: { ...options.protection, initializeWriter: true } })).rejects.toThrow('changed after review');
  const missing = join(n.directory, 'not-created');
  await expect(openProtectedAdmissionSpendHistory({ ...options, directory: missing, initialize: true,
    expectedStateDigest: 'sha256:' + '0'.repeat(64) })).rejects.toThrow('only opens existing');
  await expect(inspectProtectedAdmissionSpendHistory({ ...options, directory: missing })).rejects.toThrow();
  expect(existsSync(missing)).toBe(false);
  const verified = await n.recovery.reviewReadiness(n.destination, n.policy), review = verified.review(); verified.close();
  await expect(openAdmissionInitialReadiness({ ...options, genesisId: review.genesisId })).rejects.toThrow('differs from');
  for (const field of ['rootId', 'genesisId', 'replayDigest'] as const) {
    const expected = { rootId: review.rootId, genesisId: review.genesisId, replayDigest: review.replayDigest, [field]: 'sha256:' + 'f'.repeat(64) };
    await expect(openAdmissionRestorationReadiness({ ...options, protection: n.options.protection, expected })).rejects.toThrow('differs from');
  }
  await expect(n.recovery.reviewReadiness(join(n.directory, 'missing'), n.policy)).rejects.toThrow();
  await expect(n.recovery.reviewReadiness(n.destination, n.policy, AbortSignal.abort())).rejects.toThrow();
  expect(existsSync(n.writer)).toBe(false); expect(readFileSync(path)).toEqual(bytes); expect(n.calls()).toBe(before);
}, 60000);

it.each(['writer', 'archive'])('never recreates missing committed %s history during readiness resumption', async missing => {
  const n = await publishedWithoutWriter(), ready = await n.recovery.reviewReadiness(n.destination, n.policy);
  await ready.apply(ready.review().approvalDigest); ready.close();
  const path = missing === 'writer' ? n.writer : join(n.writer, 'payloads'); rmSync(path, { recursive: true });
  const image = readFileSync(join(n.destination, 'admission-spends-v2.jsonl')), before = n.calls();
  await expect(n.recovery.reviewReadiness(n.destination, n.policy)).rejects.toThrow('Committed');
  expect(existsSync(path)).toBe(false); expect(n.calls()).toBe(before);
  expect(readFileSync(join(n.destination, 'admission-spends-v2.jsonl'))).toEqual(image);
}, 60000);

it.each(['before-writer', 'after-writer', 'before-archive', 'after-archive', 'before-apply', 'after-apply'])(
  'retains accepted spends and denials after readiness SIGKILL at %s', async boundary => {
    const n = await publishedWithoutWriter(true), readiness = await n.recovery.reviewReadiness(n.destination, n.policy);
    const plan = readiness.review(); readiness.close();
    const child = fork(new URL('./fixtures/admission-readiness-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit'); let errors = ''; child.stderr?.on('data', value => { errors += value.toString(); });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await once(child, 'message'))[0]).toBe('ready'); child.on('message', value => { if (typeof value === 'object') errors += JSON.stringify(value); });
    child.send({ options: { directory: n.destination, policy: n.policy, expected: { rootId: plan.rootId, genesisId: plan.genesisId, replayDigest: plan.replayDigest },
      protection: { context: n.context, members: n.members, timeoutMs: 1500 } }, key: n.key.toString('hex'),
      owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') }, boundary });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15000);
    try { expect((await exited)[1], errors).toBe('SIGKILL'); } finally { clearTimeout(timeout); }
    expect(errors).toBe('');
    const resumed = await n.recovery.reviewReadiness(n.destination, n.policy);
    try { expect(resumed.review()).toMatchObject({ appliedSpends: 2, permanentDenials: 1 }); await resumed.apply(resumed.review().approvalDigest); }
    finally { resumed.close(); }
  }, 60000);
