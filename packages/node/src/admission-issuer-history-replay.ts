import { historyAncestryPages } from '@resonance/core/history-ancestry-pages';
import { AdmissionPolicyArchiveExecutionContext, parseAdmissionPolicyProofReference } from '@resonance/core/admission-policy-archive';
import { policyProofBudget, type PolicyProofOperation, type PolicyProofCache } from '../../relay/src/admission-policy-history-proof.js';
import type { ProtectedIssuerState as State } from './protected-admission-issuer-state.js';
/** Complete authenticated issuer history replay. Historical evidence never grants live write authority. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest, openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { assertHistorySuccessorChain, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { protectedIssuerReplayDigest } from '@resonance/relay/protected-issuer-history';
import { parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { MAX_BYTES } from './admission-issuer-state.js';
import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis, validateProtectedIssuerPolicyProof } from './protected-admission-issuer-state.js';

export interface ProtectedIssuerReplayOptions {
  context: HistoryCheckpointContext; genesisId: string; profile: AdmissionWalletProfileV1; authority: string;
  encryptionKey: Uint8Array; proposal: HistorySuccessorProposal; blocks: Iterable<unknown>;
  /** Exact authenticated applied/pending local images. All must occur in the selected history. */
  minimumEvidence?: readonly unknown[];
  maxBlocks?: number; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
}
export async function replayProtectedIssuerHistory(options: ProtectedIssuerReplayOptions) {
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), genesisId = options.genesisId, authority = options.authority;
  const profileInput = structuredClone(options.profile), proposal = parseHistorySuccessorProposal(structuredClone(options.proposal), context);
  const maxBlocks = options.maxBlocks ?? 10001, maxBytes = options.maxBytes ?? 256 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 30000;
  const signal = options.signal, started = performance.now();
  function live() {
    if (signal?.aborted || performance.now() - started >= timeoutMs) throw new Error('Issuer history replay cancelled or timed out');
    proofOperation.budget?.check();
  }
  if (context.role !== 'admission-issuer' || context.authority !== authority || !isHistoryDigest(genesisId)
    || !(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32
    || ![maxBlocks, maxBytes, timeoutMs].every(Number.isSafeInteger) || maxBlocks < 1 || maxBlocks > 10001
    || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 || timeoutMs < 50 || timeoutMs > 300000) throw new Error('Invalid issuer history replay bounds or pins');
  const startup = new AdmissionPolicyArchiveExecutionContext({
    execution: { version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: Math.min(timeoutMs, 30000) },
    timeoutMs, signal, deadline: started + Math.min(timeoutMs, 30000),
  });
  const proofOperation: PolicyProofOperation = { startup }, proofCache: PolicyProofCache = new Map();
  const key = Uint8Array.from(options.encryptionKey), contextId = historyCheckpointContextId(context), proposalId = historySuccessorProposalId(proposal);
  try {
    // Freeze the complete bounded iterable and evidence before the first await.
    const supplied: HistoryCheckpointEnvelope[] = []; let bytes = 0;
    for (const raw of options.blocks) {
      live(); if (supplied.length >= maxBlocks) throw new Error('Issuer history replay block capacity exceeded');
      const size = Buffer.byteLength(JSON.stringify(raw) ?? '');
      if (!size || size > HISTORY_ENVELOPE_MAX_BYTES || (bytes += size) > maxBytes) throw new Error('Issuer history replay byte capacity exceeded');
      supplied.push(parseHistoryCheckpointEnvelope(structuredClone(raw), context));
    }
    if (options.minimumEvidence !== undefined && (!Array.isArray(options.minimumEvidence) || options.minimumEvidence.length > 256)) throw new Error('Invalid issuer minimum evidence bound');
    const evidence: unknown[] = []; let evidenceBytes = 0;
    for (const value of options.minimumEvidence ?? []) {
      live(); const size = Buffer.byteLength(JSON.stringify(value) ?? '');
      if (!size || size > MAX_BYTES || (evidenceBytes += size) > maxBytes) throw new Error('Issuer minimum evidence byte capacity exceeded');
      evidence.push(structuredClone(value));
    }
    live();
    const { profile } = await parseAdmissionWalletProfile(profileInput), pins = { profile, authority };
    const minimum: State[] = [];
    for (const value of evidence) { live(); minimum.push(await parseProtectedIssuerImage(value, pins)); live(); }
    const found = minimum.map(() => false);
    // Replay starts without a remembered head and verifies every original append once.
    // Only the preceding/current opaque heads survive between complete business records.
    async function decode(block: HistoryCheckpointEnvelope) {
      if (block.kind !== 'checkpoint') throw new Error('Issuer replay requires complete snapshots');
      const plaintext = openHistoryCheckpoint(block, context, key);
      try {
        if (plaintext.length > MAX_BYTES) throw new Error('Issuer history snapshot exceeds its bound');
        const raw = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext));
        const reference = raw.policyProof && parseAdmissionPolicyProofReference(raw.policyProof);
        const budget = reference ? policyProofBudget(proofOperation, reference, signal, started + timeoutMs) : undefined;
        const image = budget ? await budget.wait(() => parseProtectedIssuerImage(raw, pins, budget.keyImports)) : await parseProtectedIssuerImage(raw, pins);
        await validateProtectedIssuerPolicyProof(image, { source: () => supplied, context, encryptionKey: key, signal, deadline: started + timeoutMs, operation: proofOperation, cache: proofCache });
        return image;
      } finally { plaintext.fill(0); }
    }
    let state: State | undefined, genesis: HistoryEncryptedEnvelope | undefined, head: HistoryCheckpointEnvelope | undefined;
    let rootId = '', ids: string[] = [], generations = 0, generationBytes = 0;
    for (const page of historyAncestryPages(supplied)) {
    for (const block of page.blocks) {
      live(); const id = historyCheckpointEnvelopeId(block), size = Buffer.byteLength(JSON.stringify(block));
      if (!head) {
        if (block.kind !== 'checkpoint' || block.generation !== 0 || block.sequence !== 0 || id !== genesisId) throw new Error('Issuer replay requires its independently pinned original genesis');
        state = await decode(block);
        assertProtectedIssuerGenesis(state, context);
        genesis = block; rootId = id; ids = [id]; generations = 1; generationBytes = size;
      } else if (block.kind === 'continuation') {
        if (block.proposal.generation !== head.generation || block.generation <= head.generation) throw new Error('Invalid issuer generation ancestry');
        assertHistorySuccessorChain(block.proposal, ids);
        rootId = id; ids = [id]; generations++; generationBytes = size;
      } else {
        if (block.kind !== 'checkpoint' || block.generation !== head.generation || block.sequence !== head.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(head)) throw new Error('Issuer history has a gap, fork or wrong generation');
        if (state!.version === 9) throw new Error('Issuer history continued after permanent retirement');
        const next = await decode(block); await assertProtectedIssuerImageSuccessor(state!, next); state = next; ids.push(id); generationBytes += size;
      }
      live();
      minimum.forEach((value, i) => { if (JSON.stringify(value) === JSON.stringify(state)) found[i] = true; });
      if (generationBytes > 64 * 1024 * 1024) throw new Error('Issuer replay generation capacity exceeded');
      if (block.generation > proposal.generation || block.generation === proposal.generation && block.sequence > proposal.sequence) throw new Error('Issuer replay exceeds its selected head');
      head = block;
      if (head.sequence % 16 === 0) { await yieldToEventLoop(); live(); }
    }
    await yieldToEventLoop(); live();
    }
    live();
    if (!state || !genesis || !head || head.generation !== proposal.generation || rootId !== proposal.rootId) throw new Error('Issuer history does not reach its selected generation');
    assertHistorySuccessorChain(proposal, ids);
    if (found.some(value => !value)) throw new Error('Selected issuer history omits known local applied or pending evidence');
    return { state, genesis, contextId, genesisId, proposalId, replayDigest: protectedIssuerReplayDigest(contextId, genesisId, proposalId, state),
      head: { rootId, generation: head.generation, sequence: head.sequence, envelopeId: historyCheckpointEnvelopeId(head) },
      blocks: supplied.length, bytes, generations };
  } finally { key.fill(0); }
}
