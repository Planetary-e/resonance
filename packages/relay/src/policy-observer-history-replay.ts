import { firstHistoryAncestryPage, nextHistoryAncestryGeneration } from '@resonance/core/history-ancestry-pages';
/** Offline semantic replay. Historical certificates never authorize live signing. */
import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers, parseAdmissionPolicyHead, type AdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead, type AdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest,
  openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { assertHistorySuccessorChain, historySuccessorProposalId, parseHistorySuccessorProposal,
  type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { resolveAdmissionPolicy, inspectResolvedAdmissionPolicy, type ResolvedAdmissionPolicy, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import { createPolicyObserverPageReader, policyObserverArchiveLimits } from './policy-observer-page-reader.js';
import { ADMISSION_POLICY_OBSERVER_MAX_BYTES, assertPolicyObserverStateSuccessor, parseAdmissionPolicyObserverState,
  policyObserverStateHead, samePolicyObserverAdvance, parsePolicyObserverSnapshot, resolveObserverSnapshot, type AdmissionPolicyObserverState } from './admission-policy-observer-state.js';

/** Same pinned volunteers, a different deterministic history for each observer. */
export function policyObserverHistoryContext(value: AdmissionPolicyObservers, observer: string): HistoryCheckpointContext {
  const context = parseAdmissionPolicyObservers(value), contextId = admissionPolicyObserversId(context);
  if (!context.members.some(member => member.publicKey === observer)) throw new Error('Policy observer key is not enrolled');
  return parseHistoryCheckpointContext({ version: 1, role: 'policy-observer',
    historyId: createHash('sha256').update(`resonance:policy-observer-history:v1\n${JSON.stringify([contextId, observer])}`).digest('base64url'),
    owner: observer, authority: context.authority, policyDigest: contextId,
    members: context.members.map(member => member.publicKey).sort(), quorum: 4 });
}
export function assertPolicyObserverHistoryContext(context: AdmissionPolicyObservers, historyContext: HistoryCheckpointContext) {
  if (historyCheckpointContextId(historyContext) !== historyCheckpointContextId(policyObserverHistoryContext(context, historyContext.owner))) {
    throw new Error('Wrong protected policy observer history pins');
  }
}
export async function decodePolicyObserverSnapshot(block: HistoryCheckpointEnvelope, historyContext: HistoryCheckpointContext,
  context: AdmissionPolicyObservers, key: Uint8Array, metadataOnly = false) {
  if (block.kind !== 'checkpoint') throw new Error('Policy observer needs complete snapshots');
  const bytes = openHistoryCheckpoint(block, historyContext, key);
  try {
    if (bytes.length > ADMISSION_POLICY_OBSERVER_MAX_BYTES) throw new Error('Policy observer snapshot exceeds its bound');
    return await (metadataOnly ? parsePolicyObserverSnapshot : parseAdmissionPolicyObserverState)(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)), context);
  } finally { bytes.fill(0); }
}
export const policyObserverReplayDigest = (contextId: string, genesisId: string, proposalId: string, state: AdmissionPolicyObserverState) =>
  historyDigest(`resonance:policy-observer-replay:v1\n${JSON.stringify([contextId, genesisId, proposalId, state])}`);

