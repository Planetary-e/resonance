import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  createPublicationRecord, createRelayContactHintV1, createRelayDescriptorV1,
  createRelayQueryRequestV1, createSearchRequestV2, decodeUTF8, encodeBase64,
  generateIdentity, generatePublicationKeyMaterial, generateRelationshipKeyMaterial, sign, verifyRelayQueryRequestV1,
  createRelayReplicaPutV1, createRelayReplicaReceiptV1, verifyRelayReplicaReceiptV1,
  verifyRelayReplicaReconciliationResponseV1, verifyRelayMailboxSyncResponseV1, verifyRelayRelationshipMailboxSyncResponseV1,
  verifyRelayQueryResponseV1, verifyRelayReplicaInventoryBatchResponseV1,
  verifyRelayReplicaInventoryResponseV1, type RelayQueryRequestV1, type SearchResultV2,
  createSearchRequestFrameV2, serializeSearchRequestFrameV2, parseMessage, verifyMessage, verifyRelayReplicaHandoffResponseV1,
} from '@resonance/core';
import { connectRelayLinkV1 } from '../relay-link-client.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import { createRelayServer } from '../server.js';
import * as logging from '../logger.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(replicaRequestTimeoutMs = 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-response-validation-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const remote = loadOrCreateRelayIdentity(directory); cleanup.push(() => { remote.secretKey.fill(0); });
  const server = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 }, descriptorLifetimeMs: 60_000 } });
  cleanup.push(() => server.stop({ graceful: false })); await server.start();
  const endpoint = `ws://127.0.0.1:${server.getListeningPort()!}/`, identity = generateIdentity();
  let now = Date.now(), frozen = false; const clock = () => frozen ? now : Date.now();
  const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
    capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
    supportedGroups: ['public'], storage: { capacityBytes: 1_000_000, availableBytes: 800_000 }, issuedAt: now, expiresAt: now + 60_000 }, identity);
  const incoming = vi.fn(async () => ({ status: 'ok' as const, results: [] as SearchResultV2[] }));
  const connection = await connectRelayLinkV1(createRelayContactHintV1('invitation', endpoint, remote.did), descriptor, identity,
    { now: clock, replicaRequestTimeoutMs, onQueryRequest: incoming,
      onReplicaHandoffRequest: async request => ({ accepted: request.operations.map(() => true), safeElsewhere: request.operations.map(() => true) }) });
  cleanup.push(async () => { connection.close(); await connection.closed; });
  const operation = createPublicationRecord({ groupId: 'public', fingerprintEpoch: '2026-09', fingerprint: new Uint8Array(64).fill(0x5a),
    itemType: 'offer', createdAt: now, expiresAt: now + 60_000 }, generatePublicationKeyMaterial());
  const search = () => createSearchRequestV2({ groupId: 'public', fingerprintEpoch: '2026-09', fingerprint: new Uint8Array(64).fill(0x5a),
    itemType: 'need', k: 5, threshold: 0.7, createdAt: clock(), expiresAt: clock() + 30_000 });
  return { server, connection, identity, remote, operation, endpoint, incoming, search, setTime(value: number) { now = value; frozen = true; } };
}

