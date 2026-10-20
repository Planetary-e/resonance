// Real child process: NODE_EXTRA_CA_CERTS is read at Node startup. No TLS bypass.
import { once } from 'node:events';
import { createServer } from 'node:https';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';
import { createRelayClient } from '@resonance/node';
import { createRelayContactHintV1, createRelayDescriptorV1, createPublicationRecord,
  generatePublicationKeyMaterial, generateIdentity, generateSigningKeyPair } from '@resonance/core';
import { createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createHistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import { historyDigest } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal } from '@resonance/core/history-compaction';
import { createHistoryFrontierRequest } from '@resonance/core/history-frontier';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { discoverRelayContactV1 as relayDiscovery } from '../../relay-discovery-client.ts';
import { discoverRelayContactV1 as nodeDiscovery } from '../../../../node/src/relay-discovery-client.ts';
import { connectRelayLinkV1 } from '../../relay-link-client.ts';
import { requestAdmissionWitnessVote } from '../../admission-witness-transport.ts';
import { exchangeHistoryCheckpoint } from '../../history-checkpoint-exchange.ts';
import { exchangeHistoryAgreement, exchangeHistoryAgreementData, exchangeHistoryProvision,
  exchangeHistoryCompaction, exchangeHistoryFrontier } from '../../history-agreement-exchange.ts';
import { historyProvisionFixture } from './history-provision-fixture.ts';
import { createRelayServer } from '../../server.ts';
import { exchangeAdmissionPolicyObservation } from '../../admission-policy-observation-transport.ts';

const read = name => readFileSync(new URL(`./tls/${name}`, import.meta.url));
const credentials = name => name === 'untrusted'
  ? { cert: readFileSync(new URL('./localhost-test.crt', import.meta.url)), key: readFileSync(new URL('./localhost-test.key', import.meta.url)) }
  : { cert: read(`${name}.crt`), key: read(name === 'renewed' ? 'renewed.key' : 'localhost.key') };
const search = { groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(0x4a), itemType: 'need', k: 5, threshold: 0.9 };

