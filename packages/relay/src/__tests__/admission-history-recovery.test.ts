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
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { createHistoryGenerationReplica } from '../history-generation-provisioner.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';

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
