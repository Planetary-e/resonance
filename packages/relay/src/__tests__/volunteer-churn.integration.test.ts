import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import WebSocket from 'ws';
import {
  createMailboxRequest, createMailboxRequestFrame,
  createPublicationOperationFrame, createPublicationRecord,
  createRelayContactHintV1, generatePublicationKeyMaterial,
  parseMessage, serializeMailboxRequestFrame, serializePublicationOperationFrame,
  type Message, type PublicationKeyMaterial, type PublicationRecord,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 33_000 + Math.floor(Math.random() * 1_000);
const SOURCE_PORT = BASE_PORT;
const TARGET_PORTS = [1, 2, 3, 4, 5].map(offset => BASE_PORT + offset);
const PARTITION_PORT = BASE_PORT + 6;
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const SOURCE_DIR = `/tmp/resonance-churn-source-${RUN_ID}`;
const TARGET_DIRS = TARGET_PORTS.map(port => `/tmp/resonance-churn-target-${port}-${RUN_ID}`);

const targets: RelayServer[] = [];
const runningTargets = new Set<number>();
let source: RelayServer;
let proxy: Server | undefined;
const proxySockets = new Set<Socket>();

function endpoint(port: number): string { return `ws://127.0.0.1:${port}/`; }

function makeTarget(index: number): RelayServer {
  return createRelayServer({
    port: TARGET_PORTS[index], host: '127.0.0.1', persistDir: TARGET_DIRS[index],
    relayDiscovery: {
      endpoints: [endpoint(index === 0 ? PARTITION_PORT : TARGET_PORTS[index])],
      reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function makeSource(): RelayServer {
  return createRelayServer({
    port: SOURCE_PORT, host: '127.0.0.1', persistDir: SOURCE_DIR,
    desiredReplicaCount: 5, minimumHealthyReplicaCount: 3,
    replicaRepairIntervalMs: 100, replicaInventoryIntervalMs: 300,
    replicaOfflineReplacementDelayMs: 20_000,
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: TARGET_PORTS.map((port, index) => createRelayContactHintV1(
        'configured', endpoint(index === 0 ? PARTITION_PORT : port),
      )),
      maxConnections: 5, handshakeTimeoutMs: 2_000,
      heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1_500,
      replicaRequestTimeoutMs: 1_000, reconnectBaseMs: 50, reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

async function connectProxy(): Promise<void> {
  proxy = createServer(client => {
    const upstream = connect(TARGET_PORTS[0], '127.0.0.1');
    proxySockets.add(client);
    proxySockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => { proxySockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { proxySockets.delete(upstream); client.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy!.once('error', reject);
    proxy!.listen(PARTITION_PORT, '127.0.0.1', resolve);
  });
}

async function disconnectProxy(): Promise<void> {
  if (!proxy) return;
  for (const socket of proxySockets) socket.destroy();
  const server = proxy;
  proxy = undefined;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function request(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint(port));
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('relay request timed out')); }, 5_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timeout);
      socket.close();
      resolve(parseMessage(data.toString()));
    });
    socket.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

function publication(itemType: 'need' | 'offer') {
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  return {
    keys,
    record: createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'volunteer-churn',
      fingerprint: new Uint8Array(64).fill(0x39), itemType,
      createdAt: now, expiresAt: now + 120_000,
    }, keys),
  };
}

async function publish(record: PublicationRecord): Promise<void> {
  const response = await request(SOURCE_PORT, serializePublicationOperationFrame(
    createPublicationOperationFrame(record),
  ));
  expect(response.payload).toMatchObject({ status: 'ok' });
}

async function fetch(port: number, record: PublicationRecord, keys: PublicationKeyMaterial): Promise<string[]> {
  const response = await request(port, serializeMailboxRequestFrame(createMailboxRequestFrame(
    createMailboxRequest('fetch', record, keys, [], Date.now()),
  ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
  return response.payload.envelopes.map(envelope => envelope.envelopeId);
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('volunteer churn condition not met');
}

beforeAll(async () => {
  for (let index = 0; index < TARGET_PORTS.length; index++) {
    targets.push(makeTarget(index));
  }
  await Promise.all(targets.map(target => target.start()));
  TARGET_PORTS.forEach((_, index) => runningTargets.add(index));
  await connectProxy();
  source = makeSource();
  await source.start();
});

afterAll(async () => {
  if (source) await source.stop({ graceful: false });
  await disconnectProxy();
  await Promise.all([...runningTargets].map(index => targets[index].stop({ graceful: false })));
  rmSync(SOURCE_DIR, { recursive: true, force: true });
  TARGET_DIRS.forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('five-relay volunteer churn and partition', () => {
  it('keeps delivery available during link isolation and relay loss, then repairs state and acknowledgements', async () => {
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 5);
    const offer = publication('offer');
    const need = publication('need');
    await publish(offer.record);
    await publish(need.record);
    await waitFor(() => source.getReplicaPlacementStatus(offer.record.publicationId)?.confirmedReplicaCount === 5
      && source.getReplicaPlacementStatus(need.record.publicationId)?.confirmedReplicaCount === 5);
    const noticeId = (await fetch(SOURCE_PORT, offer.record, offer.keys))[0];
    expect(noticeId).toBeDefined();
    await waitFor(async () => (await Promise.all(TARGET_PORTS.map(port => fetch(port, offer.record, offer.keys))))
      .every(ids => ids.length === 1 && ids[0] === noticeId));

    // The relay stays online for clients while its controller link is partitioned.
    await disconnectProxy();
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 4);
    expect(await fetch(TARGET_PORTS[0], offer.record, offer.keys)).toEqual([noticeId]);

    // A second volunteer disappears abruptly. Three selected replicas remain connected.
    await targets[1].stop({ graceful: false });
    runningTargets.delete(1);
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 3);
    expect(source.getReplicaPlacementStatus(offer.record.publicationId)?.intent.targetRelayIds)
      .toHaveLength(5);
    expect(await fetch(TARGET_PORTS[2], offer.record, offer.keys)).toEqual([noticeId]);

    // Acknowledgement on the isolated relay cannot yet reach the controller.
    const ack = await request(TARGET_PORTS[0], serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('ack', offer.record, offer.keys, [noticeId], Date.now()),
    )));
    expect(ack.payload).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
    expect(await fetch(TARGET_PORTS[0], offer.record, offer.keys)).toEqual([]);

    // The failed relay returns with its journal lost; the controller restores its publication.
    rmSync(`${TARGET_DIRS[1]}/relay-operations.ndjson`, { force: true });
    targets[1] = makeTarget(1);
    await targets[1].start();
    runningTargets.add(1);
    await waitFor(() => targets[1].getStats().active_publications === 2);
    await waitFor(async () => (await fetch(TARGET_PORTS[1], offer.record, offer.keys)).includes(noticeId));

    // Healing the link spreads the tombstone, including to the recovered relay.
    await connectProxy();
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 5);
    await waitFor(async () => (await Promise.all([SOURCE_PORT, ...TARGET_PORTS]
      .map(port => fetch(port, offer.record, offer.keys)))).every(ids => ids.length === 0));
    expect(source.getReplicaPlacementStatus(offer.record.publicationId)).toMatchObject({
      minimumConfirmed: true, targetConfirmed: true, confirmedReplicaCount: 5,
    });
  }, 60_000);
});
