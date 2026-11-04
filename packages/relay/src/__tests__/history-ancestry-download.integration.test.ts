import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createHistoryFreeze, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest } from '@resonance/core/history-provision';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { createHistoryGenerationReplica } from '../history-generation-provisioner.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryAgreementReplica } from '../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { exchangeHistoryProvision, listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';
import { historyAgreementFixture } from './fixtures/history-agreement-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('routes three retained generations on five sockets and resumes authenticated download across both boundaries', async () => {
  const n = historyProvisionFixture(); cleanup.push(() => n.close());
  const first = n.continuation, firstId = historyContinuationRootId(first), firstDelta = n.next(first);
  const stores = n.stores.map((parent, i) => {
    parent.activateContinuation(first);
    const store = openHistoryCheckpointStore({ ...n.options, replica: n.context.members[i], parent,
      directory: join(n.directory, `generation1-${i}`), generation: 1, rootId: firstId, initialize: first });
    cleanup.push(() => store.close()); store.append(firstDelta); return store;
  });
  const now = Date.now(), challenge = randomBytes(32).toString('base64url'), freeze = createHistoryFreeze(n.context, 1, 2, challenge, n.owner);
  const receipts = stores.map((store, i) => {
    const role = createHistoryCheckpointReplica({ context: n.context, store, signingKey: n.memberKeys[i] });
    try { return role.exchange({ request: createHistoryExchangeRequest({ action: 'freeze', rootId: firstId, generation: 1,
      replica: n.context.members[i], challenge, issuedAt: now, expiresAt: now + 30_000, sequence: 2, envelopeId: null }, n.context, n.owner), envelope: null, freeze }); }
    finally { role.close(); }
  });
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId: firstId, generation: 1, nextGeneration: 2,
    receipts: receipts.slice(0, 4), envelopes: [first, firstDelta] }, n.context, n.owner);
  const agreementRoles = stores.map((store, i) => {
    const role = createHistoryAgreementReplica({ context: n.context, store, signingKey: n.memberKeys[i] }); cleanup.push(() => role.close()); return role;
  });
  const owner = createHistoryAgreementCoordinator({ directory: join(n.directory, 'agreement2'), localKey: n.localKey, context: n.context,
    signingKey: n.owner, rootId: firstId, generation: 1, nextGeneration: 2, initialize: { proposal },
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${34000 + i}/history-agreement` })),
    transport: async (member, frame) => agreementRoles[n.context.members.indexOf(member.publicKey)].exchange(frame) }); cleanup.push(() => owner.close());
  const second = createHistoryContinuationRoot(proposal, await owner.run(), n.context), secondId = historyContinuationRootId(second), secondDelta = n.next(second);
  const roles = stores.map((parent, i) => {
    const options = { ...n.provisionOptions(i), directory: join(n.directory, `slot2-${i}`), parent, now: Date.now, initialize: true };
    expect(() => createHistoryGenerationReplica(options)).toThrow('genesis');
    expect(() => createHistoryGenerationReplica({ ...options, ancestors: [n.stores[(i + 1) % 5]] })).toThrow('enrolment');
    const role = createHistoryGenerationReplica({ ...options, ancestors: [n.stores[i]] }); cleanup.push(() => role.close()); return role;
  });
  const listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
  for (const role of roles) { const listener = await listenHistoryAgreementReplica(role); cleanup.push(() => listener.close()); listeners.push(listener); }
  const members = n.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].checkpointEndpoint }));
  await Promise.all(members.map((member, i) => {
    const issuedAt = Date.now(), request = createHistoryProvisionRequest({ root: second, replica: member.publicKey,
      challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30_000 }, n.context, n.owner);
    return exchangeHistoryProvision({ ...member, endpoint: listeners[i].endpoint }, request, new AbortController().signal);
  }));
  const writer = createHistoryCheckpointWriter({ directory: join(n.directory, 'writer2'), localKey: n.localKey, context: n.context,
    signingKey: n.owner, rootId: secondId, generation: 2, members, initialize: true, continuation: second }); cleanup.push(() => writer.close());
  await writer.replicate(second); await writer.replicate(secondDelta);
  const issuedAt = Date.now(), nextChallenge = randomBytes(32).toString('base64url'), nextFreeze = createHistoryFreeze(n.context, 2, 3, nextChallenge, n.owner);
  const frozen = await Promise.all(members.map(async member => {
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId: secondId, generation: 2, replica: member.publicKey,
      challenge: nextChallenge, issuedAt, expiresAt: issuedAt + 30_000, sequence: 3, envelopeId: null }, n.context, n.owner);
    return parseHistoryExchangeResponse(await exchangeHistoryCheckpoint(member, { request, envelope: null, freeze: nextFreeze }, new AbortController().signal), request, n.context);
  }));
  const selected = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId: secondId, generation: 2, nextGeneration: 3,
    receipts: frozen.slice(0, 4), envelopes: [second, secondDelta] }, n.context, n.owner);
  const requests: number[] = [], options = { directory: join(n.directory, 'ancestry'), localKey: n.localKey, context: n.context,
    signingKey: n.owner, proposal: selected, members, transport: async (...args: Parameters<typeof exchangeHistoryCheckpoint>) => {
      requests.push(args[1].request.generation); return exchangeHistoryCheckpoint(...args);
    } };
  let download = createHistoryAncestryDownload({ ...options, initialize: true }); cleanup.push(() => download.close());
  expect((await download.run({ maxBlocks: 2 })).next?.generation).toBe(1);
  download.close(); requests.length = 0;
  download = createHistoryAncestryDownload(options); cleanup.push(() => download.close()); expect(requests).toEqual([]);
  // A complete ancestry needs one authentic source per block, not fresh votes or another freeze.
  await listeners[0].close(); await listeners[1].close(); await listeners[2].close(); await listeners[3].close();
  expect((await download.run()).complete).toBe(true); expect(requests.every(g => g < 2)).toBe(true);
  expect([...download.blocks()]).toEqual([n.root, first, firstDelta, second, secondDelta]);
  expect(n.stores[4].envelopeIdAt(0)).toBe(historyCheckpointEnvelopeId(n.root));
}, 60_000);

it.each(['before-block', 'after-block', 'before-index', 'after-index', 'durable'])(
  'resumes the owner download after SIGKILL at %s', async boundary => {
    const n = historyAgreementFixture('missing', 2); cleanup.push(() => n.close());
    const members = n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${35000 + i}/history-checkpoint` }));
    const options = { directory: join(n.directory, 'download'), localKey: n.localKey, context: n.context, signingKey: n.owner, proposal: n.a, members };
    createHistoryAncestryDownload({ ...options, initialize: true }).close();
    const child = fork(new URL('./fixtures/history-download-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'); cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Download process exited before ready'); })]))[0]).toBe('ready');
    child.send({ directory: options.directory, context: n.context, proposal: n.a, members, blocks: n.blocks, boundary,
      localKey: n.localKey.toString('hex'), owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') },
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(child.signalCode).toBe('SIGKILL');
    const role = createHistoryCheckpointReplica({ context: n.context, store: n.stores[0], signingKey: n.memberKeys[0] }); cleanup.push(() => role.close());
    const requested: number[] = [];
    const download = createHistoryAncestryDownload({ ...options, transport: async (member, frame) => {
      if (member.publicKey !== members[0].publicKey) throw new Error('offline'); requested.push(frame.request.sequence); return role.exchange(frame);
    } }); cleanup.push(() => download.close());
    expect(download.read().blocks).toBe(['after-index', 'durable'].includes(boundary) ? 1 : 0);
    expect((await download.run()).complete).toBe(true); expect([...download.blocks()]).toEqual(n.blocks);
    expect(requested.includes(2)).toBe(boundary === 'before-block');
  }, 30_000);
