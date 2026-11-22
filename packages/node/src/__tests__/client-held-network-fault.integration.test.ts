import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createContentPollRequestV1,
  createLeasedIndexLookupRequestV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  createPairwiseChannelId,
  deriveSharedSecret,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  generateSigningKeyPair,
  type LeasedIndexKeyMaterialV1,
} from '@resonance/core';
import { ContentGrantStore } from '../content-grant-store.js';
import { createRelayClient } from '../relay-client.js';
import {
  ProcessRelay,
  admissionProvider,
  fixedIndex,
} from './fixtures/client-held-process-harness.js';

interface Pair {
  client: Socket;
  relay: Socket;
  interruptAfterHandshake: boolean;
  handshakeComplete: boolean;
}

// Ordered, backpressured TCP byte forwarding only. Latency and connection resets
// do not provide packet-loss, reordering, or retransmission evidence below TCP.
class TcpFaultProxy {
  endpoint!: string;
  private readonly server: Server;
  private readonly pairs = new Set<Pair>();
  private interruptNext = false;
  private targetPort: number;
  private latencyMs: number;
  connections = 0;
  interruptions = 0;
  clientBytes = 0;
  relayBytes = 0;

  private constructor(target: string, latencyMs: number) {
    const url = new URL(target);
    this.targetPort = Number(url.port);
    this.latencyMs = latencyMs;
    this.server = createServer(socket => this.accept(socket));
  }

  static async start(target: string, latencyMs: number): Promise<TcpFaultProxy> {
    const proxy = new TcpFaultProxy(target, latencyMs);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('TCP proxy did not acquire a listener');
    proxy.endpoint = `ws://127.0.0.1:${address.port}/`;
    return proxy;
  }

  interruptNextOperation(): void {
    this.interruptNext = true;
  }

  interruptConnections(): number {
    const count = this.pairs.size;
    this.interruptions += count;
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.relay.destroy();
    }
    return count;
  }

  async stop(): Promise<void> {
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.relay.destroy();
    }
    if (!this.server.listening) return;
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private accept(client: Socket): void {
    this.connections++;
    const relay = connect(this.targetPort, '127.0.0.1');
    const pair: Pair = {
      client,
      relay,
      interruptAfterHandshake: this.interruptNext,
      handshakeComplete: false,
    };
    this.interruptNext = false;
    this.pairs.add(pair);
    client.on('error', () => {});
    relay.on('error', () => {});
    this.forward(pair, client, relay, true);
    this.forward(pair, relay, client, false);
    const cleanup = () => {
      if (!this.pairs.delete(pair)) return;
      client.destroy();
      relay.destroy();
    };
    client.once('close', cleanup);
    relay.once('close', cleanup);
  }

  private forward(pair: Pair, source: Socket, destination: Socket, fromClient: boolean): void {
    source.on('data', (chunk: Buffer) => {
      source.pause();
      if (fromClient) this.clientBytes += chunk.length;
      else this.relayBytes += chunk.length;
      setTimeout(() => {
        if (!source.destroyed && !destination.destroyed) {
          if (fromClient && pair.interruptAfterHandshake && pair.handshakeComplete) {
            pair.interruptAfterHandshake = false;
            this.interruptions++;
            pair.client.destroy();
            pair.relay.destroy();
            return;
          }
          if (!fromClient) pair.handshakeComplete = true;
          if (!destination.write(chunk)) destination.once('drain', () => source.resume());
          else source.resume();
        }
      }, this.latencyMs);
    });
  }
}

const directories: string[] = [];
const relays: ProcessRelay[] = [];
const proxies: TcpFaultProxy[] = [];
const clients: Array<{ disconnect(): void }> = [];
const stores: Array<{ close(): void }> = [];

function client(endpoint: string) {
  const value = createRelayClient({ relayUrl: endpoint, admissionCapabilityProvider: admissionProvider });
  clients.push(value);
  return value;
}

function open<T extends { close(): void }>(store: T): T {
  stores.push(store);
  return store;
}

