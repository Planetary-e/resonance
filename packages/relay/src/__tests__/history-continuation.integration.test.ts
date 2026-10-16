import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createHistoryContinuationRoot, historyContinuationRootId } from '@resonance/core/history-continuation';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from '../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { historyAgreementFixture } from './fixtures/history-agreement-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const n = historyAgreementFixture(); cleanup.push(() => n.close());
  const reports = n.promise(1), frames = n.frames('prepare', 1, n.a, reports);
  const prepared = n.certificate(frames.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  const certificate = n.certificate(n.frames('confirm', 1, n.a, prepared).slice(0, 4).map((f, i) => n.roles[i].exchange(f)), 'confirmed');
  return { ...n, continuation: createHistoryContinuationRoot(n.a, certificate, n.context) };
}

it.each(['before-rename', 'after-rename', 'durable'])('keeps activation safe through SIGKILL at %s, with no delivered acknowledgement', async boundary => {
  const n = fixture(), oldHistory = n.stores[0].read(); n.roles[0].close(); n.stores[0].close();
  const child = fork(new URL('./fixtures/history-agreement-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Activation process exited before ready'); })]))[0]).toBe('ready');
  child.send({ options: { ...n.options, directory: join(n.directory, 'r0') }, localKey: n.localKey.toString('hex'),
    member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') },
    activation: true, frame: n.continuation, boundary });
  await exited; expect(child.signalCode).toBe('SIGKILL'); n.reopen(0);
  expect(n.stores[0].activatedContinuation()).toEqual(boundary === 'before-rename' ? null : n.continuation);
  expect(n.stores[0].read()).toEqual(oldHistory);
  n.stores[0].activateContinuation(n.continuation);
  const next = openHistoryCheckpointStore({ ...n.options, directory: join(n.directory, 'next'), generation: 1,
    rootId: historyContinuationRootId(n.continuation), initialize: n.continuation, parent: n.stores[0] });
  cleanup.push(() => next.close());
  expect(next.read().envelopes).toEqual([n.continuation]);
}, 30_000);

it('writes through two certified generations over real sockets and preserves the entire predecessor chain', async () => {
  const n = fixture(); let root = n.continuation, parents = n.stores.slice(0, 4);
  const generations: Array<ReturnType<typeof openHistoryCheckpointStore>[]> = [];
  const original = parents.map(s => s.read());
  for (const generation of [1, 2]) {
    const rootId = historyContinuationRootId(root), stores = parents.map((parent, i) => {
      parent.activateContinuation(root);
      const store = openHistoryCheckpointStore({ ...n.options, replica: n.context.members[i],
        directory: join(n.directory, `g${generation}-r${i}`), generation, rootId, initialize: root, parent });
      cleanup.push(() => store.close()); return store;
    });
    const roles = stores.map((store, i) => {
      const role = createHistoryCheckpointReplica({ context: n.context, store, signingKey: n.memberKeys[i] });
      cleanup.push(() => role.close()); return role;
    });
    const listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
    for (const role of roles) {
      const listener = await listenHistoryCheckpointReplica(role); cleanup.push(() => listener.close()); listeners.push(listener);
    }
    // Use a real, now-closed socket endpoint for the unavailable fifth member.
    const offline = await listenHistoryCheckpointReplica(roles[0]); await offline.close();
    const members = n.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i]?.endpoint ?? offline.endpoint }));
    const retained: HistoryCheckpointEnvelope[] = [root];
    const options = { directory: join(n.directory, `g${generation}-writer`), localKey: n.localKey, context: n.context,
      signingKey: n.owner, rootId, generation, members, retained: () => retained };
    expect(() => createHistoryCheckpointWriter({ ...options, initialize: true })).toThrow('certified continuation');
    let writer = createHistoryCheckpointWriter({ ...options, initialize: true, continuation: root }); cleanup.push(() => writer.close());
    const delta = n.next(root);
    await expect(writer.replicate(delta)).rejects.toThrow('gap'); // A certificate is not four fresh root-write acknowledgements.
    expect((await writer.replicate(root)).receipts).toHaveLength(4);
    expect((await writer.replicate(delta)).receipts).toHaveLength(4);
    retained.push(delta);
    writer.close(); writer = createHistoryCheckpointWriter(options); cleanup.push(() => writer.close());
    expect(writer.read().continuation).toEqual(root); expect(writer.read().committed!.envelope).toEqual(delta);
    expect(stores.map(s => s.read().envelopes)).toEqual(Array.from({ length: 4 }, () => [root, delta]));
    writer.close();
    // Freeze this generation and agree on its exact history for the following boundary.
    if (generation === 1) {
      const challenge = randomBytes(32).toString('base64url'), issuedAt = Date.now();
      const freeze = createHistoryFreeze(n.context, generation, generation + 1, challenge, n.owner);
      const receipts = roles.map((role, i) => role.exchange({ request: createHistoryExchangeRequest({ action: 'freeze', rootId,
        generation, replica: n.context.members[i], challenge, issuedAt, expiresAt: issuedAt + 30_000,
        sequence: generation + 1, envelopeId: null }, n.context, n.owner), envelope: null, freeze }));
      const envelopes: HistoryCheckpointEnvelope[] = [root, delta];
      const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation,
        nextGeneration: generation + 1, receipts, envelopes }, n.context, n.owner);
      const agreementRoles = stores.map((store, i) => {
        const role = createHistoryAgreementReplica({ context: n.context, store, signingKey: n.memberKeys[i] });
        cleanup.push(() => role.close()); return role;
      });
      const coordinator = createHistoryAgreementCoordinator({ ...options, directory: join(n.directory, 'second-agreement'),
        nextGeneration: generation + 1, initialize: { proposal }, transport: async (member, frame) => {
          const role = agreementRoles[n.context.members.indexOf(member.publicKey)]; if (!role) throw new Error('offline'); return role.exchange(frame);
        } });
      cleanup.push(() => coordinator.close());
      root = createHistoryContinuationRoot(proposal, await coordinator.run(), n.context);
      expect(root.proposal.rootId).toBe(rootId); expect(root.proposal.envelopeId).toBe(historyCheckpointEnvelopeId(delta));
    }
    for (const listener of listeners) await listener.close();
    generations.push(stores);
    parents = stores;
  }
  const secondHistory = generations[1][0].read();
  generations.reverse().forEach(stores => stores.forEach(s => s.close()));
  const reopenedFirst = openHistoryCheckpointStore({ ...n.options, directory: join(n.directory, 'g1-r0'), generation: 1,
    rootId: historyContinuationRootId(n.continuation), parent: n.stores[0] });
  cleanup.push(() => reopenedFirst.close());
  const reopenedSecond = openHistoryCheckpointStore({ ...n.options, directory: join(n.directory, 'g2-r0'), generation: 2,
    rootId: historyContinuationRootId(root), parent: reopenedFirst });
  cleanup.push(() => reopenedSecond.close());
  expect(reopenedSecond.read()).toEqual(secondHistory);
  expect(reopenedFirst.read().envelopes[0]).toEqual(n.continuation);
  expect(n.stores.slice(0, 4).map(s => s.read())).toEqual(original);
}, 60_000);