/** Intercept actual signed peer replies at dispatch, before pending timers run. */
function intercept(endpoint: string, requestType: string, responseType: string,
  reply: (frame: any, request: any, socket: WebSocket) => any) {
  let request: any, observed = 0;
  const send = WebSocket.prototype.send, emit = WebSocket.prototype.emit;
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
    if (this.url === endpoint) {
      const frame = JSON.parse(String(data)); if (frame.type === requestType) request = frame.request ?? frame;
    }
    return Reflect.apply(send, this, [data, ...args]);
  });
  vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event, ...args) {
    if (event === 'message' && this.url === endpoint) {
      const frame = JSON.parse(String(args[0]));
      if (frame.type === responseType) {
        observed++; expect(request).toBeDefined();
        const replacement = reply(frame, request, this);
        if (!replacement) return true;
        args[0] = Buffer.from(JSON.stringify(replacement));
      }
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  return () => observed;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function signedReply(value: any, secretKey: Uint8Array) {
  const { signature: _old, ...body } = value;
  return { ...body, signature: encodeBase64(sign(decodeUTF8(`resonance:relay-query:v1:response\n${canonical(body)}`), secretKey)) };
}

it.each(['peer', 'request'] as const)('rejects a correctly signed query reply from the wrong %s on an authenticated socket', async wrong => {
  const n = await fixture(), attacker = generateIdentity();
  const observed = intercept(n.endpoint, 'relay_query_request', 'relay_query_response', (frame, request) => {
    const alternate = createRelayQueryRequestV1(request.search, n.remote.did, n.identity, 0, undefined, request.createdAt, request.expiresAt);
    frame.response = signedReply(wrong === 'peer' ? { ...frame.response, senderRelayId: attacker.did }
      : { ...frame.response, requestSignature: alternate.signature }, wrong === 'peer' ? attacker.secretKey : n.remote.secretKey);
    expect(verifyRelayQueryResponseV1(frame.response)).toBe(true);
    expect(verifyRelayQueryResponseV1(frame.response, request)).toBe(false); return frame;
  });
  await expect(n.connection.querySearch(n.search(), undefined, 0, 1000)).rejects.toThrow();
  expect(observed()).toBe(1); expect(await n.connection.closed).toMatchObject({ code: 4000, reason: 'invalid_relay_query_response' });
});

it('does not deliver an authentic request signed by another relay to the outbound link callback', async () => {
  const n = await fixture(), attacker = generateIdentity(), emit = WebSocket.prototype.emit;
  const observed = intercept(n.endpoint, 'relay_query_request', 'relay_query_response', (_frame, request, socket) => {
    const inbound = createRelayQueryRequestV1(request.search, n.identity.did, attacker, 0, undefined, request.createdAt, request.expiresAt);
    expect(verifyRelayQueryRequestV1(inbound)).toBe(true);
    Reflect.apply(emit, socket, ['message', Buffer.from(JSON.stringify({ type: 'relay_query_request', request: inbound }))]); return undefined;
  });
  await expect(n.connection.querySearch(n.search(), undefined, 0, 1000)).rejects.toThrow();
  expect(observed()).toBe(1); expect(n.incoming).not.toHaveBeenCalled();
  expect(await n.connection.closed).toMatchObject({ code: 4000, reason: 'invalid_relay_query_request' });
});

it('rejects a correctly signed query request whose sender differs from the server authenticated peer', async () => {
  const n = await fixture(), attacker = generateIdentity(), send = WebSocket.prototype.send; let observed = 0;
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
    if (this.url === n.endpoint) {
      const frame = JSON.parse(String(data));
      if (frame.type === 'relay_query_request') {
        const request: RelayQueryRequestV1 = frame.request; observed++;
        frame.request = createRelayQueryRequestV1(request.search, n.remote.did, attacker, 0, undefined, request.createdAt, request.expiresAt);
        expect(verifyRelayQueryRequestV1(frame.request)).toBe(true); data = JSON.stringify(frame);
      }
    }
    return Reflect.apply(send, this, [data, ...args]);
  });
  await expect(n.connection.querySearch(n.search(), undefined, 0, 1000)).rejects.toThrow();
  expect(observed).toBe(1); expect(await n.connection.closed).toMatchObject({ code: 4000, reason: 'invalid_relay_query_request' });
});

