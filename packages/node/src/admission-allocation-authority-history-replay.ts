/** Complete authenticated allocation-authority history replay. Historical evidence never grants live write authority. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest,
  openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { assertHistorySuccessorChain, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { protectedAllocationAuthorityReplayDigest } from '@resonance/relay/protected-allocation-authority-history';
import { MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES as MAX_BYTES, parseAdmissionAllocationAuthorityState,
  assertProtectedAllocationAuthoritySuccessor, assertProtectedAllocationAuthorityGenesis,
  type AdmissionAllocationAuthorityState as State } from './admission-allocation-authority-state.js';

export interface ProtectedAllocationAuthorityReplayOptions {
  context: HistoryCheckpointContext; genesisId: string; authority: string;
  encryptionKey: Uint8Array; proposal: HistorySuccessorProposal; blocks: Iterable<unknown>;
  /** Exact authenticated applied/pending local images. All must occur in the selected history. */
  minimumEvidence?: readonly unknown[];
  maxBlocks?: number; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
}
export async function replayProtectedAllocationAuthorityHistory(options: ProtectedAllocationAuthorityReplayOptions) {
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), genesisId = options.genesisId, authority = options.authority;
  const proposal = parseHistorySuccessorProposal(structuredClone(options.proposal), context);
  const maxBlocks = options.maxBlocks ?? 10001, maxBytes = options.maxBytes ?? 256 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 30000;
  const signal = options.signal, started = performance.now();
  function live() { if (signal?.aborted || performance.now() - started >= timeoutMs) throw new Error('Allocation authority history replay cancelled or timed out'); }
  if (context.role !== 'admission-allocation-authority' || context.authority !== authority || !isHistoryDigest(genesisId)
    || !(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32
    || ![maxBlocks, maxBytes, timeoutMs].every(Number.isSafeInteger) || maxBlocks < 1 || maxBlocks > 10001
    || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 || timeoutMs < 50 || timeoutMs > 300000) throw new Error('Invalid allocation-authority history replay bounds or pins');
  const key = Uint8Array.from(options.encryptionKey), contextId = historyCheckpointContextId(context), proposalId = historySuccessorProposalId(proposal);
  try {
    // Freeze the complete bounded iterable and evidence before the first await.
    const supplied: HistoryCheckpointEnvelope[] = []; let bytes = 0;
    for (const raw of options.blocks) {
      live(); if (supplied.length >= maxBlocks) throw new Error('Allocation authority history replay block capacity exceeded');
      const size = Buffer.byteLength(JSON.stringify(raw) ?? '');
      if (!size || size > HISTORY_ENVELOPE_MAX_BYTES || (bytes += size) > maxBytes) throw new Error('Allocation authority history replay byte capacity exceeded');
      supplied.push(parseHistoryCheckpointEnvelope(structuredClone(raw), context));
    }
    if (options.minimumEvidence !== undefined && (!Array.isArray(options.minimumEvidence) || options.minimumEvidence.length > 256)) throw new Error('Invalid allocation authority minimum evidence bound');
    const evidence: unknown[] = []; let evidenceBytes = 0;
    for (const value of options.minimumEvidence ?? []) {
      live(); const size = Buffer.byteLength(JSON.stringify(value) ?? '');
      if (!size || size > MAX_BYTES || (evidenceBytes += size) > maxBytes) throw new Error('Allocation authority minimum evidence byte capacity exceeded');
      evidence.push(structuredClone(value));
    }
    live();
    const minimum: State[] = [];
    for (const value of evidence) { live(); minimum.push(await parseAdmissionAllocationAuthorityState(value, authority)); live(); }
    const found = minimum.map(() => false);
    async function decode(block: HistoryCheckpointEnvelope) {
      if (block.kind !== 'checkpoint') throw new Error('Allocation authority replay requires complete snapshots');
      const plaintext = openHistoryCheckpoint(block, context, key);
      try {
        if (plaintext.length > MAX_BYTES) throw new Error('Allocation authority history snapshot exceeds its bound');
        return await parseAdmissionAllocationAuthorityState(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext)), authority);
      } finally { plaintext.fill(0); }
    }
    let state: State | undefined, genesis: HistoryEncryptedEnvelope | undefined, head: HistoryCheckpointEnvelope | undefined;
    let rootId = '', ids: string[] = [], generations = 0, generationBytes = 0;
    for (const block of supplied) {
      live(); const id = historyCheckpointEnvelopeId(block), size = Buffer.byteLength(JSON.stringify(block));
      if (!head) {
        if (block.kind !== 'checkpoint' || block.generation !== 0 || block.sequence !== 0 || id !== genesisId) throw new Error('Allocation authority replay requires its independently pinned original genesis');
        state = await decode(block);
        assertProtectedAllocationAuthorityGenesis(state, context);
        genesis = block; rootId = id; ids = [id]; generations = 1; generationBytes = size;
      } else if (block.kind === 'continuation') {
        if (generations >= 65 || block.proposal.generation !== head.generation || block.generation <= head.generation) throw new Error('Invalid allocation authority generation ancestry');
        assertHistorySuccessorChain(block.proposal, ids);
        rootId = id; ids = [id]; generations++; generationBytes = size;
      } else {
        if (block.kind !== 'checkpoint' || block.generation !== head.generation || block.sequence !== head.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(head)) throw new Error('Allocation authority history has a gap, fork or wrong generation');
        const next = await decode(block); await assertProtectedAllocationAuthoritySuccessor(state!, next); state = next; ids.push(id); generationBytes += size;
      }
      live();
      minimum.forEach((value, i) => { if (JSON.stringify(value) === JSON.stringify(state)) found[i] = true; });
      if (generationBytes > 64 * 1024 * 1024) throw new Error('Allocation authority replay generation capacity exceeded');
      if (block.generation > proposal.generation || block.generation === proposal.generation && block.sequence > proposal.sequence) throw new Error('Allocation authority replay exceeds its selected head');
      head = block;
      if (head.sequence % 16 === 0) { await yieldToEventLoop(); live(); }
    }
    live();
    if (!state || !genesis || !head || head.generation !== proposal.generation || rootId !== proposal.rootId) throw new Error('Allocation authority history does not reach its selected generation');
    assertHistorySuccessorChain(proposal, ids);
    if (found.some(value => !value)) throw new Error('Selected allocation-authority history omits known local applied or pending evidence');
    return { state, genesis, contextId, genesisId, proposalId, replayDigest: protectedAllocationAuthorityReplayDigest(contextId, genesisId, proposalId, state),
      head: { rootId, generation: head.generation, sequence: head.sequence, envelopeId: historyCheckpointEnvelopeId(head) },
      blocks: supplied.length, bytes, generations };
  } finally { key.fill(0); }
}
