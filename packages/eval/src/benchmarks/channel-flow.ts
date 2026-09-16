import {
  createPublicationRecord,
  generateIdentity,
  generatePublicationKeyMaterial,
  getSharedProjectionMatrix,
  hashEmbedding,
  type BenchmarkResult,
  type EmbeddingEngine,
} from '@resonance/core';
import { createRelayServer } from '@resonance/relay';
import { createRelayClient } from '@resonance/node';
import { formatMs, timeAsync } from '../utils.js';

const PORT = 49090 + Math.floor(Math.random() * 1000);

export async function benchmarkChannelFlow(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const server = createRelayServer({
    port: PORT,
    host: '127.0.0.1',
    persistDir: `/tmp/resonance-eval-publication-${Date.now()}`,
    maxAuthAttemptsPerMin: 100,
    persistIntervalMs: 999_999,
  });
  await server.start();

  try {
    const offerEmbedding = await engine.embedForMatching(
      'Python developer available for Django projects',
      'offer',
    );
    const needEmbedding = await engine.embedForMatching(
      'Looking for a Python developer for Django backend',
      'need',
    );
    const matrix = getSharedProjectionMatrix();
    const now = Date.now();
    const offer = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: hashEmbedding(offerEmbedding, matrix),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, generatePublicationKeyMaterial());
    const need = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: hashEmbedding(needEmbedding, matrix),
      itemType: 'need',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, generatePublicationKeyMaterial());

    // The identity remains a local-store key source for this API generation;
    // submitPublicationOperation does not transmit it.
    const client = createRelayClient({
      relayUrl: `ws://localhost:${PORT}`,
      identity: generateIdentity(),
    });

    const { durationMs: firstAcceptanceMs } = await timeAsync(async () => {
      const ack = await client.submitPublicationOperation(offer);
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'publication rejected');
    });
    const { durationMs: matchingMs } = await timeAsync(async () => {
      const ack = await client.submitPublicationOperation(need);
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'publication rejected');
    });

    return [
      {
        name: 'Persisted v2 publication acceptance',
        target: '<500ms',
        actual: formatMs(firstAcceptanceMs),
        value: firstAcceptanceMs,
        passed: firstAcceptanceMs < 500,
      },
      {
        name: 'V2 publication → match indexing',
        target: '<500ms',
        actual: formatMs(matchingMs),
        value: matchingMs,
        passed: matchingMs < 500 && server.getStats().matches_today > 0,
      },
    ];
  } finally {
    await server.stop();
  }
}
