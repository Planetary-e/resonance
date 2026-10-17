import { existsSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHistoryOperatorTransport } from '../history-operator-transport.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createAdmissionRequestBindingV2, createRelayContactHintV1, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryCompactionProposal } from '@resonance/core/history-compaction';
import { createHistoryCompactionControlRequest, historyCompactionCertificateId } from '@resonance/core/history-compaction-control';
import { collectHistoryCompactionCertificate, requestHistoryCompactionControl, retainHistoryCompactionCertificate } from '../history-compaction-coordinator.js';
import { parseHistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { discoverHistoryCompactionFrontier } from '../history-frontier-discovery.js';
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
async function fixture(withBridge = false) {
  const h = historyCheckpointFixture(), f = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'history-reverse-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const policy = await signAdmissionPolicy({ ...f.body, keys: f.body.keys.map(({ witnesses, ...key }) => key) }, f.authority, f.authorityKey.secretKey);
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const controllerDir = join(directory, 'controller'), controllerIdentity = loadOrCreateRelayIdentity(controllerDir);
  const volunteerDirs = context.members.map((_, i) => join(directory, `relay-${i}`));
  const ids = volunteerDirs.map(path => loadOrCreateRelayIdentity(path).did);
  const bridgeDir = join(directory, 'bridge'), bridgeIdentity = loadOrCreateRelayIdentity(bridgeDir);
  const bridgeRouter = withBridge ? new HistoryRelayRouter({ waitForConnection: true,
    bridgeRoutes: ids.map(targetRelayId => ({ controllerRelayId: controllerIdentity.did, targetRelayId })) }) : undefined;
  cleanup.push(() => bridgeRouter?.close());
  const router = new HistoryRelayRouter({ members: context.members.map((publicKey, i) => ({ publicKey, relayId: ids[i], ...(withBridge ? { viaRelayId: bridgeIdentity.did } : {}) })) }); cleanup.push(() => router.close());
  // Deliberately unreachable direct history endpoints: every operation must use a pinned relay link.
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${9 + i}/history-checkpoint` }));
  const options = { directory: join(directory, 'owner'), policy, authority: policy.authority, encryptionKey: h.key,
    protection: { context, signingKey: h.owner, members, transport: router.checkpoint, timeoutMs: withBridge ? 10000 : 2000 } };
  const initial = await openProtectedAdmissionSpendHistory({ ...options, initialize: true, protection: { ...options.protection, initializeWriter: true } });
  const genesis = initial.enrollment().root; initial.close(); if (genesis.kind !== 'checkpoint') throw new Error('Expected genesis');
  const bridge = withBridge ? createRelayServer({ host: '127.0.0.1', port: 0, persistDir: bridgeDir, historyLinks: bridgeRouter,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
      descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } } }) : undefined;
  if (bridge) { await bridge.start(); cleanup.push(() => bridge.stop({ graceful: false })); }
  const controller = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: controllerDir, historyLinks: router,
    relayLinks: bridge ? { targets: [createRelayContactHintV1('configured', bridge.getRelayDescriptor()!.endpoints[0], bridgeIdentity.did)], reconnectBaseMs: 50, reconnectMaxMs: 100 } : undefined,
    relayDiscovery: { endpoints: withBridge ? [] : ['ws://127.0.0.1:0/'], reachability: withBridge ? 'outbound-only' : 'direct', supportedGroups: ['public'],
      descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  await controller.start(); cleanup.push(() => controller.stop({ graceful: false }));
  const hub = bridge ?? controller, hubId = withBridge ? bridgeIdentity.did : controllerIdentity.did;
  const endpoint = hub.getRelayDescriptor()!.endpoints[0], calls = new Map<string, number>();
  const services = context.members.map((_, i) => openHistoryVolunteerService({ directory: join(directory, `history-${i}`), context,
    localKey: h.localKey, signingKey: h.memberKeys[i], genesisId: historyCheckpointEnvelopeId(genesis), initialize: genesis }));
  cleanup.push(() => services.forEach(service => service.close()));
  const routers = services.map(service => new HistoryRelayRouter({ acceptedRelayIds: [hubId], handler(method, value) {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    return method === 'agreement' ? service.exchange(value) : service[method](value);
  } })); cleanup.push(() => routers.forEach(r => r.close()));
  const volunteers: RelayServer[] = [];
  function createVolunteer(i: number) {
    return createRelayServer({ host: '127.0.0.1', port: 0, persistDir: volunteerDirs[i], historyLinks: routers[i],
      relayDiscovery: { endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
        descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
      relayLinks: { targets: [createRelayContactHintV1('configured', endpoint, hubId)],
        reconnectBaseMs: 50, reconnectMaxMs: 100 } });
  }
  cleanup.push(async () => { for (const volunteer of volunteers) await volunteer.stop({ graceful: false }); });
  for (let i = 0; i < 5; i++) { volunteers.push(createVolunteer(i)); await volunteers[i].start(); }
  const connectedVolunteers = () => hub.getRelayLinkStatus().inboundRelayIds.filter(id => ids.includes(id)).length;
  await waitFor(() => connectedVolunteers() === 5 && (!withBridge || controller.getRelayLinkStatus().connectedRelayIds.includes(bridgeIdentity.did)));
  async function row(text: string) {
    const binding = createAdmissionRequestBindingV2('search', { text }), token = await f.token();
    const capability = presentBlindAdmissionTokenV2(token, f.scope, 'search', binding);
    const spend = (await verifyBlindAdmissionTokenV2(capability, f.scope, 'search', binding, f.keys.publicKey))!;
    return { spend, issuerKey: policy.activeKey, action: 'search', binding };
  }
  return { ...h, directory, context, policy, options, genesis, controller, controllerIdentity, endpoint, router, routers,
    services, calls, volunteers, createVolunteer, row, bridge, bridgeRouter, bridgeIdentity, connectedVolunteers };
}

it.each(['direct', 'bridge'] as const)('preserves accepted tokens through partition/reconnect/lost-owner recovery with five outbound-only volunteers through %s links', async topology => {
  const n = await fixture(topology === 'bridge');
  expect(n.volunteers.every(v => v.getRelayDescriptor()!.endpoints.length === 0)).toBe(true);
  expect(n.controller.getRelayLinkStatus().connectedRelayIds).toEqual(topology === 'bridge' ? [n.bridgeIdentity.did] : []);
  if (topology === 'bridge') expect(n.controller.getRelayDescriptor()!.endpoints).toEqual([]);
  let history = await openProtectedAdmissionSpendHistory(n.options); cleanup.push(() => history.close()); await history.ready();
  const first = await n.row('accepted before partition'), second = await n.row('accepted after return');
  // Missing member zero must not monopolize the shared bridge and block four live copies.
  if (topology === 'bridge') { await n.volunteers[0].stop({ graceful: false }); await waitFor(() => n.connectedVolunteers() === 4); }
  await history.write(first);
  const stopped = topology === 'bridge' ? [4] : [3, 4], returned = topology === 'bridge' ? 4 : 3;
  for (const i of stopped) await n.volunteers[i].stop({ graceful: false });
  await waitFor(() => n.connectedVolunteers() === 3);
  await expect(history.write(second)).rejects.toThrow('Four'); expect(() => history.get(second.spend)).toThrow('durable completion');
  expect(history.read().pending).not.toBeNull(); history.close();
  n.volunteers[returned] = n.createVolunteer(returned); await n.volunteers[returned].start();
  await waitFor(() => n.connectedVolunteers() === 4);
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
  await waitFor(() => n.router.usage().operations === 0 && n.routers.every(r => r.usage().operations === 0) && (!n.bridgeRouter || n.bridgeRouter.usage().operations === 0));
  expect(n.router.usage().bytes).toBe(0);
}, 60000);

it.each(['direct', 'bridge'] as const)('certifies a complete state checkpoint over %s outbound relay links without changing retained state', async topology => {
  const n = await fixture(topology === 'bridge');
  const history = await openProtectedAdmissionSpendHistory(n.options); cleanup.push(history.close); await history.ready();
  const row = await n.row('before a certified checkpoint'); await history.write(row);
  await history.checkpoint(history.planCheckpoint().approvalDigest);
  const state = history.read(), head = n.services[0].describe().latest, genesisId = historyCheckpointEnvelopeId(n.genesis), issuedAt = Date.now();
  const request = createHistoryExchangeRequest({ action: 'read', rootId: genesisId, generation: 0, sequence: head.sequence,
    envelopeId: null, replica: n.context.members[0], challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const response = parseHistoryExchangeResponse(n.services[0].checkpoint({ request, envelope: null }), request, n.context);
  const checkpoint = response.envelope!;
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const reviews = n.services.map(s => s.reviewDigest());
  const certificate = await collectHistoryCompactionCertificate({ context: n.context, genesisId, proposal, checkpoint,
    members: n.options.protection.members, transport: n.router.compaction, timeoutMs: 10000 });
  expect(certificate.votes).toHaveLength(4); expect(n.calls.get('compaction')).toBeGreaterThanOrEqual(4);
  expect(n.services.map(s => s.reviewDigest())).toEqual(reviews); expect(history.read()).toEqual(state); expect(history.get(row.spend)).toEqual(row);
  const retainedHeads = n.services.map(s => s.describe().latest);
  for (const member of n.options.protection.members.filter(m => certificate.votes.some(v => v.replica === m.publicKey))) {
    for (const action of ['retain', 'read'] as const) {
      const time = Date.now(), request = createHistoryCompactionControlRequest({ action, genesisId, rootId: genesisId, generation: 0,
        replica: member.publicKey, certificateId: action === 'retain' ? historyCompactionCertificateId(certificate, n.context, genesisId) : null,
        challenge: randomBytes(32).toString('base64url'), issuedAt: time, expiresAt: time + 30000 }, n.context, n.owner);
      const frame = { request, certificate: action === 'retain' ? certificate : null };
      const response = await requestHistoryCompactionControl({ context: n.context, genesisId, member, frame, transport: n.router.compactionControl });
      expect(response.certificate).toEqual(certificate);
    }
  }
  expect(history.read()).toEqual(state); expect(n.services.map(s => s.describe().latest)).toEqual(retainedHeads);
  const discovered = await discoverHistoryCompactionFrontier({ context: n.context, genesisId, signingKey: n.owner,
    members: n.options.protection.members, transport: n.router.frontier });
  expect(discovered.certificate).toEqual(certificate); expect(discovered.receipts).toHaveLength(4);
  expect(history.read()).toEqual(state); expect(n.services.map(s => s.describe().latest)).toEqual(retainedHeads);
  await waitFor(() => n.router.usage().operations === 0 && n.routers.every(r => r.usage().operations === 0) && (!n.bridgeRouter || n.bridgeRouter.usage().operations === 0));
  expect(n.router.usage().bytes).toBe(0); expect(n.routers.every(r => r.usage().bytes === 0)).toBe(true);
}, 30000);

it('recovers accepted admission spends after actual ancestor deletion and a subsequent lost-owner event over outbound links', async () => {
  const n = await fixture(), genesisId = historyCheckpointEnvelopeId(n.genesis);
  let ownerDirectory = n.options.directory, history = await openProtectedAdmissionSpendHistory(n.options);
  cleanup.push(() => history.close()); await history.ready();
  const accepted: Awaited<ReturnType<typeof n.row>>[] = [];
  async function recover(number: number, compaction?: unknown) {
    history.close(); rmSync(ownerDirectory, { recursive: true, force: true });
    const options = { directory: join(n.directory, `generation-recovery-${number}`), encryptionKey: n.key, genesis: n.genesis,
      protection: n.options.protection, agreementTransport: n.router.agreement, dataTransport: n.router.transfer,
      provisionTransport: n.router.provision, compaction };
    const review = await prepareAdmissionHistoryRecovery(options);
    const recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
    for (let i = 0; i < 12 && !recovery.status().complete; i++) await recovery.advance();
    expect(recovery.status().complete).toBe(true);
    ownerDirectory = join(n.directory, `generation-owner-${number}`);
    const preparation = await recovery.reviewRestore(ownerDirectory, n.policy);
    history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: ownerDirectory, initialize: true,
      protection: { ...n.options.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
    await history.ready(); expect(history.read().root.generation).toBe(number);
    for (const row of accepted) expect(history.get(row.spend)).toEqual(row);
  }
  for (let generation = 0; generation < 3; generation++) {
    const row = await n.row(`accepted in generation ${generation}`); accepted.push(row); await history.write(row);
    if (generation < 2) await recover(generation + 1);
  }
  await history.checkpoint(history.planCheckpoint().approvalDigest);
  const certificate = await history.certifyCheckpoint(history.planCheckpointCertification().approvalDigest, { transport: n.router.compaction });
  const receipts = await retainHistoryCompactionCertificate({ context: n.context, genesisId, certificate,
    signingKey: n.owner, members: n.options.protection.members, transport: n.router.compactionControl });
  const retention = parseHistoryCompactionRetention({ version: 1, kind: 'history-compaction-retention', certificate, receipts }, n.context, genesisId);
  await waitFor(() => n.router.usage().operations === 0 && n.routers.every(r => r.usage().operations === 0));
  let retired = 0;
  for (let i = 0; i < n.services.length; i++) {
    const service = n.services[i];
    if (service.describe().latest.rootId !== certificate.proposal.rootId || !service.retainedCompactionCheckpoint(certificate.proposal.rootId)) continue;
    const plan = service.planGenerationRetirement(retention); service.retireGenerations(retention, plan.approvalDigest); retired++;
    expect(service.describe().generations).toBe(2);
    expect(existsSync(join(n.directory, `history-${i}`, `successors-${genesisId.slice(7)}`))).toBe(false);
  }
  expect(retired).toBeGreaterThanOrEqual(4);
  const tail = await n.row('accepted after physical ancestor retirement'); accepted.push(tail); await history.write(tail);
  // Lose the live owner before discovering the retained checkpoint again. Only
  // the original context, genesis and keys are used to retrieve its proof.
  history.close(); rmSync(ownerDirectory, { recursive: true });
  const discovered = await discoverHistoryCompactionFrontier({ context: n.context, genesisId, signingKey: n.owner,
    members: n.options.protection.members, transport: n.router.frontier });
  expect(discovered.certificate?.proposal).toEqual(certificate.proposal);
  await recover(3, discovered.certificate); expect(accepted).toHaveLength(4);
}, 120000);

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


it('runs the operator CLI recovery through a pinned bridge with no owner listener or direct history endpoints', async () => {
  const n = await fixture(true);
  let history = await openProtectedAdmissionSpendHistory(n.options); cleanup.push(() => history.close()); await history.ready();
  const first = await n.row('accepted before CLI owner loss'); await history.write(first); history.close();
  // The original controller is stopped before its retained infrastructure key is
  // used by recovery. A second running service must not share this identity.
  await n.controller.stop({ graceful: false }); n.router.close();
  await waitFor(() => !n.bridge!.getRelayLinkStatus().inboundRelayIds.includes(n.controllerIdentity.did));
  const identityDirectory = join(n.directory, 'controller'), passphrase = 'operator retained secret';
  loadOrCreateRelayIdentity(identityDirectory, passphrase).secretKey.fill(0);
  const file = (name: string, value: unknown) => { const path = join(n.directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const ownerKey = file('owner-key.json', { publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') });
  const ownerConfig = file('owner-config.json', { version: 1, context: n.context, members: n.options.protection.members, ownerKeyFile: ownerKey });
  const policy = file('policy.json', n.policy), enrollment = file('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis });
  const key = join(n.directory, 'owner-key.hex'); writeFileSync(key, n.key.toString('hex'));
  const secret = join(n.directory, 'passphrase'); writeFileSync(secret, passphrase);
  const links = file('operator-links.json', { version: 2, members: n.context.members.map((publicKey, i) => ({ publicKey, relayId: n.volunteers[i].getRelayDescriptor()!.relayId })),
    bridge: { relayId: n.bridgeIdentity.did, endpoint: n.endpoint } });
  const transportFile = file('operator.json', { version: 1, identityDirectory, identityPassphraseFile: secret,
    expectedRelayId: n.controllerIdentity.did, linksFile: links, contacts: [], deadlineMs: 15000 });
  const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url));
  const command = (...args: string[]) => new Promise<any>((resolve, reject) => execFile(process.execPath, ['--import', 'tsx', script, ...args],
    { timeout: 25000, maxBuffer: 65536, env: { ...process.env, RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE: transportFile } }, (error, stdout, stderr) => {
      if (error || stderr) reject(new Error(`Operator command ${args[0]} failed: ${stderr || error?.message}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    }));
  expect((await command('owner-ready', ownerConfig, policy, key, n.options.directory)).readiness).toBe('confirmed');
  expect((await command('owner-inspect', ownerConfig, enrollment)).observedGeneration).toBe(0);
  rmSync(n.options.directory, { recursive: true });
  const recoveryArgs = [ownerConfig, enrollment, key, join(n.directory, 'operator-recovery')];
  const review = await command('owner-recovery-plan', ...recoveryArgs, '1');
  await command('owner-recovery-start', '--approve', review.approvalDigest, ...recoveryArgs, '1');
  const beforeStatus = [...n.calls.entries()]; renameSync(secret, `${secret}.offline`);
  let status = await command('owner-recovery-status', ...recoveryArgs);
  expect([...n.calls.entries()]).toEqual(beforeStatus); renameSync(`${secret}.offline`, secret);
  for (let i = 0; i < 12 && !status.complete; i++) status = await command('owner-recovery-step', ...recoveryArgs);
  expect(status.complete).toBe(true);
  const destination = join(n.directory, 'cli-restored'), beforeReview = [...n.calls.entries()];
  renameSync(secret, `${secret}.offline`);
  const restore = await command('owner-recovery-review', ...recoveryArgs, policy, destination);
  expect([...n.calls.entries()]).toEqual(beforeReview); renameSync(`${secret}.offline`, secret);
  expect((await command('owner-recovery-restore', '--approve', restore.approvalDigest, ...recoveryArgs, policy, destination)).readiness).toBe('confirmed');
  const transport = createHistoryOperatorTransport(n.options.protection, transportFile); cleanup.push(transport.close);
  history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: destination, protection: transport.protection });
  await history.ready(); expect(history.get(first.spend)).toEqual(first);
  await history.write(await n.row('accepted after CLI recovery'));
  expect([...n.calls.keys()].sort()).toEqual(['agreement', 'checkpoint', 'provision', 'transfer']);
  history.close(); transport.close();
}, 120000);
