/** Sequential owner-side checkpoint writes. Does not authorize live admission or activate a recovered generation. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest, parseHistoryCheckpointContext,
  parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse, parseHistoryWriteCertificate,
  type HistoryExchangeResponse, type HistoryWriteCertificate } from '@resonance/core/history-exchange';
import { exchangeHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export const HISTORY_WRITER_FILENAME = 'history-writer.json';
interface WriterState {
  version: 1; contextId: string; rootId: string; generation: number;
  committed: { envelope: HistoryCheckpointEnvelope; certificate: HistoryWriteCertificate } | null;
  pending: HistoryCheckpointEnvelope | null;
}

export function createHistoryCheckpointWriter(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  rootId: string; generation: number; members: HistoryReplicaEndpoint[]; initialize?: boolean;
  timeoutMs?: number; transport?: HistoryCheckpointTransport;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const { rootId, generation } = options;
  const timeoutMs = options.timeoutMs ?? 10_000, transport = options.transport ?? exchangeHistoryCheckpoint;
  if (!isHistoryDigest(rootId) || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000
    || options.members.length !== 5) throw new Error('Invalid history writer configuration');
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown history replica');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('History writer needs five distinct pinned members and endpoints');
  }
  function envelope(value: unknown): HistoryCheckpointEnvelope {
    const parsed = parseHistoryCheckpointEnvelope(value, context);
    if (parsed.generation !== generation || (parsed.sequence === 0 && historyCheckpointEnvelopeId(parsed) !== rootId)) {
      throw new Error('History envelope does not match writer pins');
    }
    return parsed;
  }
  function follows(block: HistoryCheckpointEnvelope, committed: WriterState['committed']): boolean {
    return committed ? block.sequence === committed.envelope.sequence + 1
      && block.previous === historyCheckpointEnvelopeId(committed.envelope)
      : block.sequence === 0 && historyCheckpointEnvelopeId(block) === rootId;
  }
  function valid(value: unknown): value is WriterState {
    if (!exactWitnessFields(value, ['version', 'contextId', 'rootId', 'generation', 'committed', 'pending'])
      || value.version !== 1 || value.contextId !== contextId || value.rootId !== rootId || value.generation !== generation) return false;
    try {
      let committed: WriterState['committed'] = null;
      if (value.committed !== null) {
        if (!exactWitnessFields(value.committed, ['envelope', 'certificate'])) return false;
        const block = envelope(value.committed.envelope);
        committed = { envelope: block, certificate: parseHistoryWriteCertificate(value.committed.certificate, block, rootId, context) };
      }
      return value.pending === null || follows(envelope(value.pending), committed);
    } catch { return false; }
  }
  const key = copyAdmissionSigningKey(options.signingKey);
  let storage: ReturnType<typeof openEncryptedLocalState<WriterState>>;
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong checkpoint writer owner');
    storage = openEncryptedLocalState<WriterState>({ path: join(options.directory, HISTORY_WRITER_FILENAME), key: options.localKey,
      domain: 'resonance:history-checkpoint-writer:v1', maxBytes: 40 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing',
      initial: { version: 1, contextId, rootId, generation, committed: null, pending: null }, validate: valid });
  } catch (error) { key.secretKey.fill(0); throw error; }
  let closed = false, active: AbortController | undefined;
  return {
    /** Exposes pending exact ciphertext for explicit retry after restart; never automatically sends. */
    read(): WriterState { return structuredClone(storage.read()); },
    async replicate(value: unknown): Promise<HistoryWriteCertificate> {
      storage.read();
      if (closed) throw new Error('History writer is closed');
      if (active) throw new Error('History writer already has an active attempt');
      const started = performance.now(), expiresAt = Date.now() + timeoutMs;
      const controller = new AbortController(); active = controller;
      const live = () => {
        if (closed || controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) {
          throw new Error('History quorum attempt cancelled or timed out');
        }
      };
      try {
        const block = envelope(value), id = historyCheckpointEnvelopeId(block), state = storage.read();
        if (state.pending && historyCheckpointEnvelopeId(state.pending) !== id) throw new Error('Retry the pending exact history block first');
        const retryCommitted = state.committed && historyCheckpointEnvelopeId(state.committed.envelope) === id;
        if (!state.pending && !retryCommitted) {
          if (!follows(block, state.committed)) throw new Error('History write has a gap, fork or stale predecessor');
          storage.write({ ...state, pending: block }); // Survives a lost reply or process death.
        }
        live();
        const challenge = randomBytes(32).toString('base64url'), issuedAt = expiresAt - timeoutMs;
        const requests = members.map(member => createHistoryExchangeRequest({ action: 'append', rootId, generation,
          replica: member.publicKey, challenge, issuedAt, expiresAt, sequence: block.sequence, envelopeId: id }, context, key));
        live();
        const certificate = await new Promise<HistoryWriteCertificate>((resolve, reject) => {
          let settled = false, remaining = 5;
          const receipts: HistoryExchangeResponse[] = [];
          const finish = (result?: HistoryWriteCertificate, error?: Error) => {
            if (settled) return; settled = true;
            clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
            // Abort outstanding sockets only after installing a terminal result.
            controller.abort();
            if (error) reject(error); else resolve(result!);
          };
          const abort = () => finish(undefined, new Error('History quorum attempt cancelled'));
          const timer = setTimeout(() => finish(undefined, new Error('Four durable history acknowledgements unavailable')),
            Math.max(1, timeoutMs - (performance.now() - started)));
          controller.signal.addEventListener('abort', abort, { once: true });
          members.forEach((member, index) => {
            void Promise.resolve().then(() => {
              if (settled) throw new Error('Attempt completed');
              return transport(member, { request: requests[index], envelope: structuredClone(block) }, controller.signal);
            }).then(response => {
              if (settled) return;
              live();
              const receipt = parseHistoryExchangeResponse(response, requests[index], context);
              live(); receipts.push(receipt);
              if (receipts.length === 4) finish(parseHistoryWriteCertificate({ version: 1, receipts }, block, rootId, context));
            }).catch(() => {}).finally(() => {
              if (!settled && receipts.length + --remaining < 4) finish(undefined, new Error('Four durable history acknowledgements unavailable'));
            });
          });
        });
        // Successful collection cancels the fifth socket; closed/deadline checks
        // below remain mandatory and do not interpret that internal abort as failure.
        if (closed || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) throw new Error('History quorum completed too late');
        const current = storage.read();
        storage.write({ ...current, pending: null, committed: { envelope: block, certificate } });
        if (closed || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) throw new Error('History certificate persistence completed too late');
        return structuredClone(certificate);
      } finally { controller.abort(); if (active === controller) active = undefined; }
    },
    close() { if (!closed) { closed = true; active?.abort(); storage.close(); key.secretKey.fill(0); } },
  };
}
