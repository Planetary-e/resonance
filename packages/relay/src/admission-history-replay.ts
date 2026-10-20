import { AdmissionPolicyArchiveExecutionContext, archivedAdmissionPolicyDigest as admissionPolicyDigest } from '@resonance/core/admission-policy-archive';
import type { PolicyProofHistory, PolicyProofOperation, PolicyProofCache } from './admission-policy-history-proof.js';
/** Offline semantic reconstruction. A complete result is historical evidence, never write readiness. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { assertAdmissionPolicySuccessor } from '@resonance/core/admission-policy';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { assertHistorySuccessorChain, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { HISTORY_COMPACTION_MAX_BYTES, parseHistoryCompactionCertificate, type HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { assertHistoryCompactedSuccessorChain } from '@resonance/core/history-compacted-chain';
import { parseAdmissionHistoryImage, parseAdmissionStateCheckpoint, reduceAdmissionHistory, type AdmissionHistoryImage } from './admission-history-records.js';

export const admissionHistoryReplayDigest = (contextId: string, genesisId: string, proposalId: string, image: AdmissionHistoryImage) =>
  historyDigest(`resonance:admission-history-replay:v1\n${JSON.stringify([contextId, genesisId, proposalId, image])}`);

export async function replayAdmissionHistory(options: {
  context: HistoryCheckpointContext; genesisId: string; proposal: HistorySuccessorProposal;
  encryptionKey: Uint8Array; blocks: Iterable<unknown>; maxSpends?: number; maxBlocks?: number; maxBytes?: number;
  /** Local computation budget, not a network request lifetime. Default 30 seconds; at most five minutes. */
  timeoutMs?: number; signal?: AbortSignal;
  onProgress?: (progress: { blocks: number; bytes: number; generations: number }) => void;
  /** Explicit historical proof. Input then consists of the original genesis,
   * the certified full-state checkpoint and its complete suffix/continuations. */
  compaction?: unknown;
  blockSource?: () => Iterable<HistoryCheckpointEnvelope>;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  if (context.role !== 'relay-admission-spends') throw new Error('Admission history requires its own history role');
  const proposal = parseHistorySuccessorProposal(options.proposal, context), proposalId = historySuccessorProposalId(proposal);
  const maxBlocks = options.maxBlocks ?? 10001, maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30000, maxSpends = options.maxSpends ?? 10000;
  if (!isHistoryDigest(options.genesisId) || options.encryptionKey.length !== 32
    || ![maxBlocks, maxBytes, timeoutMs, maxSpends].every(Number.isSafeInteger)
    || maxBlocks < 1 || maxBlocks > 10001 || maxBytes < 1 || maxBytes > 256 * 1024 * 1024
    || timeoutMs < 50 || timeoutMs > 300000 || maxSpends < 1 || maxSpends > 10000) throw new Error('Invalid admission replay pins or bounds');
  // Copy before asynchronous policy verification. Caller mutation cannot replace
  // the proof after the independently pinned genesis has been checked.
  const encodedCompaction = options.compaction === undefined ? undefined : JSON.stringify(options.compaction);
  if (options.compaction !== undefined && (!encodedCompaction || Buffer.byteLength(encodedCompaction) > HISTORY_COMPACTION_MAX_BYTES)) {
    throw new Error('Compaction replay certificate exceeds its bound');
  }
  const compaction: unknown = encodedCompaction === undefined ? undefined : JSON.parse(encodedCompaction);
  const genesisId = options.genesisId, started = performance.now();
  let image: AdmissionHistoryImage | undefined, genesis: HistoryEncryptedEnvelope | undefined;
  let anchor: { certificate: HistoryCompactionCertificate; checkpoint: HistoryCheckpointEnvelope } | undefined;
  let consumedCompaction = false;
  let head: HistoryCheckpointEnvelope | undefined, rootId = '', ids: string[] = [], bytes = 0, blocks = 0, generationBytes = 0, generations = 0;
  function live() {
    if (options.signal?.aborted || performance.now() - started >= timeoutMs) throw new Error('Admission history replay cancelled or timed out');
    proofOperation.budget?.check();
  }
  function decode(block: HistoryCheckpointEnvelope): unknown {
    const plaintext = openHistoryCheckpoint(block, context, key);
    try { return JSON.parse(plaintext.toString('utf8')); }
    catch { throw new Error('Invalid encrypted admission history record'); }
    finally { plaintext.fill(0); }
  }
  function assertSelectedChain(selected: HistorySuccessorProposal) {
    if (anchor) assertHistoryCompactedSuccessorChain({ proposal: selected, ids, certificate: anchor.certificate,
      checkpoint: anchor.checkpoint, context, genesisId });
    else assertHistorySuccessorChain(selected, ids);
  }
  // Historical proof reconstruction owns one explicit offline deadline from replay
  // entry. Retained reference bounds remain unchanged and cannot authorize writes.
  const startup = new AdmissionPolicyArchiveExecutionContext({
    execution: { version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: Math.min(timeoutMs, 30000) },
    timeoutMs, signal: options.signal, deadline: started + Math.min(timeoutMs, 30000),
  });
  const key = Buffer.from(options.encryptionKey);
  const proofOperation: PolicyProofOperation = { startup }, proofCache: PolicyProofCache = new Map();
  const proofHistory: PolicyProofHistory = { context, encryptionKey: key, operation: proofOperation, cache: proofCache,
    signal: options.signal, deadline: started + timeoutMs, source: options.blockSource ?? (() => options.blocks as Iterable<HistoryCheckpointEnvelope>) };
  try {
    live();
    for (const raw of options.blocks) {
      live(); if (++blocks > maxBlocks) throw new Error('Admission replay block capacity exceeded');
      const size = Buffer.byteLength(JSON.stringify(raw) ?? '');
      if (!size || size > HISTORY_ENVELOPE_MAX_BYTES || (bytes += size) > maxBytes) throw new Error('Admission replay byte capacity exceeded');
      const block = parseHistoryCheckpointEnvelope(raw, context), id = historyCheckpointEnvelopeId(block);
      if (!head) {
        if (block.kind !== 'checkpoint' || block.generation !== 0 || block.sequence !== 0 || id !== genesisId) throw new Error('Admission replay needs its independently pinned genesis');
        genesis = block; image = await parseAdmissionHistoryImage(decode(block), context.authority, maxSpends, proofHistory);
        if (`sha256:${admissionPolicyDigest(image.policy)}` !== context.policyDigest) throw new Error('Admission genesis policy differs from its context');
        generations = 1; rootId = id; ids = [id]; generationBytes = size;
      } else if (compaction !== undefined && !consumedCompaction) {
        const certificate = parseHistoryCompactionCertificate(compaction, context, genesisId, block);
        const replacement = (await parseAdmissionStateCheckpoint(decode(block), context.authority, maxSpends, proofHistory)).image;
        if (replacement.policyProof || image!.policy.version === 3 || replacement.policy.version === 3) throw new Error('Business-only compaction cannot replace original policy proof ancestry');
        assertAdmissionPolicySuccessor(image!.policy, replacement.policy);
        image = replacement;
        anchor = { certificate, checkpoint: block }; consumedCompaction = true;
        rootId = certificate.proposal.rootId; ids = [id]; generationBytes = block.generation === 0 ? generationBytes + size : size;
        if (block.generation > 0) generations++;
      } else if (block.kind === 'continuation') {
        if (generations >= 65 || block.proposal.generation !== head.generation || block.generation <= head.generation) throw new Error('Invalid admission generation ancestry');
        assertSelectedChain(block.proposal);
        anchor = undefined; generations++; rootId = id; ids = [id]; generationBytes = size;
      } else {
        if (block.generation !== head.generation || block.sequence !== head.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(head)) {
          throw new Error('Admission history has a gap, fork or wrong generation');
        }
        image = (await reduceAdmissionHistory(image!, decode(block), maxSpends, block.kind, proofHistory)).image;
        ids.push(id); generationBytes += size;
      }
      live();
      if (generationBytes > 64 * 1024 * 1024) throw new Error('Admission replay generation capacity exceeded');
      if (block.generation > proposal.generation || (block.generation === proposal.generation && block.sequence > proposal.sequence)) throw new Error('Admission history exceeds its selected head');
      head = block;
      // Yield macrotasks so cancellation can arrive during long local histories.
      if (blocks % 32 === 0) { options.onProgress?.({ blocks, bytes, generations }); await yieldToEventLoop(); live(); }
    }
    live();
    if (!image || !genesis || !head || head.generation !== proposal.generation || rootId !== proposal.rootId
      || (compaction !== undefined && !consumedCompaction)) throw new Error('Admission history does not reach its selected generation');
    assertSelectedChain(proposal);
    const replayDigest = admissionHistoryReplayDigest(contextId, genesisId, proposalId, image);
    options.onProgress?.({ blocks, bytes, generations }); live();
    return { image, genesis, contextId, genesisId, proposalId, replayDigest,
      head: { rootId, generation: head.generation, sequence: head.sequence, envelopeId: historyCheckpointEnvelopeId(head) },
      blocks, bytes, generations };
  } finally { key.fill(0); }
}