async function matrix() {
  const history = historyProvisionFixture(), identity = generateIdentity(), now = Date.now();
  const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
    capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
    supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 }, issuedAt: now, expiresAt: now + 60000 }, identity);
  const authorization = history.frames('prepare', 2, history.a, history.promise(2))[0];
  const data = createHistoryAgreementDataFrame({ action: 'head', authorization, sequence: history.a.sequence,
    envelopeId: history.a.envelopeId, envelope: null }, history.context, history.owner);
  const rows = [];
  try {
    for (const host of ['127.0.0.1', '::1']) for (const name of ['localhost', 'untrusted', 'wrong-host', 'expired', 'future']) {
      const server = createServer(credentials(name));
      const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      server.on('tlsClientError', () => {});
      const wss = new WebSocketServer({ server, perMessageDeflate: false }); let upgrades = 0, frames = 0;
      wss.on('connection', socket => { upgrades++; socket.on('error', () => {}); socket.on('message', () => { frames++; socket.close(); }); });
      server.listen(0, host); await once(server, 'listening');
      const endpoint = `wss://${host === '::1' ? '[::1]' : host}:${server.address().port}/`, member = { publicKey: history.context.members[0], endpoint: endpoint + 'history-agreement' };
      const signal = AbortSignal.timeout(3000);
      const issuedAt = Date.now(), shared = { rootId: history.options.rootId, generation: 0, replica: member.publicKey,
        challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 };
      const witnessKey = generateSigningKeyPair();
      const witness = createAdmissionWitnessRequest({ setId: historyDigest('set'), issuerKey: historyDigest('issuer'),
        spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${randomBytes(64).toString('base64url')}` }, witnessKey);
      const checkpoint = history.next(history.root, 'image', 'checkpoint');
      const compaction = createHistoryCompactionProposal({ genesisId: history.options.rootId, rootId: history.options.rootId, checkpoint,
        issuedAt, expiresAt: issuedAt + 30000 }, history.context, history.owner);
      const frontier = createHistoryFrontierRequest({ genesisId: history.options.rootId, replica: member.publicKey,
        challenge: shared.challenge, issuedAt, expiresAt: issuedAt + 30000 }, history.context, history.owner);
      const direct = createRelayClient({ relayUrl: endpoint });
      const observers = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', quorum: 4,
        authority: Buffer.from(history.owner.publicKey).toString('base64url'), genesis: { revision: 1, digest: 'a'.repeat(64), transition: 'a'.repeat(64) },
        members: history.context.members.map((publicKey, i) => ({ publicKey, endpoint: `${endpoint}policy-${i}` })) });
      const policyRequest = createAdmissionPolicyHeadRequest(observers);
      const calls = {
        personal: () => direct.searchV2(search),
        'node-discovery': () => nodeDiscovery(createRelayContactHintV1('configured', endpoint)),
        'relay-discovery': () => relayDiscovery(createRelayContactHintV1('configured', endpoint)),
        'relay-link': () => connectRelayLinkV1(createRelayContactHintV1('configured', endpoint), descriptor, identity),
        witness: () => requestAdmissionWitnessVote({ publicKey: Buffer.from(witnessKey.publicKey).toString('base64url'), endpoint }, witness, signal),
        checkpoint: () => exchangeHistoryCheckpoint({ ...member, endpoint }, { request: createHistoryExchangeRequest({ ...shared, action: 'head', sequence: 0, envelopeId: null }, history.context, history.owner), envelope: null }, signal),
        agreement: () => exchangeHistoryAgreement(member, authorization, signal),
        'agreement-data': () => exchangeHistoryAgreementData(member, data, signal),
        provision: () => exchangeHistoryProvision(member, history.request(0, Date.now()), signal),
        compaction: () => exchangeHistoryCompaction(member, compaction, signal),
        frontier: () => exchangeHistoryFrontier(member, frontier, signal),
        'policy-observation': () => exchangeAdmissionPolicyObservation({ ...member, endpoint }, { request: policyRequest, advance: null }, signal),
      };
      try {
        for (const [path, invoke] of Object.entries(calls)) {
          const before = { upgrades, frames }; let error;
          try { await invoke(); } catch (caught) { error = String(caught); }
          rows.push({ host, certificate: name, path, upgrades: upgrades - before.upgrades, frames: frames - before.frames, error: error ?? null });
        }
      } finally {
        direct.disconnect(); for (const socket of wss.clients) socket.terminate(); for (const socket of sockets) socket.destroy();
        await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
      }
    }
    return rows;
  } finally { history.close(); }
}

async function completeRoute() {
  const directory = mkdtempSync(join(tmpdir(), 'tls-route-')), servers = [], clients = [];
  async function start(host, id, certificate = 'localhost') {
    const endpoint = `wss://${host === '::1' ? '[::1]' : host}:0/`;
    const server = createRelayServer({ port: 0, host, persistDir: join(directory, id), tls: credentials(certificate),
      identityPassphrase: 'public test fixture passphrase', privateEntryMix: false, privateReplyMix: false,
      relayDiscovery: { endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
    servers.push(server); await server.start(); return { server, endpoint: endpoint.replace(':0/', `:${server.getListeningPort()}/`) };
  }
  try {
    const entry = await start('127.0.0.1', 'entry'), destination = await start('::1', 'destination');
    const observation = entry.server.observeRelayDescriptor(destination.server.getRelayDescriptor());
    if (observation !== 'accepted') throw new Error(`TLS destination enrollment failed: ${observation}`);
    const makeClient = endpoint => { const client = createRelayClient({ relayUrl: endpoint, privateEntryUrls: [entry.endpoint], privateTraffic: { batchWindowMs: 10, jitterMs: 0 } }); clients.push(client); return client; };
    const client = makeClient(destination.endpoint), keys = generatePublicationKeyMaterial(), createdAt = Date.now();
    const record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: search.fingerprint,
      itemType: 'offer', createdAt, expiresAt: createdAt + 86400000 }, keys);
    const ack = await client.submitPublicationOperation(record), before = await client.searchV2(search);
    const need = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: search.fingerprint,
      itemType: 'need', createdAt, expiresAt: createdAt + 86400000 }, generatePublicationKeyMaterial());
    const matched = await client.submitPublicationOperation(need), mailbox = await client.fetchMailbox(record, keys);
    const relayId = destination.server.getRelayDescriptor().relayId;
    client.disconnect(); await destination.server.stop({ graceful: false });
    const renewed = await start('::1', 'destination', 'renewed'); entry.server.observeRelayDescriptor(renewed.server.getRelayDescriptor());
    const renewedClient = makeClient(renewed.endpoint), after = await renewedClient.searchV2(search);
    const retained = await renewedClient.fetchMailbox(record, keys);
    const acknowledged = await renewedClient.acknowledgeMailbox(record, keys, retained.envelopes.map(envelope => envelope.envelopeId));
    const empty = await renewedClient.fetchMailbox(record, keys);
    return { ack: ack.status, before: before.results.map(value => value.publicationId), after: after.results.map(value => value.publicationId),
      publicationId: record.publicationId, matched: matched.status, notices: mailbox.notices, retainedNotices: retained.notices,
      envelopes: mailbox.envelopes.map(envelope => envelope.envelopeId), retainedEnvelopes: retained.envelopes.map(envelope => envelope.envelopeId),
      acknowledged: acknowledged.status, remaining: empty.envelopes.length, sameRelayIdentity: relayId === renewed.server.getRelayDescriptor().relayId };
  } finally { clients.forEach(client => client.disconnect()); for (const server of servers.reverse()) await server.stop({ graceful: false }); rmSync(directory, { recursive: true, force: true }); }
}

async function proxyRoute(invalidAfterDiscovery) {
  const directory = mkdtempSync(join(tmpdir(), 'tls-proxy-')), sockets = new Set(), servers = [];
  const proxy = createServer(credentials('localhost')); let backendPort, upgrades = 0;
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('tlsClientError', () => {});
  proxy.on('upgrade', (request, front, head) => {
    upgrades++;
    // Change the actual certificate/key after the authenticated destination
    // preflight; the entry's later forward must establish and verify fresh TLS.
    if (upgrades === 1) proxy.setSecureContext(credentials(invalidAfterDiscovery ? 'wrong-host' : 'renewed'));
    const back = connect({ host: '::1', port: backendPort }); sockets.add(back);
    front.on('error', () => back.destroy()); back.on('error', () => front.destroy());
    front.on('close', () => back.destroy()); back.on('close', () => { sockets.delete(back); front.destroy(); });
    const headers = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    back.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) back.write(head); front.pipe(back).pipe(front);
  });
  let client;
  try {
    proxy.listen(0, '::1'); await once(proxy, 'listening');
    const destinationEndpoint = `wss://[::1]:${proxy.address().port}/`;
    const discovery = endpoint => ({ endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } });
    const destination = createRelayServer({ port: 0, host: '::1', persistDir: join(directory, 'destination'),
      identityPassphrase: 'public test fixture passphrase', relayDiscovery: discovery(destinationEndpoint) });
    servers.push(destination); await destination.start(); backendPort = destination.getListeningPort();
    const entry = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(directory, 'entry'), tls: credentials('localhost'),
      identityPassphrase: 'public test fixture passphrase', privateEntryMix: false, privateReplyMix: false,
      relayDiscovery: discovery('wss://127.0.0.1:0/') });
    servers.push(entry); await entry.start(); entry.observeRelayDescriptor(destination.getRelayDescriptor());
    client = createRelayClient({ relayUrl: destinationEndpoint, privateEntryUrls: [`wss://127.0.0.1:${entry.getListeningPort()}/`],
      privateTraffic: { batchWindowMs: 10, jitterMs: 0 } });
    const record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: search.fingerprint,
      itemType: 'offer', createdAt: Date.now(), expiresAt: Date.now() + 86400000 }, generatePublicationKeyMaterial());
    let error, ack;
    try { ack = await client.submitPublicationOperation(record); } catch (caught) { error = String(caught); }
    return { upgrades, error: error ?? null, ack: ack?.status ?? null, stored: destination.getStats().stored_publications };
  } finally {
    client?.disconnect(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve)); for (const server of servers.reverse()) await server.stop({ graceful: false });
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must stay enabled');
  const mode = process.argv[2];
  const result = mode === 'matrix' ? await matrix() : mode.startsWith('proxy') ? await proxyRoute(mode === 'proxy-invalid') : await completeRoute();
  process.send({ result }, () => process.exit(0));
} catch (error) { process.send({ error: String(error), stack: error.stack }, () => process.exit(1)); }