const responseFamilies = {
  query: ['relay_query_request', 'relay_query_response', verifyRelayQueryResponseV1],
  receipt: ['relay_replica_put', 'relay_replica_receipt', verifyRelayReplicaReceiptV1],
  inventory: ['relay_replica_inventory_request', 'relay_replica_inventory_response', verifyRelayReplicaInventoryResponseV1],
  presence: ['relay_replica_inventory_batch_request', 'relay_replica_inventory_batch_response', verifyRelayReplicaInventoryBatchResponseV1],
  reconciliation: ['relay_replica_reconciliation_request', 'relay_replica_reconciliation_response', verifyRelayReplicaReconciliationResponseV1],
  mailbox: ['relay_mailbox_sync_request', 'relay_mailbox_sync_response', verifyRelayMailboxSyncResponseV1],
  relationship: ['relay_relationship_mailbox_sync_request', 'relay_relationship_mailbox_sync_response', verifyRelayRelationshipMailboxSyncResponseV1],
} as const;
for (const kind of Object.keys(responseFamilies) as Array<keyof typeof responseFamilies>) {
  it.each(['exact-expiry', 'after-expiry', 'monotonic-timeout'] as const)(`refuses an authentic ${kind} reply at %s before its timer callback runs`, async late => {
    const n = await fixture(), receipt = kind === 'query' || kind === 'receipt' || kind === 'relationship'
      ? undefined : await n.connection.placeReplica(n.operation);
    const refusal = kind === 'reconciliation' ? createRelayReplicaReceiptV1(
      createRelayReplicaPutV1(n.operation, n.identity), n.remote, { status: 'rejected', reason: 'stale' }) : undefined;
    const [requestType, responseType, verify] = responseFamilies[kind];
    const clock = performance.now.bind(performance); let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
    const observed = intercept(n.endpoint, requestType, responseType, (frame, request) => {
      expect((verify as (response: unknown, request: any) => boolean)(frame.response ?? frame.receipt, request)).toBe(true);
      if (late === 'monotonic-timeout') { n.setTime(request.createdAt); offset = 1001; }
      else n.setTime(request.expiresAt + (late === 'after-expiry' ? 1 : 0));
      return frame;
    });
    const pending = kind === 'query' ? n.connection.querySearch(n.search(), undefined, 0, 1000)
      : kind === 'receipt' ? n.connection.placeReplica(n.operation)
      : kind === 'inventory' ? n.connection.checkReplica(receipt!)
      : kind === 'presence' ? n.connection.checkReplicaBatch([receipt!])
      : kind === 'reconciliation' ? n.connection.reconcileReplica(refusal!)
      : kind === 'mailbox' ? n.connection.syncMailbox(receipt!, 0, [])
      : n.connection.syncRelationshipMailbox(generateRelationshipKeyMaterial().mailboxId, 0, []);
    await expect(pending).rejects.toThrow(/expir|timed out|deadline/i);
    expect(observed()).toBe(1); expect(n.connection.isOpen()).toBe(true);
  });
}


it.each(['live', 'exact-expiry', 'monotonic-timeout'] as const)('uses the original deadline for server-side inbound queries: %s', async late => {
  const n = await fixture(), result = { publicationId: n.operation.publicationId, similarity: 0.9, itemType: 'offer' as const };
  n.incoming.mockResolvedValue({ status: 'ok', results: [result] });
  const send = WebSocket.prototype.send, emit = WebSocket.prototype.emit, clock = performance.now.bind(performance);
  let request: RelayQueryRequestV1 | undefined, offset = 0, observed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
    const frame = JSON.parse(String(data)); if (frame.type === 'relay_query_request' && frame.request.senderRelayId === n.remote.did) request = frame.request;
    return Reflect.apply(send, this, [data, ...args]);
  });
  vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event, ...args) {
    if (event === 'message') {
      const frame = JSON.parse(String(args[0]));
      if (frame.type === 'relay_query_response' && frame.response.senderRelayId === n.identity.did) {
        observed++; expect(request).toBeDefined(); expect(verifyRelayQueryResponseV1(frame.response, request!)).toBe(true);
        if (late === 'exact-expiry') vi.spyOn(Date, 'now').mockReturnValue(request!.expiresAt);
        if (late === 'monotonic-timeout') { vi.spyOn(Date, 'now').mockReturnValue(request!.createdAt); offset = request!.expiresAt - request!.createdAt + 1; }
      }
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  const response = await new Promise<ReturnType<typeof parseMessage>>((resolve, reject) => {
    const client = new WebSocket(n.endpoint); cleanup.push(() => { client.terminate(); });
    client.on('error', reject); client.on('open', () => client.send(serializeSearchRequestFrameV2(createSearchRequestFrameV2(n.search()))));
    client.on('message', data => { try { resolve(parseMessage(data.toString())); } catch (error) { reject(error); } client.close(); });
  });
  expect(observed).toBe(1); expect(verifyMessage(response)).toBe(true);
  expect(response.payload).toMatchObject({ results: late === 'live' ? [result] : [] }); expect(n.connection.isOpen()).toBe(true);
});

