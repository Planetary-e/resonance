import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryGenerationReplica, openHistoryGenerationProvisioner } from '../history-generation-provisioner.js';
import { createHistoryProvisionCoordinator } from '../history-provision-coordinator.js';
import { exchangeHistoryProvision, listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() { const n = historyProvisionFixture(); cleanup.push(() => n.close()); return n; }

it.each(['intent', 'directory', 'empty-manifest', 'root-block', 'root-manifest', 'before-publication', 'after-publication', 'ready-marker', 'durable'])(
  'resumes unpublished creation after SIGKILL at %s without resetting any retained directory', async boundary => {
    const n = fixture(), original = n.stores[0].read();
    openHistoryGenerationProvisioner({ ...n.provisionOptions(), initialize: true }).close(); n.roles[0].close(); n.stores[0].close();
    const child = fork(new URL('./fixtures/history-provision-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Provision process exited before ready'); })]))[0]).toBe('ready');
    child.send({ options: { ...n.options, directory: join(n.directory, 'r0') }, directory: n.provisionOptions().directory,
      localKey: n.localKey.toString('hex'), request: n.request(), boundary,
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(child.signalCode).toBe('SIGKILL'); n.reopen(0);
    const role = openHistoryGenerationProvisioner(n.provisionOptions()); cleanup.push(() => role.close());
    expect(role.read().phase).toBe(['ready-marker', 'durable'].includes(boundary) ? 'ready' : 'creating');
    role.provision(n.request()); expect(role.child()!.read().envelopes).toEqual([n.continuation]);
    const delta = n.next(n.continuation); role.child()!.append(delta); role.provision(n.request());
    expect(role.child()!.read().envelopes).toEqual([n.continuation, delta]); expect(n.stores[0].read()).toEqual(original);
  }, 30_000);

it('provisions five real sockets, survives lost replies/owner restart, then requires four root writes before deltas', async () => {
  const n = fixture();
  const roles = n.stores.map((_, i) => {
    const role = createHistoryGenerationReplica({ ...n.provisionOptions(i), initialize: true, now: Date.now });
    cleanup.push(() => role.close()); return role;
  });
  const listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
  for (const role of roles) { const listener = await listenHistoryAgreementReplica(role); cleanup.push(() => listener.close()); listeners.push(listener); }
  const members = n.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].endpoint }));
  let lose = true, sent = 0;
  const options = { directory: join(n.directory, 'provision-owner'), localKey: n.localKey, context: n.context, signingKey: n.owner,
    root: n.continuation, members, transport: async (...args: Parameters<typeof exchangeHistoryProvision>) => {
      sent++; const response = await exchangeHistoryProvision(...args);
      if (lose && n.context.members.indexOf(args[0].publicKey) >= 3) throw new Error('lost reply after durable creation');
      return response;
    } };
  let owner = createHistoryProvisionCoordinator({ ...options, initialize: true }); cleanup.push(() => owner.close());
  await expect(owner.run()).rejects.toThrow('Four authenticated');
  expect(roles.every(r => r.read().phase === 'ready')).toBe(true);
  const previous = owner.read().requests; owner.close(); const before = sent;
  owner = createHistoryProvisionCoordinator(options); cleanup.push(() => owner.close());
  expect(owner.read().requests).toEqual(previous); expect(sent).toBe(before);
  lose = false; expect(await owner.run()).toHaveLength(4);
  expect(owner.read().requests[0].challenge).not.toBe(previous[0].challenge);
  const writer = createHistoryCheckpointWriter({ directory: join(n.directory, 'child-writer'), localKey: n.localKey,
    context: n.context, signingKey: n.owner, rootId: historyContinuationRootId(n.continuation), generation: 1,
    members: members.map((m, i) => ({ ...m, endpoint: listeners[i].checkpointEndpoint })), initialize: true, continuation: n.continuation });
  cleanup.push(() => writer.close());
  const delta = n.next(n.continuation);
  await expect(writer.replicate(delta)).rejects.toThrow('gap');
  expect((await writer.replicate(n.continuation)).receipts).toHaveLength(4);
  const written = await writer.replicate(delta); expect(written.receipts).toHaveLength(4);
  // The same service still serves the predecessor with its old pins; provisioning is not replacement.
  const fresh = n.request(0, Date.now());
  const request = createHistoryExchangeRequest({ action: 'read', rootId: n.options.rootId, generation: 0, replica: n.context.members[0],
    challenge: fresh.challenge, issuedAt: fresh.issuedAt, expiresAt: fresh.expiresAt, sequence: 0, envelopeId: null }, n.context, n.owner);
  const response = await exchangeHistoryCheckpoint({ publicKey: n.context.members[0], endpoint: listeners[0].checkpointEndpoint }, { request, envelope: null }, new AbortController().signal);
  expect(parseHistoryExchangeResponse(response, request, n.context).envelope).toEqual(n.root);
  // Restart a complete service and prove another fresh provisioning attempt preserves accepted deltas.
  const retained = n.context.members.indexOf(written.receipts[0].request.replica);
  await listeners[retained].close(); roles[retained].close();
  const restarted = createHistoryGenerationReplica({ ...n.provisionOptions(retained), now: Date.now }); cleanup.push(() => restarted.close());
  const listener = await listenHistoryAgreementReplica(restarted); cleanup.push(() => listener.close());
  const retry = n.request(retained, Date.now());
  await expect(exchangeHistoryProvision({ publicKey: n.context.members[retained], endpoint: listener.endpoint }, retry, new AbortController().signal)).resolves.toBeTruthy();
  const read = createHistoryExchangeRequest({ ...request, replica: n.context.members[retained], rootId: historyContinuationRootId(n.continuation), generation: 1,
    sequence: 1, issuedAt: retry.issuedAt, expiresAt: retry.expiresAt, challenge: retry.challenge }, n.context, n.owner);
  const received = await exchangeHistoryCheckpoint({ publicKey: n.context.members[retained], endpoint: listener.checkpointEndpoint }, { request: read, envelope: null }, new AbortController().signal);
  expect(parseHistoryExchangeResponse(received, read, n.context).envelope).toEqual(delta);
}, 60_000);
