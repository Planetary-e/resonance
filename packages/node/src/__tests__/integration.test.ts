/**
 * End-to-end integration test for Phase 4:
 * publish → match → consent → channel → confirm → disclosure → close
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nacl from 'tweetnacl';
import {
  generateIdentity,
  EmbeddingEngine,
  perturbWithLevel,
  hashEmbedding,
  getSharedProjectionMatrix,
  encodeBase64,
  normalize,
  type MatchPayload,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { openStoreAsync, type LocalStore } from '../store.js';
import { createRelayClient } from '../relay-client.js';
import { createChannelManager, type ChannelManager } from '../channel.js';

const PORT = 39090 + Math.floor(Math.random() * 1000);
let server: RelayServer;
let engine: EmbeddingEngine;

beforeAll(async () => {
  server = createRelayServer({
    port: PORT,
    host: '127.0.0.1',
    persistDir: `/tmp/resonance-e2e-${Date.now()}`,
    maxAuthAttemptsPerMin: 100,
    persistIntervalMs: 999_999,
  });
  await server.start();

  engine = new EmbeddingEngine();
  await engine.initialize();
}, 30_000);

afterAll(async () => {
  await server.stop();
});

async function createInMemoryStore(): Promise<LocalStore> {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  return openStoreAsync(':memory:', key);
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('Phase 4 end-to-end', () => {
  it('full flow: publish → match → consent → confirm → disclosure → close', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceStore = await createInMemoryStore();
    const bobStore = await createInMemoryStore();

    // Embed complementary texts
    const offerText = 'Experienced Python developer available for freelance Django projects';
    const needText = 'Looking for a Python developer for our Django backend';
    const offerEmbedding = await engine.embedForMatching(offerText, 'offer');
    const needEmbedding = await engine.embedForMatching(needText, 'need');
    const offerPerturbed = perturbWithLevel(offerEmbedding, 'medium');
    const needPerturbed = perturbWithLevel(needEmbedding, 'medium');

    // Store items locally
    aliceStore.insertItem({
      id: 'alice-offer',
      type: 'offer',
      rawText: offerText,
      embedding: offerEmbedding,
      privacyLevel: 'medium',
      perturbed: offerPerturbed.perturbed,
      epsilon: offerPerturbed.epsilon,
    });
    bobStore.insertItem({
      id: 'bob-need',
      type: 'need',
      rawText: needText,
      embedding: needEmbedding,
      privacyLevel: 'medium',
      perturbed: needPerturbed.perturbed,
      epsilon: needPerturbed.epsilon,
    });

    // Create relay clients
    const aliceClient = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity: alice });
    const bobClient = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity: bob });

    // Track match notifications
    let aliceMatchPayload: MatchPayload | null = null;
    let bobMatchPayload: MatchPayload | null = null;
    const aliceGotMatch = new Promise<void>(r => {
      aliceClient.on({ onMatch: (p) => { aliceMatchPayload = p; r(); } });
    });
    const bobGotMatch = new Promise<void>(r => {
      bobClient.on({ onMatch: (p) => { bobMatchPayload = p; r(); } });
    });

    await aliceClient.connect();
    await bobClient.connect();

    // Alice publishes offer (LSH hash)
    const matrix = getSharedProjectionMatrix();
    await aliceClient.publish({
      itemId: 'alice-offer',
      hash: encodeBase64(hashEmbedding(offerEmbedding, matrix)),
      itemType: 'offer',
      ttl: 86400,
    });

    // Bob publishes need — should trigger match
    await bobClient.publish({
      itemId: 'bob-need',
      hash: encodeBase64(hashEmbedding(needEmbedding, matrix)),
      itemType: 'need',
      ttl: 86400,
    });

    // Wait for match notifications
    await Promise.all([aliceGotMatch, bobGotMatch]);
    expect(aliceMatchPayload).not.toBeNull();
    expect(bobMatchPayload).not.toBeNull();
    expect(aliceMatchPayload!.matchId).toBe(bobMatchPayload!.matchId);

    // Store matches locally
    aliceStore.insertMatch({
      id: aliceMatchPayload!.matchId,
      itemId: 'alice-offer',
      partnerDID: aliceMatchPayload!.partnerDID,
      similarity: aliceMatchPayload!.similarity,
    });
    bobStore.insertMatch({
      id: bobMatchPayload!.matchId,
      itemId: 'bob-need',
      partnerDID: bobMatchPayload!.partnerDID,
      similarity: bobMatchPayload!.similarity,
    });

    // Create channel managers
    const aliceChannelMgr = createChannelManager({
      identity: alice,
      store: aliceStore,
      relayClient: aliceClient,
    });
    const bobChannelMgr = createChannelManager({
      identity: bob,
      store: bobStore,
      relayClient: bobClient,
    });

    // Track channel events
    let aliceChannelId: string | null = null;
    let bobChannelId: string | null = null;
    let aliceConfirmResult: { similarity: number; confirmed: boolean } | null = null;
    let bobConfirmResult: { similarity: number; confirmed: boolean } | null = null;
    let aliceDisclosure: { text: string; level: string } | null = null;
    let bobDisclosure: { text: string; level: string } | null = null;

    const aliceReady = new Promise<void>(r => {
      aliceChannelMgr.on({
        onChannelReady(id) { aliceChannelId = id; r(); },
        onConfirmResult(id, sim, conf) { aliceConfirmResult = { similarity: sim, confirmed: conf }; },
        onDisclosure(id, text, level) { aliceDisclosure = { text, level }; },
      });
    });
    const bobReady = new Promise<void>(r => {
      bobChannelMgr.on({
        onChannelReady(id) { bobChannelId = id; r(); },
        onConfirmResult(id, sim, conf) { bobConfirmResult = { similarity: sim, confirmed: conf }; },
        onDisclosure(id, text, level) { bobDisclosure = { text, level }; },
      });
    });

    // Wire relay events to channel managers
    aliceClient.on({
      onConsentForward: (p) => aliceChannelMgr.handleConsentForward(p),
      onChannelForward: (p) => aliceChannelMgr.handleChannelForward(p),
    });
    bobClient.on({
      onConsentForward: (p) => bobChannelMgr.handleConsentForward(p),
      onChannelForward: (p) => bobChannelMgr.handleChannelForward(p),
    });

    // Alice initiates channel
    await aliceChannelMgr.initiateChannel(aliceMatchPayload!.matchId, bob.did);

    // Wait for both sides to be ready
    await Promise.all([aliceReady, bobReady]);
    expect(aliceChannelId).not.toBeNull();
    expect(bobChannelId).not.toBeNull();

    // Both send confirm embedding
    await aliceChannelMgr.sendConfirmEmbedding(aliceChannelId!, offerEmbedding);
    await bobChannelMgr.sendConfirmEmbedding(bobChannelId!, needEmbedding);

    // Wait for confirmation to propagate
    await delay(200);

    expect(aliceConfirmResult).not.toBeNull();
    expect(aliceConfirmResult!.confirmed).toBe(true);
    expect(aliceConfirmResult!.similarity).toBeGreaterThan(0.5);

    // Alice sends disclosure
    await aliceChannelMgr.sendDisclosure(aliceChannelId!, 'Backend development, Django/Python', 'category');
    await delay(100);
    expect(bobDisclosure).not.toBeNull();
    expect(bobDisclosure!.text).toBe('Backend development, Django/Python');
    expect(bobDisclosure!.level).toBe('category');

    // Bob sends disclosure back
    await bobChannelMgr.sendDisclosure(bobChannelId!, 'Web startup, need backend API', 'category');
    await delay(100);
    expect(aliceDisclosure).not.toBeNull();
    expect(aliceDisclosure!.text).toBe('Web startup, need backend API');

    // Close
    await aliceChannelMgr.sendClose(aliceChannelId!);
    await delay(100);

    // Cleanup
    aliceClient.disconnect();
    bobClient.disconnect();
    aliceStore.close();
    bobStore.close();
  }, 30_000);
});
