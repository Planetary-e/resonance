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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function benchmarkChannelFlow(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-eval-publication-'));
  const server = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    persistDir: directory,
    maxAuthAttemptsPerMin: 100,
    persistIntervalMs: 999_999,
  });
  try {
    await server.start();
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
      relayUrl: `ws://127.0.0.1:${server.getListeningPort()!}`,
      identity: generateIdentity(),
    });

    const acceptanceCpuStart = process.cpuUsage();
    const { durationMs: firstAcceptanceMs } = await timeAsync(async () => {
      const ack = await client.submitPublicationOperation(offer);
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'publication rejected');
    });
    const acceptanceCpu = process.cpuUsage(acceptanceCpuStart);
    const matchingCpuStart = process.cpuUsage();
    const { durationMs: matchingMs } = await timeAsync(async () => {
      const ack = await client.submitPublicationOperation(need);
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'publication rejected');
    });
    const matchingCpu = process.cpuUsage(matchingCpuStart);
    const cpuMs = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000;
    const stats = server.getStats();

    return [
      {
        name: 'Persisted v2 publication acceptance',
        target: '<500ms',
        actual: `${formatMs(firstAcceptanceMs)} (CPU ${formatMs(cpuMs(acceptanceCpu))})`,
        value: firstAcceptanceMs,
        passed: firstAcceptanceMs < 500,
        details: { wallMs: firstAcceptanceMs, processCpuMs: cpuMs(acceptanceCpu), durable: true },
      },
      {
        name: 'V2 publication → durable encrypted match',
        target: '<500ms',
        actual: `${formatMs(matchingMs)} (CPU ${formatMs(cpuMs(matchingCpu))})`,
        value: matchingMs,
        passed: matchingMs < 500 && stats.matches_today > 0 && stats.mailbox_envelopes === 2,
        details: { wallMs: matchingMs, processCpuMs: cpuMs(matchingCpu), durable: true,
          matches: stats.matches_today, mailboxEnvelopes: stats.mailbox_envelopes },
      },
    ];
  } finally {
    try { await server.stop(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
