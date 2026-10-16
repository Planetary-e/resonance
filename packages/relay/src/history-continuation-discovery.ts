/** Read-only traversal from an independent genesis pin. Discovery never authorizes a writer. */
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, isHistoryDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryExchangeRequest, parseHistoryExchangeRequest, parseHistoryExchangeResponse, type HistoryExchangeResponse } from '@resonance/core/history-exchange';
import { exchangeHistoryCheckpoint, HISTORY_CONTINUATION_RESPONSE_MAX_BYTES, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export interface HistoryContinuationDiscovery {
  version: 1; contextId: string; genesisId: string; continuations: HistoryContinuationRoot[];
  /** Four observations of no activated child, not proof that no prepared/confirmed decision exists. */
  observedLeaf: { rootId: string; generation: number; receipts: HistoryExchangeResponse[] };
}

export async function discoverHistoryContinuations(options: {
  context: HistoryCheckpointContext; genesisId: string; signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[];
  transport?: HistoryCheckpointTransport; signal?: AbortSignal; timeoutMs?: number; maxGenerations?: number;
}): Promise<HistoryContinuationDiscovery> {
  const context = parseHistoryCheckpointContext(options.context), timeoutMs = options.timeoutMs ?? 30_000;
  const maxGenerations = options.maxGenerations ?? 65;
  if (!isHistoryDigest(options.genesisId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 65 || options.members.length !== 5) {
    throw new Error('Invalid continuation discovery bounds');
  }
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown history discovery member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('History discovery needs five distinct pinned members and endpoints');
  }
  const key = copyAdmissionSigningKey(options.signingKey), transport = options.transport ?? exchangeHistoryCheckpoint;
  const controller = new AbortController(), cancel = () => controller.abort();
  const deadline = performance.now() + timeoutMs, expiresAt = Date.now() + timeoutMs;
  const timer = setTimeout(cancel, timeoutMs); options.signal?.addEventListener('abort', cancel, { once: true });
  function live() {
    if (options.signal?.aborted || controller.signal.aborted || performance.now() >= deadline || Date.now() >= expiresAt) {
      throw new Error('History discovery cancelled or timed out');
    }
  }
  async function lookup(rootId: string, generation: number): Promise<HistoryContinuationRoot | HistoryExchangeResponse[]> {
    const challenge = randomBytes(32).toString('base64url'), issuedAt = Date.now(); live();
    return new Promise((resolve, reject) => {
      const group = new AbortController(), receipts: HistoryExchangeResponse[] = [];
      let settled = false, remaining = members.length;
      const finish = (value?: HistoryContinuationRoot | HistoryExchangeResponse[], error?: Error) => {
        if (settled) return; settled = true;
        controller.signal.removeEventListener('abort', abort); group.abort();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(undefined, new Error('History discovery cancelled or timed out'));
      controller.signal.addEventListener('abort', abort, { once: true });
      members.forEach(member => {
        void Promise.resolve().then(async () => {
          if (settled) return; live();
          const request = createHistoryExchangeRequest({ action: 'continuation', rootId, generation, replica: member.publicKey,
            challenge, issuedAt, expiresAt, sequence: 0, envelopeId: null }, context, key);
          const raw = await transport(member, { request: structuredClone(request), envelope: null }, group.signal);
          if (settled) return; live();
          if (Buffer.byteLength(JSON.stringify(raw) ?? '') > HISTORY_CONTINUATION_RESPONSE_MAX_BYTES) throw new Error('Oversized continuation response');
          const response = parseHistoryExchangeResponse(raw, request, context);
          parseHistoryExchangeRequest(request, context, Date.now()); live();
          if (response.envelope?.kind === 'continuation') finish(response.envelope);
          else { receipts.push(response); if (receipts.length === 4) finish(receipts); }
        }).catch(() => {}).finally(() => {
          if (!settled && --remaining === 0) finish(undefined, new Error('Four continuation observations or a certified child are unavailable'));
        });
      });
    });
  }
  try {
    live();
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history discovery owner');
    const continuations: HistoryContinuationRoot[] = [], visited = new Set([options.genesisId]);
    let rootId = options.genesisId, generation = 0;
    while (true) {
      const result = await lookup(rootId, generation); live();
      if (Array.isArray(result)) return { version: 1, contextId: historyCheckpointContextId(context), genesisId: options.genesisId,
        continuations, observedLeaf: { rootId, generation, receipts: result } };
      const childId = historyContinuationRootId(result);
      if (continuations.length + 1 >= maxGenerations || visited.has(childId)) throw new Error('History discovery ancestry capacity exceeded');
      continuations.push(result); visited.add(childId); rootId = childId; generation = result.generation;
    }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); controller.abort(); key.secretKey.fill(0); }
}
