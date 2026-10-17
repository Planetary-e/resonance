/** Fresh current-head collection. These receipts are not write certificates. */
import { randomBytes } from 'node:crypto';
import type { SigningKeyPair } from '@resonance/core';
import { historyCheckpointEnvelopeId, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse, type HistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryWriterRepair } from './history-writer-repair.js';
import type { HistoryWriterRepairSource } from './history-writer-prefix.js';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

/** Internal writer composition: caller owns keys, pins, serialization and closure. */
export async function collectCurrentHistoryHead(options: {
  context: HistoryCheckpointContext; key: SigningKeyPair; rootId: string; block: HistoryCheckpointEnvelope;
  members: HistoryReplicaEndpoint[]; transport: HistoryCheckpointTransport; timeoutMs: number;
  controller: AbortController; isClosed: () => boolean; retained?: () => HistoryWriterRepairSource;
}): Promise<HistoryExchangeResponse[]> {
  const { context, key, rootId, block, members, transport, timeoutMs, controller } = options;
  const started = performance.now(), issuedAt = Date.now(), expiresAt = issuedAt + timeoutMs;
  const challenge = randomBytes(32).toString('base64url'), id = historyCheckpointEnvelopeId(block);
  function live() {
    if (options.isClosed() || controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) {
      throw new Error('Current history observation cancelled or timed out');
    }
  }
  live();
  const repair = options.retained ? createHistoryWriterRepair({ context, key, rootId, block, transport,
    retained: options.retained, challenge, issuedAt, expiresAt, live }) : undefined;
  const receipts = await new Promise<HistoryExchangeResponse[]>((resolve, reject) => {
    let settled = false, remaining = 5; const received: HistoryExchangeResponse[] = [];
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
      controller.abort(); if (error) reject(error); else resolve(received);
    };
    const abort = () => finish(new Error('Current history observation cancelled'));
    const timer = setTimeout(() => finish(new Error('Four current history heads unavailable')),
      Math.max(1, timeoutMs - (performance.now() - started)));
    controller.signal.addEventListener('abort', abort, { once: true });
    members.forEach(member => {
      void Promise.resolve().then(async () => {
        live();
        if (repair) return repair.synchronize(member, controller.signal, true);
        const request = createHistoryExchangeRequest({ action: 'head', rootId, generation: block.generation,
          replica: member.publicKey, challenge, issuedAt, expiresAt, sequence: 0, envelopeId: null }, context, key);
        const response = await transport(member, { request, envelope: null }, controller.signal);
        live(); return parseHistoryExchangeResponse(response, request, context);
      }).then(response => {
        if (settled) return; live();
        if (response.head.freeze || response.head.sequence !== block.sequence || response.head.envelopeId !== id
          || response.request.replica !== member.publicKey || response.request.challenge !== challenge) throw new Error('Replica has a different current history head');
        received.push(response); if (received.length === 4) finish();
      }).catch(() => {}).finally(() => {
        if (!settled && received.length + --remaining < 4) finish(new Error('Four current history heads unavailable'));
      });
    });
  });
  // Successful collection aborts only outstanding work. This final check must
  // still reject closure, event-loop delay or wall-clock expiry after the fourth.
  if (options.isClosed() || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) throw new Error('Current history observation completed too late');
  return receipts;
}
