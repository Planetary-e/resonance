import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createAdmissionRequestBindingV2, createRelayContactHintV1, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { HISTORY_LINK_FRAME_TYPE } from '../history-relay-link.js';
import { createRelayServer, type RelayServer } from '../server.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from '../admission-history-recovery.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() > deadline) throw new Error('History reverse links did not settle'); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture() {
  const h = historyCheckpointFixture(), f = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'history-reverse-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const policy = await signAdmissionPolicy({ ...f.body, keys: f.body.keys.map(({ witnesses, ...key }) => key) }, f.authority, f.authorityKey.secretKey);
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const controllerDir = join(directory, 'controller'), controllerIdentity = loadOrCreateRelayIdentity(controllerDir);
  const volunteerDirs = context.members.map((_, i) => join(directory, `relay-${i}`));
  const ids = volunteerDirs.map(path => loadOrCreateRelayIdentity(path).did);
  const router = new HistoryRelayRouter({ members: context.members.map((publicKey, i) => ({ publicKey, relayId: ids[i] })) }); cleanup.push(() => router.close());
  // Deliberately unreachable direct history endpoints: every operation must use a pinned relay link.
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${9 + i}/history-checkpoint` }));
  const options = { directory: join(directory, 'owner'), policy, authority: policy.authority, encryptionKey: h.key,
    protection: { context, signingKey: h.owner, members, transport: router.checkpoint, timeoutMs: 2000 } };
  const initial = await openProtectedAdmissionSpendHistory({ ...options, initialize: true, protection: { ...options.protection, initializeWriter: true } });
  const genesis = initial.enrollment().root; initial.close(); if (genesis.kind !== 'checkpoint') throw new Error('Expected genesis');
  const controller = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: controllerDir, historyLinks: router,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
      descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  await controller.start(); cleanup.push(() => controller.stop({ graceful: false }));
  const endpoint = controller.getRelayDescriptor()!.endpoints[0], calls = new Map<string, number>();
  const services = context.members.map((_, i) => openHistoryVolunteerService({ directory: join(directory, `history-${i}`), context,
    localKey: h.localKey, signingKey: h.memberKeys[i], genesisId: historyCheckpointEnvelopeId(genesis), initialize: genesis }));
  cleanup.push(() => services.forEach(service => service.close()));
  const routers = services.map(service => new HistoryRelayRouter({ acceptedRelayIds: [controllerIdentity.did], handler(method, value) {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    return method === 'agreement' ? service.exchange(value) : service[method](value);
  } })); cleanup.push(() => routers.forEach(r => r.close()));
  const volunteers: RelayServer[] = [];
  function createVolunteer(i: number) {
    return createRelayServer({ host: '127.0.0.1', port: 0, persistDir: volunteerDirs[i], historyLinks: routers[i],
      relayDiscovery: { endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
        descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
      relayLinks: { targets: [createRelayContactHintV1('configured', endpoint, controllerIdentity.did)],
        reconnectBaseMs: 50, reconnectMaxMs: 100 } });
  }
  cleanup.push(async () => { for (const volunteer of volunteers) await volunteer.stop({ graceful: false }); });
  for (let i = 0; i < 5; i++) { volunteers.push(createVolunteer(i)); await volunteers[i].start(); }
  await waitFor(() => controller.getRelayLinkStatus().inboundRelayIds.length === 5);
  async function row(text: string) {
    const binding = createAdmissionRequestBindingV2('search', { text }), token = await f.token();
    const capability = presentBlindAdmissionTokenV2(token, f.scope, 'search', binding);
    const spend = (await verifyBlindAdmissionTokenV2(capability, f.scope, 'search', binding, f.keys.publicKey))!;
    return { spend, issuerKey: policy.activeKey, action: 'search', binding };
  }
  return { ...h, directory, context, policy, options, genesis, controller, controllerIdentity, endpoint, router, routers,
    services, calls, volunteers, createVolunteer, row };
}

it('preserves accepted tokens through a partition, reconnect and lost-owner recovery using five outbound-only volunteers', async () => {
  const n = await fixture();
  expect(n.volunteers.every(v => v.getRelayDescriptor()!.endpoints.length === 0)).toBe(true);
  expect(n.controller.getRelayLinkStatus().connectedRelayIds).toEqual([]);
  let history = await openProtectedAdmissionSpendHistory(n.options); cleanup.push(() => history.close()); await history.ready();
  const first = await n.row('accepted before partition'), second = await n.row('accepted after return'); await history.write(first);
  for (const i of [3, 4]) await n.volunteers[i].stop({ graceful: false });
  await waitFor(() => n.controller.getRelayLinkStatus().inboundRelayIds.length === 3);
  await expect(history.write(second)).rejects.toThrow('Four'); expect(() => history.get(second.spend)).toThrow('durable completion');
  expect(history.read().pending).not.toBeNull(); history.close();
  n.volunteers[3] = n.createVolunteer(3); await n.volunteers[3].start();
  await waitFor(() => n.controller.getRelayLinkStatus().inboundRelayIds.length === 4);
  history = await openProtectedAdmissionSpendHistory(n.options); await history.ready(); expect(history.get(second.spend)).toEqual(second);
  history.close(); rmSync(n.options.directory, { recursive: true });
  const recoveryOptions = { directory: join(n.directory, 'recovery'), encryptionKey: n.key, genesis: n.genesis,
    protection: n.options.protection, agreementTransport: n.router.agreement, dataTransport: n.router.transfer, provisionTransport: n.router.provision };
  const review = await prepareAdmissionHistoryRecovery(recoveryOptions);
  const recovery = await openAdmissionHistoryRecovery({ ...recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(() => recovery.close());
  for (let i = 0; i < 12 && !recovery.status().complete; i++) await recovery.advance({ maxBlocks: 1 });
  expect(recovery.status().complete).toBe(true);
  const destination = join(n.directory, 'restored'), preparation = await recovery.reviewRestore(destination, n.policy);
  history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: destination, initialize: true,
    protection: { ...n.options.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  await history.ready(); expect(history.get(first.spend)).toEqual(first); expect(history.get(second.spend)).toEqual(second);
  await history.write(await n.row('accepted on restored history'));
  expect([...n.calls.keys()].sort()).toEqual(['agreement', 'checkpoint', 'provision', 'transfer']);
  await waitFor(() => n.router.usage().operations === 0 && n.routers.every(r => r.usage().operations === 0));
  expect(n.router.usage().bytes).toBe(0);
}, 60000);

it('refuses unauthenticated history frames and an authenticated relay absent from the explicit pins', async () => {
  const n = await fixture(), before = n.services.map(s => s.describe());
  const socket = new WebSocket(n.endpoint); socket.on('error', () => {}); cleanup.push(() => socket.terminate());
  await once(socket, 'open'); const closed = once(socket, 'close');
  socket.send(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, kind: 'open', side: 'request', id: 'a'.repeat(32),
    method: 'checkpoint', bytes: 2, maxResponse: 4096 })); await closed;
  const outsiderDir = join(n.directory, 'outsider'), outsiderId = loadOrCreateRelayIdentity(outsiderDir).did;
  const outsiderRouter = new HistoryRelayRouter({ members: [{ publicKey: n.context.members[0], relayId: n.controllerIdentity.did }] }); cleanup.push(() => outsiderRouter.close());
  const outsider = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: outsiderDir, historyLinks: outsiderRouter,
    relayDiscovery: { endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
    relayLinks: { targets: [createRelayContactHintV1('configured', n.endpoint, n.controllerIdentity.did)] } });
  cleanup.push(() => outsider.stop({ graceful: false })); await outsider.start();
  await waitFor(() => n.controller.getRelayLinkStatus().inboundRelayIds.includes(outsiderId)
    && outsider.getRelayLinkStatus().connectedRelayIds.includes(n.controllerIdentity.did));
  const issuedAt = Date.now();
  const request = createHistoryExchangeRequest({ action: 'head', rootId: historyCheckpointEnvelopeId(n.genesis), generation: 0,
    sequence: 0, envelopeId: null, replica: n.context.members[0], challenge: randomBytes(32).toString('base64url'),
    issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  await expect(outsiderRouter.checkpoint(n.options.protection.members[0], { request, envelope: null }, new AbortController().signal)).rejects.toThrow('closed');
  expect(n.services.map(s => s.describe())).toEqual(before); expect(n.calls.size).toBe(0);
}, 30000);
