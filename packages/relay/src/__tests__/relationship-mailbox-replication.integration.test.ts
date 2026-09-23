import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import {
  createChannelMessageOperationV2, createPairwiseChannelId,
  createRelationshipMailboxDepositFrameV2, createRelationshipMailboxDepositV2,
  createRelationshipMailboxRequestFrameV2, createRelationshipMailboxRequestV2,
  encryptChannelOperationV2, generateRelationshipKeyMaterial,
  parseMessage, serializeRelationshipMailboxDepositFrameV2,
  serializeRelationshipMailboxRequestFrameV2,
  type Message, type RelationshipKeyMaterial,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 32_000 + Math.floor(Math.random() * 1_000);
const SOURCE_PORT = BASE_PORT;
const TARGET_PORTS = [BASE_PORT + 1, BASE_PORT + 2];
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const SOURCE_DIR = `/tmp/resonance-relationship-source-${RUN_ID}`;
const TARGET_DIRS = TARGET_PORTS.map(port => `/tmp/resonance-relationship-target-${port}-${RUN_ID}`);
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
    replicaRepairIntervalMs: 100,
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: TARGET_PORTS.map(port => ({ source: 'configured' as const, endpoint: endpoint(port) })),
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

async function fetch(port: number, keys: RelationshipKeyMaterial): Promise<string[]> {
  const response = await request(port, serializeRelationshipMailboxRequestFrameV2(
    createRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestV2('fetch', keys)),
  )) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
  return response.payload.envelopes.map(envelope => envelope.envelopeId);
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('relationship mailbox replication condition not met');
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

describe('relationship mailbox anti-entropy', () => {
  it('survives original relay loss and reconciles an acknowledgement after restart', async () => {
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 2);
    const sender = generateRelationshipKeyMaterial();
    const recipient = generateRelationshipKeyMaterial();
    const channelId = createPairwiseChannelId(
      'match_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sender.relationshipId, recipient.relationshipId,
    );
    const operation = createChannelMessageOperationV2(
      channelId, recipient.relationshipId, 1,
      { kind: 'disclosure', text: 'private message', level: 'general', createdAt: Date.now() },
      randomBytes(32), sender,
    );
    const envelope = encryptChannelOperationV2(operation, {
      id: recipient.mailboxId,
      encryptionKey: Buffer.from(recipient.mailboxKeyPair.publicKey).toString('base64'),
    });
    const deposit = await request(SOURCE_PORT, serializeRelationshipMailboxDepositFrameV2(
      createRelationshipMailboxDepositFrameV2(createRelationshipMailboxDepositV2(
        recipient.relationshipId, sender, envelope,
      )),
    ));
    expect(deposit.payload).toMatchObject({ status: 'ok' });
    await waitFor(async () => (await fetch(TARGET_PORTS[0], recipient)).includes(envelope.envelopeId)
      && (await fetch(TARGET_PORTS[1], recipient)).includes(envelope.envelopeId));

    // A volunteer can return with an empty journal and regain the envelope.
    await targets[1].stop({ graceful: false });
    rmSync(`${TARGET_DIRS[1]}/relay-operations.ndjson`, { force: true });
    targets[1] = makeTarget(1);
    await targets[1].start();
    await waitFor(async () => (await fetch(TARGET_PORTS[1], recipient)).includes(envelope.envelopeId));

    await source.stop({ graceful: false });
    sourceStarted = false;
    expect(await fetch(TARGET_PORTS[0], recipient)).toContain(envelope.envelopeId);
    expect(await fetch(TARGET_PORTS[1], recipient)).toContain(envelope.envelopeId);

    const acknowledgement = await request(TARGET_PORTS[0], serializeRelationshipMailboxRequestFrameV2(
      createRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestV2(
        'ack', recipient, [envelope.envelopeId],
      )),
    ));
    expect(acknowledgement.payload).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
    source = makeSource();
    await source.start();
    sourceStarted = true;
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 2);
    await waitFor(async () => !(await fetch(SOURCE_PORT, recipient)).includes(envelope.envelopeId)
      && !(await fetch(TARGET_PORTS[1], recipient)).includes(envelope.envelopeId));

    await source.stop({ graceful: false });
    sourceStarted = false;
    source = makeSource();
    await source.start();
    sourceStarted = true;
    expect(await fetch(SOURCE_PORT, recipient)).not.toContain(envelope.envelopeId);
  }, 40_000);
});
