import type { BenchmarkResult } from '@resonance/core';
import {
  generateIdentity,
  EmbeddingEngine,
  perturbWithLevel,
  normalize,
  type MatchPayload,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { openStoreAsync } from '@resonance/node';
import { createRelayClient } from '@resonance/node';
import { createChannelManager } from '@resonance/node';
import nacl from 'tweetnacl';
import { timeAsync, formatMs } from '../utils.js';

const PORT = 49090 + Math.floor(Math.random() * 1000);

async function makeStore() {
  return openStoreAsync(':memory:', nacl.randomBytes(nacl.secretbox.keyLength));
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function benchmarkChannelFlow(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const port = PORT;

  const server = createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir: `/tmp/resonance-eval-channel-${Date.now()}`,
    persistIntervalMs: 999_999,
  });
  await server.start();

  try {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const aliceStore = await makeStore();
    const bobStore = await makeStore();

    // Embed complementary texts
    const offerEmb = await engine.embedForMatching('Python developer available for Django projects', 'offer');
    const needEmb = await engine.embedForMatching('Looking for a Python developer for Django backend', 'need');
    const offerP = perturbWithLevel(offerEmb, 'medium');
    const needP = perturbWithLevel(needEmb, 'medium');

    // Store items
    aliceStore.insertItem({ id: 'o1', type: 'offer', rawText: 'offer', embedding: offerEmb, privacyLevel: 'medium', perturbed: offerP.perturbed, epsilon: offerP.epsilon });
    bobStore.insertItem({ id: 'n1', type: 'need', rawText: 'need', embedding: needEmb, privacyLevel: 'medium', perturbed: needP.perturbed, epsilon: needP.epsilon });

    const aliceClient = createRelayClient({ relayUrl: `ws://localhost:${port}`, identity: alice });
    const bobClient = createRelayClient({ relayUrl: `ws://localhost:${port}`, identity: bob });

    let aliceMatch: MatchPayload | null = null;
    let bobMatch: MatchPayload | null = null;

    const aliceGotMatch = new Promise<void>(r => { aliceClient.on({ onMatch: p => { aliceMatch = p; r(); } }); });
    const bobGotMatch = new Promise<void>(r => { bobClient.on({ onMatch: p => { bobMatch = p; r(); } }); });

    await aliceClient.connect();
    await bobClient.connect();

    // --- Measure: publish → match notification ---
    await aliceClient.publish({ itemId: 'o1', vector: Array.from(offerP.perturbed), itemType: 'offer', ttl: 86400 });

    const { durationMs: matchLatency } = await timeAsync(async () => {
      await bobClient.publish({ itemId: 'n1', vector: Array.from(needP.perturbed), itemType: 'need', ttl: 86400 });
      await Promise.all([aliceGotMatch, bobGotMatch]);
    });

    results.push({
      name: 'Publish → match notification',
      target: '<500ms',
      actual: formatMs(matchLatency),
      value: matchLatency,
      passed: matchLatency < 500,
    });

    // Store matches
    aliceStore.insertMatch({ id: aliceMatch!.matchId, itemId: 'o1', partnerDID: alice.did === aliceMatch!.partnerDID ? bob.did : aliceMatch!.partnerDID, similarity: aliceMatch!.similarity });
    bobStore.insertMatch({ id: bobMatch!.matchId, itemId: 'n1', partnerDID: bob.did === bobMatch!.partnerDID ? alice.did : bobMatch!.partnerDID, similarity: bobMatch!.similarity });

    // --- Measure: consent handshake ---
    const aliceChannelMgr = createChannelManager({ identity: alice, store: aliceStore, relayClient: aliceClient });
    const bobChannelMgr = createChannelManager({ identity: bob, store: bobStore, relayClient: bobClient });

    let aliceChId: string | null = null;
    let bobChId: string | null = null;
    const aliceReady = new Promise<void>(r => { aliceChannelMgr.on({ onChannelReady: (id) => { aliceChId = id; r(); } }); });
    const bobReady = new Promise<void>(r => { bobChannelMgr.on({ onChannelReady: (id) => { bobChId = id; r(); } }); });

    aliceClient.on({
      onConsentForward: p => aliceChannelMgr.handleConsentForward(p),
      onChannelForward: p => aliceChannelMgr.handleChannelForward(p),
    });
    bobClient.on({
      onConsentForward: p => bobChannelMgr.handleConsentForward(p),
      onChannelForward: p => bobChannelMgr.handleChannelForward(p),
    });

    const { durationMs: handshakeMs } = await timeAsync(async () => {
      await aliceChannelMgr.initiateChannel(aliceMatch!.matchId, bob.did);
      await Promise.all([aliceReady, bobReady]);
    });

    results.push({
      name: 'Consent handshake latency',
      target: '<500ms',
      actual: formatMs(handshakeMs),
      value: handshakeMs,
      passed: handshakeMs < 500,
    });

    // --- Measure: confirm embedding round-trip ---
    let aliceConfirmed = false;
    let bobConfirmed = false;
    const aliceConfirmDone = new Promise<void>(r => {
      aliceChannelMgr.on({ onConfirmResult: (id, sim, conf) => { aliceConfirmed = conf; r(); } });
    });
    const bobConfirmDone = new Promise<void>(r => {
      bobChannelMgr.on({ onConfirmResult: (id, sim, conf) => { bobConfirmed = conf; r(); } });
    });

    const { durationMs: confirmMs } = await timeAsync(async () => {
      await aliceChannelMgr.sendConfirmEmbedding(aliceChId!, offerEmb);
      await bobChannelMgr.sendConfirmEmbedding(bobChId!, needEmb);
      await Promise.all([aliceConfirmDone, bobConfirmDone]);
    });

    results.push({
      name: 'Confirmation round-trip',
      target: '<500ms',
      actual: `${formatMs(confirmMs)} (confirmed: ${aliceConfirmed})`,
      value: confirmMs,
      passed: confirmMs < 500 && aliceConfirmed,
    });

    // --- Measure: disclosure round-trip ---
    let disclosureReceived = false;
    const disclosureDone = new Promise<void>(r => {
      bobChannelMgr.on({ onDisclosure: () => { disclosureReceived = true; r(); } });
    });

    const { durationMs: disclosureMs } = await timeAsync(async () => {
      await aliceChannelMgr.sendDisclosure(aliceChId!, 'Backend development', 'category');
      await disclosureDone;
    });

    results.push({
      name: 'Channel message round-trip',
      target: '<200ms',
      actual: formatMs(disclosureMs),
      value: disclosureMs,
      passed: disclosureMs < 200,
    });

    // Cleanup
    aliceClient.disconnect();
    bobClient.disconnect();
    aliceStore.close();
    bobStore.close();

  } finally {
    await server.stop();
  }

  return results;
}
