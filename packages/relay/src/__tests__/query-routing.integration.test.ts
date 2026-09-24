import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  SEARCH_RESPONSE_MESSAGE_TYPE,
  createPublicationRecord,
  createRelayContactHintV1,
  createSearchRequestFrameV2,
  createSearchRequestV2,
  generateIdentity,
  generatePublicationKeyMaterial,
  parseMessage,
  serializeSearchRequestFrameV2,
  verifyMessage,
  verifySearchResponsePayloadV2,
  type SearchRequestV2,
} from '@resonance/core';
import { RelayOperationLog } from '../operation-log.js';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 31_000 + Math.floor(Math.random() * 1_000);
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const PORTS = [0, 1, 2, 3, 4, 5].map(offset => BASE_PORT + offset);
const DIRECTORIES = PORTS.map(port => `/tmp/resonance-query-routing-${port}-${RUN_ID}`);
const [ORIGIN, HUB, FIRST_VOLUNTEER, SECOND_VOLUNTEER, ADMISSION_VOLUNTEER, THIRD_HOP] = PORTS;

const sharedRecord = createPublicationRecord({
  groupId: 'public', fingerprintEpoch: '2026-09',
  fingerprint: new Uint8Array(64).fill(0xa5), itemType: 'offer',
  createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
}, generatePublicationKeyMaterial());
const admissionRecord = createPublicationRecord({
  groupId: 'public', fingerprintEpoch: '2026-09',
  fingerprint: new Uint8Array(64).fill(0x5a), itemType: 'offer',
  createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
}, generatePublicationKeyMaterial());
const thirdHopRecord = createPublicationRecord({
  groupId: 'public', fingerprintEpoch: '2026-09',
  fingerprint: new Uint8Array(64).fill(0x3c), itemType: 'offer',
  createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
}, generatePublicationKeyMaterial());
const servers: RelayServer[] = [];

function endpoint(port: number): string {
  return `ws://127.0.0.1:${port}/`;
}

function createServer(index: number): RelayServer {
  const port = PORTS[index];
  const direct = port === HUB || port === THIRD_HOP;
  return createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir: DIRECTORIES[index],
    relayDiscovery: {
      endpoints: direct ? [endpoint(port)] : [],
      reachability: direct ? 'direct' : 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
    relayLinks: direct ? undefined : {
      targets: (port === FIRST_VOLUNTEER ? [HUB, THIRD_HOP] : [HUB])
        .map(targetPort => createRelayContactHintV1('configured', endpoint(targetPort))),
      handshakeTimeoutMs: 2_000,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
    ...(port === ADMISSION_VOLUNTEER ? {
      admissionVerifier: {
        verifyAndSpend: () => ({ status: 'rejected' as const }),
      },
    } : {}),
  });
}

function seedReplica(index: number, operation: typeof sharedRecord): void {
  const log = new RelayOperationLog(DIRECTORIES[index]);
  log.load();
  log.append({
    kind: 'publication', operation,
    allocationOrigin: 'replica', allocationRelayId: generateIdentity().did,
  });
}

function searchRequest(fill: number): SearchRequestV2 {
  const now = Date.now();
  return createSearchRequestV2({
    groupId: 'public', fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(fill), itemType: 'need',
    k: 5, threshold: 0.7, createdAt: now, expiresAt: now + 15_000,
  });
}

function searchThroughOrigin(request: SearchRequestV2): Promise<ReturnType<typeof parseMessage>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint(ORIGIN));
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Forwarded search timed out'));
    }, 7_000);
    ws.on('open', () => ws.send(serializeSearchRequestFrameV2(createSearchRequestFrameV2(request))));
    ws.on('message', data => {
      clearTimeout(timer);
      try { resolve(parseMessage(data.toString())); } catch (error) { reject(error); }
      ws.close();
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Relay links did not connect before timeout');
}

beforeAll(async () => {
  seedReplica(2, sharedRecord);
  seedReplica(3, sharedRecord);
  seedReplica(4, admissionRecord);
  seedReplica(5, thirdHopRecord);
  const hub = createServer(1);
  servers.push(hub);
  await hub.start();
  const thirdHop = createServer(5);
  await thirdHop.start();
  for (const index of [0, 2, 3, 4]) {
    const server = createServer(index);
    servers.push(server);
    await server.start();
  }
  servers.push(thirdHop);
  await waitFor(() => hub.getRelayLinkStatus().inboundRelayIds.length === 4
    && servers[1].getRelayLinkStatus().connectedRelayIds.length === 1
    && servers[2].getRelayLinkStatus().connectedRelayIds.length === 2
    && servers.slice(3, 5).every(server => server.getRelayLinkStatus().connectedRelayIds.length === 1));
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.stop({ graceful: false })));
  for (const directory of DIRECTORIES) rmSync(directory, { recursive: true, force: true });
});

describe('bounded query routing over volunteer relay links', () => {
  it('finds a record two hops away through outbound-only peers and merges duplicate replies', async () => {
    const origin = servers[1];
    const hub = servers[0];
    expect(origin.getStats().stored_publications).toBe(0);
    expect(hub.getStats().stored_publications).toBe(0);
    expect(origin.getStats().connected_query_peers).toBe(1);
    expect(hub.getStats().connected_query_peers).toBe(4);

    const request = searchRequest(0xa5);
    const response = await searchThroughOrigin(request);
    expect(verifyMessage(response)).toBe(true);
    expect(response.type).toBe(SEARCH_RESPONSE_MESSAGE_TYPE);
    expect(verifySearchResponsePayloadV2(response.payload)).toBe(true);
    expect(response.payload).toMatchObject({
      searchId: request.searchId,
      results: [{ publicationId: sharedRecord.publicationId, itemType: 'offer' }],
    });
    expect((response.payload as { results: unknown[] }).results).toHaveLength(1);
    expect(origin.getStats().stored_publications).toBe(0);
    expect(hub.getStats().stored_publications).toBe(0);

    const replay = await searchThroughOrigin(request);
    expect(replay.payload).toMatchObject({
      ref: request.searchId, status: 'error', message: 'replayed_search',
    });
  });

  it('does not bypass a remote relay admission requirement', async () => {
    const request = searchRequest(0x5a);
    const response = await searchThroughOrigin(request);
    expect(response.type).toBe(SEARCH_RESPONSE_MESSAGE_TYPE);
    expect(response.payload).toMatchObject({ searchId: request.searchId, results: [] });
  });

  it('does not traverse a third relay-link edge', async () => {
    expect(servers[5].getStats().stored_publications).toBe(1);
    const request = searchRequest(0x3c);
    const response = await searchThroughOrigin(request);
    expect(response.type).toBe(SEARCH_RESPONSE_MESSAGE_TYPE);
    expect(response.payload).toMatchObject({ searchId: request.searchId, results: [] });
  });
});