export async function replayPolicyObserverHistory(options: {
  context: AdmissionPolicyObservers; historyContext: HistoryCheckpointContext; genesisId: string;
  proposal: HistorySuccessorProposal; encryptionKey: Uint8Array; blocks: Iterable<unknown>;
  /** Still-available authenticated local knowledge, including pending evidence.
   * Complete loss cannot recover facts never copied to another device. */
  minimumState?: unknown;
  /** Reopenable funded retained ancestry, required for a single-use v3 input stream. */
  blockSource?: () => Iterable<HistoryCheckpointEnvelope>;
  /** Optional historical lookup; returned only after the entire selected chain
   * and all conflict evidence have passed semantic verification. */
  successorOf?: AdmissionPolicyHead;
  selectedPolicyHead?: AdmissionPolicyHead;
  accountRead?: (bytes: number) => void;
  maxBlocks?: number; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
}) {
  const context = parseAdmissionPolicyObservers(options.context), historyContext = parseHistoryCheckpointContext(options.historyContext);
  assertPolicyObserverHistoryContext(context, historyContext);
  const contextId = historyCheckpointContextId(historyContext), proposal = parseHistorySuccessorProposal(options.proposal, historyContext);
  const proposalId = historySuccessorProposalId(proposal), genesisId = options.genesisId;
  const maxBlocks = options.maxBlocks ?? 10001, maxBytes = options.maxBytes ?? 256 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 30000;
  if (!isHistoryDigest(genesisId) || !(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32
    || ![maxBlocks, maxBytes, timeoutMs].every(Number.isSafeInteger) || maxBlocks < 1 || maxBlocks > 10001
    || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 || timeoutMs < 50 || timeoutMs > 300000) throw new Error('Invalid policy observer replay bounds or pins');
  const key = Uint8Array.from(options.encryptionKey), started = performance.now();
  const suppliedMinimum = options.minimumState; // The parser snapshots before its first await.
  const target = options.successorOf === undefined ? undefined : parseAdmissionPolicyHead(options.successorOf);
  const selectedHead = options.selectedPolicyHead === undefined ? undefined : parseAdmissionPolicyHead(options.selectedPolicyHead);
  let selectedResolved: ResolvedAdmissionPolicy | undefined;
  let successor: ArchivedAdmissionPolicyAdvance | undefined;
  let resolved: ResolvedAdmissionPolicy | undefined;
  let state: AdmissionPolicyObserverState | undefined, genesis: HistoryEncryptedEnvelope | undefined;
  let head: HistoryCheckpointEnvelope | undefined, rootId = '', ids: string[] = [], bytes = 0, blocks = 0, generations = 0, generationBytes = 0;
  let readBlocks = 0, readBytes = 0;
  function account(size: number) { options.accountRead?.(size); if (++readBlocks > maxBlocks || (readBytes += size) > maxBytes) throw new Error('Policy observer replay cumulative read budget exceeded'); }
  const source = options.blockSource ?? (() => options.blocks as Iterable<HistoryCheckpointEnvelope>);
  const archiveReader = createPolicyObserverPageReader({ source, historyContext, key, maxBlocks, maxBytes, timeoutMs, signal: options.signal, account });
  function live() { if (options.signal?.aborted || performance.now() - started >= timeoutMs) throw new Error('Policy observer replay cancelled or timed out'); }
  try {
    live();
    const minimum = suppliedMinimum === undefined ? undefined : await parsePolicyObserverSnapshot(suppliedMinimum, context);
    let foundMinimum = !minimum;
    function* parsedBlocks() {
      for (const raw of options.blocks) {
        live(); if (++blocks > maxBlocks) throw new Error('Policy observer replay block capacity exceeded');
        const size = Buffer.byteLength(JSON.stringify(raw) ?? '');
        if (!size || size > HISTORY_ENVELOPE_MAX_BYTES || (bytes += size) > maxBytes) throw new Error('Policy observer replay byte capacity exceeded');
        account(size); yield parseHistoryCheckpointEnvelope(raw, historyContext);
      }
    }
    let page = firstHistoryAncestryPage(), processed = 0;
    for (const block of parsedBlocks()) {
      live(); const id = historyCheckpointEnvelopeId(block), size = Buffer.byteLength(JSON.stringify(block));
      let pageBoundary = false;
      if (!head) {
        if (block.kind !== 'checkpoint' || block.generation !== 0 || block.sequence !== 0 || id !== genesisId) throw new Error('Policy observer replay requires its independently pinned genesis');
        state = await decodePolicyObserverSnapshot(block, historyContext, context, key);
        if (state.previous !== null) throw new Error('Policy observer genesis contains a noninitial policy');
        genesis = block; rootId = id; ids = [id]; generations = 1; generationBytes = size;
        resolved = await resolveAdmissionPolicy({ context, genesis: state.policy, advances: [], selectedHead: context.genesis,
          reader: async () => { throw new Error('Genesis has no archive pages'); }, limits: policyObserverArchiveLimits(maxBlocks, maxBytes, timeoutMs), signal: options.signal });
      } else if (block.kind === 'continuation') {
        if (block.proposal.generation !== head.generation || block.generation <= head.generation) throw new Error('Invalid policy observer generation ancestry');
        assertHistorySuccessorChain(block.proposal, ids);
        const nextPage = nextHistoryAncestryGeneration(page);
        pageBoundary = nextPage.index !== page.index; page = nextPage;
        rootId = id; ids = [id]; generations++; generationBytes = size;
      } else {
        if (block.generation !== head.generation || block.sequence !== head.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(head)) throw new Error('Policy observer history has a gap, fork or wrong generation');
        const next = await decodePolicyObserverSnapshot(block, historyContext, context, key, true);
        assertPolicyObserverStateSuccessor(state!, next, context);
        if (!next.conflict) {
          if (next.policy.version === 3 && !options.blockSource && (options.blocks[Symbol.iterator]() as unknown) === options.blocks) throw new Error('V3 replay requires reopenable retained original ancestry');
          resolved = await resolveObserverSnapshot(next, context, { previous: resolved!, reader: archiveReader,
            limits: policyObserverArchiveLimits(maxBlocks, maxBytes, timeoutMs), signal: options.signal });
        }
        state = next; ids.push(id); generationBytes += size;
      }
      live();
      if (selectedHead && sameAdmissionPolicyHead(policyObserverStateHead(state!, context), selectedHead)) selectedResolved = resolved;
      if (target && block.kind === 'checkpoint' && !state!.conflict && state!.advance
        && sameAdmissionPolicyHead(state!.advance.previous, target)) {
        successor = structuredClone({ commitment: state!.advance, policy: state!.policy });
      }
      if (minimum && sameAdmissionPolicyHead(policyObserverStateHead(state!, context), policyObserverStateHead(minimum, context))
        && (!minimum.conflict || state!.conflict && samePolicyObserverAdvance(state!.conflict, minimum.conflict))) foundMinimum = true;
      if (generationBytes > 64 * 1024 * 1024) throw new Error('Policy observer replay generation capacity exceeded');
      if (block.generation > proposal.generation || block.generation === proposal.generation && block.sequence > proposal.sequence) throw new Error('Policy observer replay exceeds its selected head');
      head = block;
      if (++processed % 32 === 0 || pageBoundary) { await yieldToEventLoop(); live(); }
    }
    live();
    if (!state || !genesis || !head || head.generation !== proposal.generation || rootId !== proposal.rootId) throw new Error('Policy observer history does not reach its selected generation');
    assertHistorySuccessorChain(proposal, ids);
    if (!foundMinimum) throw new Error('Selected policy history omits known local state or conflict evidence; preserve and reconcile the local history');
    return { state, resolved: resolved!, selectedResolved, genesis, contextId, genesisId, proposalId, replayDigest: policyObserverReplayDigest(contextId, genesisId, proposalId, state),
      head: { rootId, generation: head.generation, sequence: head.sequence, envelopeId: historyCheckpointEnvelopeId(head) }, blocks, bytes, generations,
      ...(target ? { successor } : {}) };
  } finally { key.fill(0); }
}
