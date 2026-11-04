/** Replicate the selected frozen history and reserve one successor. Does not activate it. */
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { createHistoryFreeze, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest,
  parseHistoryCheckpointContext, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeRequest, parseHistoryExchangeResponse, parseHistoryRecoveryPreparation,
  type HistoryExchangeResponse, type HistoryRecoveryPreparation } from '@resonance/core/history-exchange';
import { assertHistorySuccessorChain, createHistorySuccessorProposal, historySuccessorProposalId, historySuccessorRepairId,
  parseHistorySuccessorCertificate, parseHistorySuccessorProposal,
  type HistorySuccessorProposal, type HistorySuccessorCertificate } from '@resonance/core/history-successor';
import { exchangeHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export const HISTORY_SUCCESSOR_FILENAME = 'history-successor.json';
interface SuccessorState {
  version: 1; contextId: string; rootId: string; generation: number; nextGeneration: number;
  preparation: HistoryRecoveryPreparation; proposal: HistorySuccessorProposal; certificate: HistorySuccessorCertificate | null;
}
export function createHistoryCheckpointSuccessor(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  rootId: string; generation: number; nextGeneration: number; members: HistoryReplicaEndpoint[];
  /** Explicit initial selection. Once persisted it cannot be replaced, even after timeout. */
  initialize?: HistoryRecoveryPreparation;
  timeoutMs?: number; transport?: HistoryCheckpointTransport;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const { rootId, generation, nextGeneration } = options;
  const timeoutMs = options.timeoutMs ?? 30_000, transport = options.transport ?? exchangeHistoryCheckpoint;
  if (!isHistoryDigest(rootId) || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isSafeInteger(nextGeneration) || nextGeneration <= generation
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000 || options.members.length !== 5) {
    throw new Error('Invalid successor coordinator configuration');
  }
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown successor replica');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('Successor needs five distinct pinned members and endpoints');
  }
  function valid(value: unknown): value is SuccessorState {
    if (!exactWitnessFields(value, ['version', 'contextId', 'rootId', 'generation', 'nextGeneration', 'preparation', 'proposal', 'certificate'])
      || value.version !== 1 || value.contextId !== contextId || value.rootId !== rootId
      || value.generation !== generation || value.nextGeneration !== nextGeneration) return false;
    try {
      const prepared = parseHistoryRecoveryPreparation(value.preparation, context), proposal = parseHistorySuccessorProposal(value.proposal, context);
      if (proposal.rootId !== rootId || proposal.generation !== generation || proposal.nextGeneration !== nextGeneration
        || prepared.rootId !== rootId || prepared.generation !== generation || prepared.nextGeneration !== nextGeneration
        || JSON.stringify(proposal.freezes) !== JSON.stringify(prepared.receipts)) return false;
      assertHistorySuccessorChain(proposal, prepared.envelopes.map(historyCheckpointEnvelopeId));
      if (value.certificate !== null) parseHistorySuccessorCertificate(value.certificate, proposal, context);
      return true;
    } catch { return false; }
  }
  const key = copyAdmissionSigningKey(options.signingKey);
  let storage: ReturnType<typeof openEncryptedLocalState<SuccessorState>>;
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong successor owner');
    let initial: SuccessorState | undefined;
    if (options.initialize) {
      const preparation = parseHistoryRecoveryPreparation(options.initialize, context);
      initial = { version: 1, contextId, rootId, generation, nextGeneration, preparation,
        proposal: createHistorySuccessorProposal(preparation, context, key), certificate: null };
      if (!valid(initial)) throw new Error('Successor selection does not match pins');
    }
    storage = openEncryptedLocalState<SuccessorState>({ path: join(options.directory, HISTORY_SUCCESSOR_FILENAME),
      key: options.localKey, domain: 'resonance:history-successor-coordinator:v1', maxBytes: 96 * 1024 * 1024,
      mode: initial ? 'create-new' : 'open-existing', initial: initial!, validate: valid });
  } catch (error) { key.secretKey.fill(0); throw error; }
  let closed = false, active: AbortController | undefined;
  return {
    read(): SuccessorState { return structuredClone(storage.read()); },
    async reserve(): Promise<HistorySuccessorCertificate> {
      const state = storage.read();
      if (closed) throw new Error('Successor coordinator is closed');
      if (active) throw new Error('Successor coordinator already has an active attempt');
      const started = performance.now(), issuedAt = Date.now(), expiresAt = issuedAt + timeoutMs;
      const controller = new AbortController(); active = controller;
      const live = () => {
        if (closed || controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) {
          throw new Error('Successor attempt cancelled or timed out');
        }
      };
      try {
        const proposal = state.proposal, proposalId = historySuccessorProposalId(proposal), blocks = state.preparation.envelopes;
        const ids = blocks.map(historyCheckpointEnvelopeId), challenge = randomBytes(32).toString('base64url');
        const freeze = createHistoryFreeze(context, generation, nextGeneration, challenge, key);
        live();
        const certificate = await new Promise<HistorySuccessorCertificate>((resolve, reject) => {
          let settled = false, remaining = 5;
          const receipts: HistoryExchangeResponse[] = [];
          const finish = (result?: HistorySuccessorCertificate, error?: Error) => {
            if (settled) return; settled = true;
            clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort();
            if (error) reject(error); else resolve(result!);
          };
          const abort = () => finish(undefined, new Error('Successor attempt cancelled'));
          const timer = setTimeout(() => finish(undefined, new Error('Four durable successor reservations unavailable')),
            Math.max(1, timeoutMs - (performance.now() - started)));
          controller.signal.addEventListener('abort', abort, { once: true });
          async function reserveMember(member: HistoryReplicaEndpoint) {
            async function request(action: 'freeze' | 'repair' | 'seal', block?: HistoryCheckpointEnvelope) {
              live();
              const original = createHistoryExchangeRequest({ action, rootId, generation, replica: member.publicKey,
                challenge, issuedAt, expiresAt,
                sequence: action === 'freeze' ? nextGeneration : block?.sequence ?? proposal.sequence,
                envelopeId: action === 'freeze' ? null : block ? historySuccessorRepairId(proposal, block) : proposalId }, context, key);
              live();
              const raw = await transport(member, { request: structuredClone(original), envelope: block ? structuredClone(block) : null,
                ...(action === 'freeze' ? { freeze: structuredClone(freeze) } : { successor: structuredClone(proposal) }) }, controller.signal);
              live(); const response = parseHistoryExchangeResponse(raw, original, context);
              parseHistoryExchangeRequest(original, context, Date.now()); live();
              if (response.head.freeze?.nextGeneration !== nextGeneration || response.head.sequence > proposal.sequence
                || ids[response.head.sequence] !== response.head.envelopeId) throw new Error('Replica retains different or newer history');
              return response;
            }
            const frozen = await request('freeze');
            // Exact prefix comparison precedes any transfer; only the missing suffix is uploaded.
            for (let sequence = frozen.head.sequence + 1; sequence <= proposal.sequence; sequence++) await request('repair', blocks[sequence]);
            return request('seal');
          }
          members.forEach(member => {
            void Promise.resolve().then(() => reserveMember(member)).then(receipt => {
              if (settled) return; live(); receipts.push(receipt);
              if (receipts.length === 4) finish(parseHistorySuccessorCertificate({ version: 1, proposalId, receipts }, proposal, context));
            }).catch(() => {}).finally(() => {
              if (!settled && receipts.length + --remaining < 4) finish(undefined, new Error('Four durable successor reservations unavailable'));
            });
          });
        });
        const timely = () => {
          if (closed || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) throw new Error('Successor certificate completed too late');
        };
        timely(); storage.write({ ...storage.read(), certificate }); timely();
        return structuredClone(certificate);
      } finally { controller.abort(); if (active === controller) active = undefined; }
    },
    close() { if (!closed) { closed = true; active?.abort(); storage.close(); key.secretKey.fill(0); } },
  };
}
