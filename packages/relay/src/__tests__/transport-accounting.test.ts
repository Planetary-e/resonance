import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Socket, AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayContactHintV1, createRelayDescriptorV1, createPrivateRequestV1, generateRelayTransportKeyV1,
  serializePrivateRequestLayerV1, generateIdentity, generateSigningKeyPair } from '@resonance/core';
import { createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createHistoryAgreementRequest } from '@resonance/core/history-agreement';
import { historyDigest } from '@resonance/core/history-checkpoint';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';
import { connectRelayLinkV1 } from '../relay-link-client.js';
import { requestAdmissionWitnessVote } from '../admission-witness-transport.js';
import { exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { exchangeHistoryAgreement } from '../history-agreement-exchange.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { createRelayServer } from '../server.js';
import { RelayTrafficMeter } from '../relay-resource-meter.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function peer() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: true });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const messages: string[] = [], extensions: Array<string | undefined> = [];
  const closed = new Promise<void>(resolve => server.once('connection', (socket, request) => {
    extensions.push(request.headers['sec-websocket-extensions']);
    socket.on('error', () => {}); socket.on('message', data => messages.push(data.toString())); socket.once('close', () => resolve());
  }));
  await once(server, 'listening');
  return { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, messages, extensions, closed };
}

function witness(endpoint: string, signal: AbortSignal, onSocket: (socket: Socket) => void) {
  const key = generateSigningKeyPair();
  const request = createAdmissionWitnessRequest({ setId: historyDigest('set'), issuerKey: historyDigest('issuer'),
    spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${randomBytes(64).toString('base64url')}` }, key);
  return requestAdmissionWitnessVote({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint }, request, signal, onSocket);
}

for (const fault of ['exception', 'elapsed'] as const) it.each(['discovery', 'link', 'witness', 'checkpoint', 'agreement'] as const)(
  `contains ${fault} in a %s accounting callback, closes the real socket and sends no application request`, async kind => {
    const p = await peer(), hint = createRelayContactHintV1('configured', p.endpoint);
    let calls = 0;
    const onSocket = () => {
      calls++;
      if (fault === 'exception') throw new Error('Private accounting failure details');
      // Keep actual sockets/event delivery; move only the elapsed-time clock so
      // the open event runs before the overdue timer callback can fire.
      const original = performance.now.bind(performance);
      vi.spyOn(performance, 'now').mockImplementation(() => original() + 30001);
    };
    let attempt: Promise<unknown>;
    if (kind === 'discovery') attempt = discoverRelayContactV1(hint, { onTransportSocket: onSocket, timeoutMs: 1000 });
    else if (kind === 'link') {
      const identity = generateIdentity(), now = Date.now();
      const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
        capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
        supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 }, issuedAt: now, expiresAt: now + 60000 }, identity);
      attempt = connectRelayLinkV1(hint, descriptor, identity, { onTransportSocket: onSocket, handshakeTimeoutMs: 1000 });
    } else if (kind === 'witness') attempt = witness(p.endpoint, new AbortController().signal, onSocket);
    else {
      const f = historyCheckpointFixture(), issuedAt = Date.now(), member = { publicKey: f.context.members[0], endpoint: p.endpoint };
      const shared = { rootId: f.options.rootId, generation: 0, replica: member.publicKey,
        challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 1000 };
      if (kind === 'checkpoint') {
        const request = createHistoryExchangeRequest({ ...shared, action: 'head', sequence: 0, envelopeId: null }, f.context, f.owner);
        attempt = exchangeHistoryCheckpoint(member, { request, envelope: null }, new AbortController().signal, onSocket);
      } else {
        const request = createHistoryAgreementRequest({ ...shared, action: 'promise', nextGeneration: 1, view: 1, proposalId: null, evidenceId: null }, f.context, f.owner);
        attempt = exchangeHistoryAgreement(member, { request, proposal: null, viewCertificate: null, preparedCertificate: null }, new AbortController().signal, onSocket);
      }
    }
    await expect(attempt).rejects.toThrow(fault === 'exception' ? 'socket accounting failed' : 'timed out');
    vi.restoreAllMocks(); await p.closed;
    expect(calls).toBe(1); expect(p.messages).toEqual([]); expect(p.extensions).toEqual([undefined]);
  },
);

it.each(['discovery', 'link'] as const)('destroys a rejected %s socket without waiting for an uncooperative peer close', async kind => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await once(server, 'listening');
  server.on('connection', socket => { socket.on('error', () => {}); socket.once('message', () => { socket.pause(); socket.send('{}'); }); });
  const hint = createRelayContactHintV1('configured', `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  let closed: Promise<unknown> | undefined;
  const onTransportSocket = (socket: Socket) => { closed = once(socket, 'close'); };
  let attempt: Promise<unknown>;
  if (kind === 'discovery') attempt = discoverRelayContactV1(hint, { onTransportSocket });
  else {
    const identity = generateIdentity(), now = Date.now();
    const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
      capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
      supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 }, issuedAt: now, expiresAt: now + 60000 }, identity);
    attempt = connectRelayLinkV1(hint, descriptor, identity, { onTransportSocket });
  }
  await expect(attempt).rejects.toThrow(); expect(closed).toBeDefined();
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([closed!, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local socket still retained')), 500); })]); }
  finally { clearTimeout(timer!); }
});