function contentChannels(
  owner: LeasedIndexKeyMaterialV1,
  requester: LeasedIndexKeyMaterialV1,
  ownerStore: ContentGrantStore,
  requesterStore: ContentGrantStore,
) {
  const ownerRelationship = generateRelationshipKeyMaterial();
  const requesterRelationship = generateRelationshipKeyMaterial();
  const ownerShared = deriveSharedSecret(
    ownerRelationship.channelKeyPair.secretKey,
    requesterRelationship.channelKeyPair.publicKey,
  );
  const requesterShared = deriveSharedSecret(
    requesterRelationship.channelKeyPair.secretKey,
    ownerRelationship.channelKeyPair.publicKey,
  );
  const channelId = createPairwiseChannelId(
    `match_${'M'.repeat(43)}`,
    ownerRelationship.relationshipId,
    requesterRelationship.relationshipId,
  );
  ownerStore.registerChannel({
    channelId,
    localPublicationId: owner.publicationId,
    partnerPublicationId: requester.publicationId,
    localRelationshipKeys: ownerRelationship,
    publicationKeys: owner,
    partnerRelationshipId: requesterRelationship.relationshipId,
    partnerRelationshipKey: Buffer.from(requesterRelationship.signingKeyPair.publicKey).toString('base64'),
    sharedKey: ownerShared,
  });
  requesterStore.registerChannel({
    channelId,
    localPublicationId: requester.publicationId,
    partnerPublicationId: owner.publicationId,
    localRelationshipKeys: requesterRelationship,
    publicationKeys: requester,
    partnerRelationshipId: ownerRelationship.relationshipId,
    partnerRelationshipKey: Buffer.from(ownerRelationship.signingKeyPair.publicKey).toString('base64'),
    sharedKey: requesterShared,
  });
  return { channelId, ownerRelationship, requesterRelationship };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Network condition was not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const value of clients.splice(0)) value.disconnect();
  await Promise.allSettled(proxies.splice(0).map(value => value.stop()));
  await Promise.allSettled(relays.splice(0).map(value => value.stop()));
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('client-held loopback network fault qualification', () => {
  it('preserves exact lookup retry across TCP latency and an in-flight connection reset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resonance-client-held-network-'));
    directories.push(root);
    const relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    const proxy = await TcpFaultProxy.start(relay.endpoint, 5);
    proxies.push(proxy);
    const network = client(proxy.endpoint);
    const keys = generateLeasedIndexKeyMaterialV1();
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + 86_400_000);
    const operationBytes = JSON.stringify(index);
    const coldStarted = performance.now();
    expect((await network.submitLeasedIndexOperation(operationBytes)).status).toBe('ok');
    const coldMs = performance.now() - coldStarted;
    const request = createLeasedIndexLookupRequestV1({
      publicationId: keys.publicationId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair());
    const warmClientStarted = performance.now();
    expect(await network.lookupLeasedIndex(request)).toBe(operationBytes);
    const warmClientNewConnectionMs = performance.now() - warmClientStarted;
    proxy.interruptNextOperation();
    const interruptedStarted = performance.now();
    await expect(network.lookupLeasedIndex(request)).rejects.toThrow();
    const interruptedMs = performance.now() - interruptedStarted;
    const retryStarted = performance.now();
    expect(await network.lookupLeasedIndex(request)).toBe(operationBytes);
    const retryMs = performance.now() - retryStarted;
    expect(proxy.connections).toBe(4);
    expect(proxy.interruptions).toBe(1);
    expect(proxy.clientBytes).toBeGreaterThan(0);
    expect(proxy.relayBytes).toBeGreaterThan(0);
    console.log(`NETWORK_FAULT_QUALIFICATION ${JSON.stringify({
      test: 'lookup-exact-retry',
      profile: 'ordered TCP byte stream; 5ms forwarding latency and connection reset; no below-TCP impairment',
      connections: proxy.connections,
      failures: proxy.interruptions,
      successfulCalls: 3,
      clientBytes: proxy.clientBytes,
      relayBytes: proxy.relayBytes,
      latencyMs: {
        cold: coldMs,
        warmClientNewConnection: warmClientNewConnectionMs,
        interrupted: interruptedMs,
        exactRetry: retryMs,
      },
    })}`);
  }, 30_000);

  it('interrupts a warm content poll and completes exact request and response delivery after reconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resonance-client-held-warm-network-'));
    directories.push(root);
    const relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    const proxy = await TcpFaultProxy.start(relay.endpoint, 5);
    proxies.push(proxy);
    const network = client(proxy.endpoint);
    const ownerKeys = generateLeasedIndexKeyMaterialV1();
    const requesterKeys = generateLeasedIndexKeyMaterialV1();
    const original = new TextEncoder().encode('warm network original');
    const commitmentKey = generateOriginalCommitmentKeyV1();
    const index = createLeasedIndexV1({
      groupId: 'public',
      itemType: 'offer',
      derivationId: 'network-content-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1),
      originalCommitment: createOriginalCommitmentV1(original, commitmentKey),
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 86_400_000,
    }, ownerKeys);
    const owner = open(ContentGrantStore.open({
      path: join(root, 'owner.json'),
      encryptionKey: randomBytes(32),
    }));
    const requester = open(ContentGrantStore.open({
      path: join(root, 'requester.json'),
      encryptionKey: randomBytes(32),
    }));
    const channel = contentChannels(ownerKeys, requesterKeys, owner, requester);
    owner.retainOriginal(index, original, commitmentKey);
    const requestId = requester.createRequest({
      channelId: channel.channelId,
      index,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const requestOperation = requester.prepareRequest(requestId).operationBytes;
    const pollRequest = createContentPollRequestV1({
      channelId: channel.channelId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    }, channel.ownerRelationship);
    const interrupted = network.pollContent(pollRequest);
    await waitFor(() => proxy.connections === 1);
    const interruptedStarted = performance.now();
    expect(proxy.interruptConnections()).toBe(1);
    await expect(interrupted).rejects.toThrow();
    const interruptedMs = performance.now() - interruptedStarted;

    const ownerPoll = network.pollContent(pollRequest);
    await waitFor(() => proxy.connections === 2);
    const requestStarted = performance.now();
    expect((await network.sendContentOperation(requestOperation)).status).toBe('ok');
    const rawRequest = await ownerPoll;
    const warmRequestMs = performance.now() - requestStarted;
    expect(owner.receiveRequest(rawRequest, Date.now()).status).toBe('received');
    const grant = owner.grantRequest({
      requestId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    });
    const responseOperation = owner.prepareResponse(grant.grantId!).operationBytes;
    const requesterPoll = network.pollContent(createContentPollRequestV1({
      channelId: channel.channelId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    }, channel.requesterRelationship));
    await waitFor(() => proxy.connections === 4);
    const responseStarted = performance.now();
    expect((await network.sendContentOperation(responseOperation)).status).toBe('ok');
    const rawResponse = await requesterPoll;
    const warmResponseMs = performance.now() - responseStarted;
    const received = requester.receiveResponse(rawResponse, Date.now());
    expect(new TextDecoder().decode(received.originalBytes)).toBe('warm network original');
    expect(proxy.interruptions).toBe(1);
    expect(proxy.connections).toBe(5);
    console.log(`NETWORK_FAULT_QUALIFICATION ${JSON.stringify({
      test: 'warm-content-poll-reset',
      profile: 'ordered TCP byte stream; 5ms forwarding latency and connection reset; no below-TCP impairment',
      connections: proxy.connections,
      failures: proxy.interruptions,
      successfulCalls: 4,
      clientBytes: proxy.clientBytes,
      relayBytes: proxy.relayBytes,
      latencyMs: {
        interruptedWarmPoll: interruptedMs,
        warmRequestDelivery: warmRequestMs,
        warmResponseDelivery: warmResponseMs,
      },
      exactPollRetry: true,
      deliveredOriginal: true,
    })}`);
  }, 30_000);
});