it.each(['live', 'exact-expiry', 'monotonic-timeout'] as const)('uses the original deadline for the shutdown handoff receipt: %s', async late => {
  const n = await fixture(); await n.connection.placeReplica(n.operation);
  const send = WebSocket.prototype.send, emit = WebSocket.prototype.emit, clock = performance.now.bind(performance);
  const logged = vi.spyOn(logging, 'log'); let request: any, offset = 0, observed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
    const frame = JSON.parse(String(data)); if (frame.type === 'relay_replica_handoff_request') request = frame.request;
    return Reflect.apply(send, this, [data, ...args]);
  });
  vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event, ...args) {
    if (event === 'message') {
      const frame = JSON.parse(String(args[0]));
      if (frame.type === 'relay_replica_handoff_response') {
        observed++; expect(request).toBeDefined(); expect(verifyRelayReplicaHandoffResponseV1(frame.response, request)).toBe(true);
        if (late === 'exact-expiry') vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt);
        // Handoff's signed lifetime is timeout+1000ms; the local 2000ms
        // budget must still win under a frozen wall clock.
        if (late === 'monotonic-timeout') { vi.spyOn(Date, 'now').mockReturnValue(request.createdAt); offset = request.expiresAt - request.createdAt - 999; }
      }
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  await n.server.stop(); expect(observed).toBe(1);
  const completion = logged.mock.calls.find(([, event]) => event === 'replica_handoff_complete');
  expect(completion?.[2]).toMatchObject({ hosted: 1, acknowledged: late === 'live' ? 1 : 0, safeElsewhere: late === 'live' ? 1 : 0 });
});


it.each(['mailbox', 'relationship'] as const)('keeps the shorter signed %s deadline under a frozen wall when the configured timer is longer', async kind => {
  const n = await fixture(20_000), receipt = kind === 'mailbox' ? await n.connection.placeReplica(n.operation) : undefined;
  const [requestType, responseType, verify] = responseFamilies[kind], clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const observed = intercept(n.endpoint, requestType, responseType, (frame, request) => {
    expect((verify as (response: unknown, request: any) => boolean)(frame.response, request)).toBe(true);
    n.setTime(request.createdAt); offset = request.expiresAt - request.createdAt + 1; return frame;
  });
  await expect(kind === 'mailbox' ? n.connection.syncMailbox(receipt!, 0, [])
    : n.connection.syncRelationshipMailbox(generateRelationshipKeyMaterial().mailboxId, 0, [])).rejects.toThrow(/expir|timed out|deadline/i);
  expect(observed()).toBe(1); expect(n.connection.isOpen()).toBe(true);
});

it('ignores a valid inventory reply delivered after its local timer removed the pending request', async () => {
  const n = await fixture(100), receipt = await n.connection.placeReplica(n.operation), emit = WebSocket.prototype.emit;
  let held: { socket: WebSocket; frame: object } | undefined;
  const observed = intercept(n.endpoint, 'relay_replica_inventory_request', 'relay_replica_inventory_response', (frame, request, socket) => {
    expect(verifyRelayReplicaInventoryResponseV1(frame.response, request)).toBe(true); held = { socket, frame }; return undefined;
  });
  await expect(n.connection.checkReplica(receipt)).rejects.toThrow('timed out'); expect(observed()).toBe(1);
  Reflect.apply(emit, held!.socket, ['message', Buffer.from(JSON.stringify(held!.frame))]);
  expect(n.connection.isOpen()).toBe(true);
  expect((await n.connection.querySearch(n.search(), undefined, 0, 1000)).status).toBe('ok');
});