it('bounds and snapshots witness requests before opening a connection', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await once(server, 'listening'); let connections = 0;
  const received = new Promise<unknown>(resolve => server.on('connection', socket => {
    connections++; socket.on('error', () => {}); socket.once('message', data => { resolve(JSON.parse(data.toString())); socket.send('{}'); });
  }));
  const member = { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, publicKey: '' }, signal = new AbortController().signal;
  const oversized = { value: 'x'.repeat(4097) }, cyclic: any = {}; cyclic.self = cyclic;
  for (const invalid of [oversized, cyclic]) await expect(requestAdmissionWitnessVote(member, invalid as any, signal)).rejects.toThrow('witness request');
  expect(connections).toBe(0);
  const key = generateSigningKeyPair(), request = createAdmissionWitnessRequest({ setId: historyDigest('set'), issuerKey: historyDigest('issuer'),
    spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${randomBytes(64).toString('base64url')}` }, key);
  const original = structuredClone(request), attempt = requestAdmissionWitnessVote(member, request, signal);
  request.spend = randomBytes(32).toString('base64url');
  await attempt; expect(await received).toEqual(original); expect(connections).toBe(1);
});

it('does not send a witness claim when its owner cancels inside the accounting callback', async () => {
  const p = await peer(), controller = new AbortController();
  await expect(witness(p.endpoint, controller.signal, () => controller.abort())).rejects.toThrow('cancelled');
  await p.closed; expect(p.messages).toEqual([]);
});

it('contains a private-forward accounting failure before sending encrypted work to the destination', async () => {
  const p = await peer(), port = Number(new URL(p.endpoint).port), directory = mkdtempSync(join(tmpdir(), 'forward-accounting-'));
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  let refused = 0;
  class Meter extends RelayTrafficMeter {
    override observe(socket: Socket) {
      if (socket.remotePort === port) { refused++; throw new Error('Accounting failed'); }
      super.observe(socket);
    }
  }
  const entry = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory,
    resourceMeter: new Meter(), privateEntryMix: false, privateReplyMix: false,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  cleanup.push(() => entry.stop({ graceful: false })); await entry.start();
  const endpoint = `ws://127.0.0.1:${entry.getListeningPort()}/`, identity = generateIdentity(), now = Date.now();
  const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [p.endpoint], reachability: 'direct',
    capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
    supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 }, issuedAt: now, expiresAt: now + 60000 }, identity);
  expect(entry.observeRelayDescriptor(descriptor)).toBe('accepted');
  const contact = await discoverRelayContactV1(createRelayContactHintV1('configured', endpoint));
  const destination = await generateRelayTransportKeyV1(identity);
  const envelope = await createPrivateRequestV1(Buffer.from('{}'), contact.transportKey!, destination.attestation);
  const socket = new WebSocket(endpoint); socket.on('error', () => {});
  cleanup.push(async () => socket.terminate());
  const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
  await once(socket, 'open'); socket.send(serializePrivateRequestLayerV1(envelope.request));
  expect(await closed).toBe(1011); await p.closed;
  expect(refused).toBe(1); expect(p.messages).toEqual([]); expect(p.extensions).toEqual([undefined]);
});

it('closes an inbound socket when its accounting registration fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbound-accounting-')); let calls = 0;
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  class Meter extends RelayTrafficMeter {
    override observe() { calls++; throw new Error('Accounting failed'); }
  }
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory, resourceMeter: new Meter() });
  cleanup.push(() => relay.stop({ graceful: false })); await relay.start();
  const socket = new WebSocket(`ws://127.0.0.1:${relay.getListeningPort()}/`);
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  await expect(once(socket, 'open')).rejects.toThrow(); await closed;
  expect(calls).toBe(1); expect(relay.getStats().stored_publications).toBe(0);
});
