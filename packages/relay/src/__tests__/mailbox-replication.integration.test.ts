import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import {
  createMailboxRequest, createMailboxRequestFrame,
  createPublicationOperationFrame, createPublicationRecord,
  createRelayContactHintV1, generatePublicationKeyMaterial,
  parseMessage, serializeMailboxRequestFrame, serializePublicationOperationFrame,
  type Message, type PublicationOperation, type PublicationKeyMaterial,
  type PublicationRecord,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 29_000 + Math.floor(Math.random() * 1_000);
const SOURCE_PORT = BASE_PORT;
const TARGET_PORTS = [BASE_PORT + 1, BASE_PORT + 2];
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const SOURCE_DIR = `/tmp/resonance-mailbox-source-${RUN_ID}`;
const TARGET_DIRS = TARGET_PORTS.map(port => `/tmp/resonance-mailbox-target-${port}-${RUN_ID}`);
let source: RelayServer;
let targets: RelayServer[] = [];
let sourceStarted = false;

function endpoint(port: number): string { return `ws://127.0.0.1:${port}/`; }

function makeTarget(index: number): RelayServer {
  return createRelayServer({
    port: TARGET_PORTS[index], host: '127.0.0.1', persistDir: TARGET_DIRS[index],
    relayDiscovery: {
      endpoints: [endpoint(TARGET_PORTS[index])], reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function makeSource(): RelayServer {
  return createRelayServer({
    port: SOURCE_PORT, host: '127.0.0.1', persistDir: SOURCE_DIR,
    desiredReplicaCount: 2, minimumHealthyReplicaCount: 2,
    replicaRepairIntervalMs: 100, replicaInventoryIntervalMs: 500,
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: TARGET_PORTS.map(port => createRelayContactHintV1('configured', endpoint(port))),
      maxConnections: 2, handshakeTimeoutMs: 2_000,
      heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1_500,
      replicaRequestTimeoutMs: 1_000, reconnectBaseMs: 50, reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function request(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint(port));
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('mailbox request timed out')); }, 5_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timeout);
      socket.close();
      resolve(parseMessage(data.toString()));
    });
    socket.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

function makePublication(itemType: 'need' | 'offer') {
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  return {
    keys,
    record: createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'mailbox-replication-test',
      fingerprint: new Uint8Array(64).fill(0x39), itemType,
      createdAt: now, expiresAt: now + 60_000,
    }, keys),
  };
}

async function publish(operation: PublicationOperation): Promise<void> {
  const response = await request(SOURCE_PORT, serializePublicationOperationFrame(
    createPublicationOperationFrame(operation),
  ));
  expect(response.payload).toMatchObject({ status: 'ok' });
}

async function fetch(port: number, record: PublicationRecord, keys: PublicationKeyMaterial): Promise<string[]> {
  const response = await request(port, serializeMailboxRequestFrame(createMailboxRequestFrame(
    createMailboxRequest('fetch', record, keys, [], Date.now()),
  ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
  return response.payload.envelopes.map(envelope => envelope.envelopeId);
}

async function acknowledge(
  port: number, record: PublicationRecord, keys: PublicationKeyMaterial, envelopeId: string,
): Promise<void> {
  const response = await request(port, serializeMailboxRequestFrame(createMailboxRequestFrame(
    createMailboxRequest('ack', record, keys, [envelopeId], Date.now()),
  )));
  expect(response.payload).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('mailbox replication condition not met');
}

beforeAll(async () => {
  targets = [makeTarget(0), makeTarget(1)];
  await Promise.all(targets.map(target => target.start()));
  source = makeSource();
  await source.start();
  sourceStarted = true;
});

afterAll(async () => {
  if (sourceStarted) await source.stop({ graceful: false });
  await Promise.all(targets.map(target => target.stop({ graceful: false })));
  rmSync(SOURCE_DIR, { recursive: true, force: true });
  for (const directory of TARGET_DIRS) rmSync(directory, { recursive: true, force: true });
});

describe('publication mailbox anti-entropy', () => {
  it('retains encrypted notices during controller loss, converges acknowledgements, and repairs a lost replica', async () => {
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 2);
    const offer = makePublication('offer');
    const need = makePublication('need');
    await publish(offer.record);
    await publish(need.record);
    await waitFor(() => source.getReplicaPlacementStatus(offer.record.publicationId)?.confirmedReplicaCount === 2
      && source.getReplicaPlacementStatus(need.record.publicationId)?.confirmedReplicaCount === 2);

    const offerNoticeId = (await fetch(SOURCE_PORT, offer.record, offer.keys))[0];
    const needNoticeId = (await fetch(SOURCE_PORT, need.record, need.keys))[0];
    expect(offerNoticeId).toBeDefined();
    expect(needNoticeId).toBeDefined();
    await waitFor(async () => (await fetch(TARGET_PORTS[0], offer.record, offer.keys)).includes(offerNoticeId)
      && (await fetch(TARGET_PORTS[1], need.record, need.keys)).includes(needNoticeId));
    for (const port of [SOURCE_PORT, ...TARGET_PORTS]) {
      expect(await fetch(port, offer.record, offer.keys)).toEqual([offerNoticeId]);
      expect(await fetch(port, need.record, need.keys)).toEqual([needNoticeId]);
    }

    await source.stop({ graceful: false });
    sourceStarted = false;
    expect(await fetch(TARGET_PORTS[0], offer.record, offer.keys)).toContain(offerNoticeId);
    expect(await fetch(TARGET_PORTS[1], need.record, need.keys)).toContain(needNoticeId);

    source = makeSource();
    await source.start();
    sourceStarted = true;
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 2);
    await acknowledge(TARGET_PORTS[0], offer.record, offer.keys, offerNoticeId);
    await waitFor(async () => !(await fetch(SOURCE_PORT, offer.record, offer.keys)).includes(offerNoticeId)
      && !(await fetch(TARGET_PORTS[1], offer.record, offer.keys)).includes(offerNoticeId));

    await source.stop({ graceful: false });
    sourceStarted = false;
    source = makeSource();
    await source.start();
    sourceStarted = true;
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 2);
    expect(await fetch(SOURCE_PORT, offer.record, offer.keys)).not.toContain(offerNoticeId);

    await targets[1].stop({ graceful: false });
    rmSync(`${TARGET_DIRS[1]}/relay-operations.ndjson`, { force: true });
    targets[1] = makeTarget(1);
    await targets[1].start();
    await waitFor(() => targets[1].getStats().active_publications === 2, 15_000);
    await waitFor(async () => (await fetch(TARGET_PORTS[1], need.record, need.keys)).includes(needNoticeId), 15_000);
    expect(await fetch(TARGET_PORTS[1], offer.record, offer.keys)).not.toContain(offerNoticeId);
  }, 40_000);
});
