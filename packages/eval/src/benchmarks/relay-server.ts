import {
  createPublicationRecord,
  generateIdentity,
  generatePublicationKeyMaterial,
  type BenchmarkResult,
} from '@resonance/core';
import { createRelayClient } from '@resonance/node';
import { createRelayServer } from '@resonance/relay';
import { randomBytes } from 'node:crypto';
import { timeAsync, formatMs } from '../utils.js';

const PORT = 29090 + Math.floor(Math.random() * 1000);

function publication(itemType: 'need' | 'offer', fingerprint: Uint8Array, groupId: string) {
  const now = Date.now();
  return createPublicationRecord({
    groupId,
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint,
    itemType,
    createdAt: now,
    expiresAt: now + 86_400_000,
  }, generatePublicationKeyMaterial());
}

export async function benchmarkRelayServer(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const server = createRelayServer({
    port: PORT,
    host: '127.0.0.1',
    persistDir: `/tmp/resonance-eval-relay-${Date.now()}`,
    maxAuthAttemptsPerMin: 100,
    persistIntervalMs: 999_999,
  });
  await server.start();

  try {
    const client = createRelayClient({
      relayUrl: `ws://localhost:${PORT}`,
      identity: generateIdentity(),
    });
    const groupId = `relay-eval-${Date.now()}`;
    const fingerprint = new Uint8Array(64).fill(0x5a);

    const { durationMs: publicationMs } = await timeAsync(async () => {
      const ack = await client.submitPublicationOperation(publication('offer', fingerprint, groupId));
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'publication rejected');
    });
    results.push({
      name: 'Relay v2 publication round-trip', target: '<500ms', actual: formatMs(publicationMs),
      value: publicationMs, passed: publicationMs < 500,
    });

    const { durationMs: matchMs } = await timeAsync(async () => {
      const ack = await client.submitPublicationOperation(publication('need', fingerprint, groupId));
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'publication rejected');
    });
    results.push({
      name: 'V2 match and encrypted mailbox creation', target: '<500ms', actual: formatMs(matchMs),
      value: matchMs, passed: matchMs < 500 && server.getStats().mailbox_envelopes === 2,
    });

    const { MatchingEngine } = await import('@resonance/relay');
    const engine = new MatchingEngine();
    engine.initialize();
    for (let i = 0; i < 1000; i++) {
      const hash = randomBytes(64);
      engine.insertAndMatch(hash, {
        did: `pub_bench-${i}`,
        itemType: i % 2 === 0 ? 'need' : 'offer',
        itemId: `item-${i}`,
        scope: 'eval\nrandom:512:v1',
      }, 1, 0.99, false);
    }

    const dir = `/tmp/resonance-eval-persist-${Date.now()}`;
    const { durationMs: saveMs } = await timeAsync(async () => engine.save(dir));
    const engine2 = new MatchingEngine();
    engine2.initialize();
    const { durationMs: loadMs } = await timeAsync(async () => engine2.load(dir));
    results.push({
      name: 'Index save (1K fingerprints)', target: '<1s', actual: formatMs(saveMs),
      value: saveMs, passed: saveMs < 1000,
    });
    results.push({
      name: 'Index load (1K fingerprints)', target: '<2s', actual: formatMs(loadMs),
      value: loadMs, passed: loadMs < 2000,
    });
    const { rmSync } = await import('node:fs');
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  } finally {
    await server.stop();
  }

  return results;
}
