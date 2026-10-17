/** Prepare frozen, complete recovery evidence. Does not allocate or activate a successor writer. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { createHistoryFreeze, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest,
  parseHistoryCheckpointContext, parseHistoryFreeze, type HistoryCheckpointContext,
  type HistoryCheckpointEnvelope, type HistoryFreeze } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeRequest, parseHistoryExchangeResponse,
  parseHistoryRecoveryPreparation, HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES,
  type HistoryExchangeResponse, type HistoryRecoveryPreparation } from '@resonance/core/history-exchange';
import { parseHistoryCompactionAttestation, parseHistoryCompactionCertificate,
  type HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { exchangeHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export const HISTORY_RECOVERY_FILENAME = 'history-recovery.json';
interface RecoveryAttempt { freeze: HistoryFreeze; issuedAt: number; expiresAt: number }
interface RecoveryState {
  version: 1; contextId: string; rootId: string; generation: number; nextGeneration: number;
  attempt: RecoveryAttempt | null; prepared: HistoryRecoveryPreparation | null;
  compaction?: { genesisId: string; certificate: HistoryCompactionCertificate };
}

export function createHistoryCheckpointRecovery(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  rootId: string; generation: number;
  /** Owner-requested barrier only. This number is not an allocated writer generation. */
  nextGeneration: number;
  members: HistoryReplicaEndpoint[]; initialize?: boolean; timeoutMs?: number; transport?: HistoryCheckpointTransport;
  /** Explicit independently retained genesis and certified prefix. Never inferred from a relay response. */
  compaction?: { genesisId: string; certificate: unknown };
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const { rootId, generation, nextGeneration } = options;
  const timeoutMs = options.timeoutMs ?? 30_000, transport = options.transport ?? exchangeHistoryCheckpoint;
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!isHistoryDigest(rootId) || !integer(generation) || !integer(nextGeneration) || nextGeneration <= generation
    || !integer(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000 || options.members.length !== 5) {
    throw new Error('Invalid history recovery configuration');
  }
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown history recovery replica');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('History recovery needs five distinct pinned members and endpoints');
  }
  let compaction: RecoveryState['compaction'];
  if (options.compaction !== undefined) {
    if (!exactWitnessFields(options.compaction, ['genesisId', 'certificate'])) throw new Error('Invalid compacted recovery pins');
    const certificate = parseHistoryCompactionAttestation(options.compaction.certificate, context, options.compaction.genesisId);
    if (certificate.proposal.rootId !== rootId || certificate.proposal.generation !== generation) {
      throw new Error('Compacted recovery proof belongs to another generation');
    }
    compaction = { genesisId: options.compaction.genesisId, certificate };
  }
  const start = compaction?.certificate.proposal.sequence ?? 0;
  function valid(value: unknown): value is RecoveryState {
    if (!exactWitnessFields(value, ['version', 'contextId', 'rootId', 'generation', 'nextGeneration', 'attempt', 'prepared', ...(compaction ? ['compaction'] : [])])
      || value.version !== 1 || value.contextId !== contextId || value.rootId !== rootId
      || value.generation !== generation || value.nextGeneration !== nextGeneration
      || JSON.stringify(value.compaction) !== JSON.stringify(compaction)) return false;
    try {
      if (value.attempt !== null) {
        if (!exactWitnessFields(value.attempt, ['freeze', 'issuedAt', 'expiresAt'])
          || !integer(value.attempt.issuedAt) || !integer(value.attempt.expiresAt)
          || value.attempt.expiresAt <= value.attempt.issuedAt || value.attempt.expiresAt - value.attempt.issuedAt > 30_000) return false;
        const freeze = parseHistoryFreeze(value.attempt.freeze, context);
        if (freeze.generation !== generation || freeze.nextGeneration !== nextGeneration) return false;
      }
      if (value.prepared !== null) {
        const prepared = parseHistoryRecoveryPreparation(value.prepared, context, compaction?.genesisId);
        if (prepared.rootId !== rootId || prepared.generation !== generation || prepared.nextGeneration !== nextGeneration
          || JSON.stringify(prepared.compaction) !== JSON.stringify(compaction?.certificate)) return false;
      }
      return true;
    } catch { return false; }
  }
  const key = copyAdmissionSigningKey(options.signingKey);
  let storage: ReturnType<typeof openEncryptedLocalState<RecoveryState>>;
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history recovery owner');
    storage = openEncryptedLocalState<RecoveryState>({ path: join(options.directory, HISTORY_RECOVERY_FILENAME),
      key: options.localKey, domain: 'resonance:history-checkpoint-recovery:v1', maxBytes: 96 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing', validate: valid,
      initial: { version: 1, contextId, rootId, generation, nextGeneration, attempt: null, prepared: null,
        ...(compaction ? { compaction } : {}) } });
  } catch (error) { key.secretKey.fill(0); throw error; }
  let closed = false, active: AbortController | undefined;
  return {
    /** Historical evidence; reopening never sends requests or resumes writes. */
    read(): RecoveryState { return structuredClone(storage.read()); },
    async prepare(): Promise<HistoryRecoveryPreparation> {
      const state = storage.read();
      if (closed) throw new Error('History recovery is closed');
      if (active) throw new Error('History recovery already has an active attempt');
      const started = performance.now(), issuedAt = Date.now(), expiresAt = issuedAt + timeoutMs;
      const controller = new AbortController(); active = controller;
      const live = () => {
        if (closed || controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) {
          throw new Error('History recovery cancelled or timed out');
        }
      };
      try {
        const freeze = createHistoryFreeze(context, generation, nextGeneration, randomBytes(32).toString('base64url'), key);
        // A failed attempt may have frozen some volunteers. Persist the intent first and never undo a barrier.
        storage.write({ ...state, attempt: { freeze, issuedAt, expiresAt } });
        live();
        const baseline = state.prepared?.envelopes.map(historyCheckpointEnvelopeId) ?? [];
        const result = await new Promise<HistoryRecoveryPreparation>((resolve, reject) => {
          let settled = false, remaining = 5;
          const receipts: HistoryExchangeResponse[] = [];
          let selected: HistoryCheckpointEnvelope[] = [], selectedIds: string[] = [];
          const finish = (prepared?: HistoryRecoveryPreparation, error?: Error) => {
            if (settled) return; settled = true;
            clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort();
            if (error) reject(error); else resolve(prepared!);
          };
          const abort = () => finish(undefined, new Error('History recovery cancelled'));
          const timer = setTimeout(() => finish(undefined, new Error('Four complete frozen histories unavailable')),
            Math.max(1, timeoutMs - (performance.now() - started)));
          controller.signal.addEventListener('abort', abort, { once: true });
          async function collect(member: HistoryReplicaEndpoint) {
            async function request(action: 'freeze' | 'read', sequence: number) {
              live();
              const original = createHistoryExchangeRequest({ action, rootId, generation, replica: member.publicKey,
                sequence, envelopeId: null, challenge: freeze.challenge, issuedAt, expiresAt }, context, key);
              live();
              const raw = await transport(member, { request: structuredClone(original), envelope: null,
                ...(action === 'freeze' ? { freeze: structuredClone(freeze) } : {}) }, controller.signal);
              live();
              const response = parseHistoryExchangeResponse(raw, original, context);
              parseHistoryExchangeRequest(original, context, Date.now()); live();
              return response;
            }
            const receipt = await request('freeze', nextGeneration), head = receipt.head;
            if (head.sequence >= HISTORY_RECOVERY_MAX_BLOCKS) throw new Error('History recovery block capacity exceeded');
            const envelopes: HistoryCheckpointEnvelope[] = [], ids: string[] = [];
            let bytes = 0;
            for (let sequence = start; sequence <= head.sequence; sequence++) {
              const response = await request('read', sequence), block = response.envelope;
              // The payload is immutable after freeze. A higher concurrent barrier supersedes this round.
              if (response.head.sequence !== head.sequence || response.head.envelopeId !== head.envelopeId
                || response.head.freeze?.nextGeneration !== nextGeneration || !block) throw new Error('Frozen history changed or is incomplete');
              bytes += Buffer.byteLength(JSON.stringify(block));
              if (bytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('History recovery byte capacity exceeded');
              const id = historyCheckpointEnvelopeId(block);
              if (sequence === start && compaction) parseHistoryCompactionCertificate(compaction.certificate, context, compaction.genesisId, block);
              else if (block.previous !== (ids.at(-1) ?? null) || (!sequence && id !== rootId)) {
                throw new Error('Incomplete or conflicting frozen history');
              }
              envelopes.push(block); ids.push(id); live();
            }
            if (head.sequence >= start && ids.at(-1) !== head.envelopeId) throw new Error('Frozen history head does not match payload');
            return { receipt, envelopes, ids };
          }
          members.forEach(member => {
            void Promise.resolve().then(() => collect(member)).then(candidate => {
              if (settled) return;
              live();
              const compatible = (ids: string[]) => ids.slice(0, candidate.ids.length).every((id, i) => id === candidate.ids[i]);
              if (!compatible(selectedIds) || !compatible(baseline)) {
                finish(undefined, new Error('Authenticated recovery histories conflict')); return;
              }
              receipts.push(candidate.receipt);
              if (candidate.ids.length > selectedIds.length) { selected = candidate.envelopes; selectedIds = candidate.ids; }
              if (receipts.length === 4) {
                if (selectedIds.length < baseline.length) { finish(undefined, new Error('Recovery would regress retained evidence')); return; }
                try {
                  finish(parseHistoryRecoveryPreparation({ version: 1, kind: 'frozen-history', rootId, generation,
                    nextGeneration, receipts, envelopes: selected, ...(compaction ? { compaction: compaction.certificate } : {}) }, context, compaction?.genesisId));
                } catch (error) { finish(undefined, error instanceof Error ? error : new Error('Invalid frozen history preparation')); }
              }
            }).catch(() => {}).finally(() => {
              if (!settled && receipts.length + --remaining < 4) finish(undefined, new Error('Four complete frozen histories unavailable'));
            });
          });
        });
        // Collection aborts the unused socket. Still enforce close and both clocks before and after fsync.
        const timely = () => {
          if (closed || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) throw new Error('History recovery completed too late');
        };
        timely();
        storage.write({ ...storage.read(), attempt: null, prepared: result });
        timely();
        return structuredClone(result);
      } finally { controller.abort(); if (active === controller) active = undefined; }
    },
    close() { if (!closed) { closed = true; active?.abort(); storage.close(); key.secretKey.fill(0); } },
  };
}
