/** Experimental policy observer backed by the existing four-copy history writer.
 * Explicit configuration is required; reopening never reconstructs lost state. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { HISTORY_RECOVERY_MAX_BYTES, HISTORY_RECOVERY_MAX_BLOCKS } from '@resonance/core/history-exchange';
import { resolveAdmissionPolicy, lookupResolvedAdmissionPolicyKey, verifyAdmissionPolicyV3, archivedAdmissionPolicyDigest, decodeAdmissionPolicyArchivePage, emptyAdmissionPolicyArchive, type ResolvedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
import { admissionPolicyObserversId, createAdmissionPolicyHeadVote, parseAdmissionPolicyHeadRequest,
  parseAdmissionPolicyObservers, parseAdmissionPolicyHead, type AdmissionPolicyObservers, type AdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionPolicyAdvance, parseAdmissionPolicyAdvanceCommitment, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyCheckpointEnvelopeByteLength, historyCheckpointReserveBucket, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
import { advanceAdmissionPolicyObserverState, assertPolicyObserverStateSuccessor,
  parseAdmissionPolicyObserverState, policyObserverStateHead, assertPolicyObserverCurrent, parsePolicyObserverSnapshot, resolveObserverSnapshot, ADMISSION_POLICY_OBSERVER_MAX_BYTES, type AdmissionPolicyObserverState } from './admission-policy-observer-state.js';

import { createPolicyObserverRemoteOperation, type PolicyObserverRemoteArchive } from './policy-observer-page-transfer.js';
import { createPolicyObserverPageReader, policyObserverArchiveLimits } from './policy-observer-page-reader.js';
import { decodePolicyObserverSnapshot, policyObserverHistoryContext, replayPolicyObserverHistory } from './policy-observer-history-replay.js';
import { openPolicyObserverRestoration, type PreparedPolicyObserverRestore } from './policy-observer-history-restore.js';
export { policyObserverHistoryContext } from './policy-observer-history-replay.js';

export const POLICY_OBSERVER_RECOVERY_FENCE = 'policy-observer-recovery-fence.json';
export class PolicySuccessorUnavailableError extends Error {}
export interface PolicyObserverRecoverySource {
  readonly directory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
const recoverySources = new WeakMap<PolicyObserverRecoverySource, { state: AdmissionPolicyObserverState; fence(): Promise<void> }>();
export function readPolicyObserverRecoverySource(source: PolicyObserverRecoverySource) {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Policy recovery needs a live reviewed source capability');
  return structuredClone(record.state);
}
export async function fencePolicyObserverRecoverySource(source: PolicyObserverRecoverySource) {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Policy recovery needs a live reviewed source capability');
  await record.fence();
}

type WriterOptions = Parameters<typeof createRetainedHistoryCheckpointWriter>[0];
/** Offline preparation only. Persist and independently enroll this exact root;
 * regenerating its random ciphertext is not restoration of an existing role. */
export async function createPolicyObserverHistoryRoot(options: {
  context: AdmissionPolicyObservers; signingKey: SigningKeyPair; encryptionKey: Uint8Array; policy: unknown; now?: () => number;
}) {
  const context = parseAdmissionPolicyObservers(options.context), signer = copyAdmissionSigningKey(options.signingKey);
  const key = Uint8Array.from(options.encryptionKey), now = options.now ?? Date.now;
  try {
    const historyContext = policyObserverHistoryContext(context, Buffer.from(signer.publicKey).toString('base64url'));
    const state = await parseAdmissionPolicyObserverState({ version: 1, contextId: admissionPolicyObserversId(context),
      policy: options.policy, previous: null, advance: null, conflict: null }, context);
    assertPolicyObserverCurrent(state.policy, now());
    const plaintext = Buffer.from(JSON.stringify(state));
    try { return { context: historyContext, root: sealHistoryCheckpoint({ context: historyContext,
      header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null }, plaintext, encryptionKey: key, signingKey: signer }) }; }
    finally { plaintext.fill(0); }
  } finally { key.fill(0); signer.secretKey.fill(0); }
}

export async function openProtectedPolicyObserver(options: {
  directory: string; encryptionKey: Uint8Array; context: AdmissionPolicyObservers; signingKey: SigningKeyPair;
  historyContext: HistoryCheckpointContext; root: HistoryCheckpointEnvelope; members: WriterOptions['members'];
  mode: 'create-new' | 'open-existing'; initializeWriter?: boolean; initializeArchive?: boolean; resumePristineArchive?: boolean;
  /** Mandatory original anchor when root is a certified later generation. */
  genesis?: HistoryCheckpointEnvelope;
  restore?: { preparation: PreparedPolicyObserverRestore; approvedDigest: string };
  expectedRestorationDigest?: string;
  /** Funded retained original generations, reopened by the operational archive owner. */
  ancestrySource?: () => Iterable<HistoryCheckpointEnvelope>;
  remoteArchive?: PolicyObserverRemoteArchive;
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  /** Defaults to two independent fresh reads, each with at most four live
   * member RPCs. Callers may explicitly serialize reads through one reader. */
  maximumConcurrentObservations?: 1 | 2;
  now?: () => number;
}) {
  const run = captureStorageReservationOperation();
  const maximumConcurrentObservations = options.maximumConcurrentObservations ?? 2;
  if (maximumConcurrentObservations !== 1 && maximumConcurrentObservations !== 2) throw new Error('Invalid policy observation concurrency');
  if (!['create-new', 'open-existing'].includes(options.mode)) throw new Error('Protected policy observer requires an explicit open mode');
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Protected policy observer requires a 32-byte encryption key');
  const context = parseAdmissionPolicyObservers(options.context), historyContext = parseHistoryCheckpointContext(options.historyContext);
  const root = parseHistoryCheckpointEnvelope(options.root, historyContext), rootId = historyCheckpointEnvelopeId(root);
  const genesis = parseHistoryCheckpointEnvelope(options.genesis ?? root, historyContext), genesisId = historyCheckpointEnvelopeId(genesis);
  const mode = options.mode, restore = options.restore && { ...options.restore }, initializeWriter = options.initializeWriter;
  const expectedReplayDigest = options.expectedRestorationDigest;
  if (expectedReplayDigest !== undefined && (mode !== 'open-existing' || root.kind !== 'continuation')) throw new Error('Expected restoration digest requires an existing certified generation');
  const signer = copyAdmissionSigningKey(options.signingKey), key = Uint8Array.from(options.encryptionKey), now = options.now ?? Date.now;
  const writerOptions = { directory: options.directory, localKey: key, context: historyContext, signingKey: signer, rootId, generation: root.generation, genesisId,
    ...(root.kind === 'continuation' ? { continuation: root } : {}),
    members: structuredClone(options.members), initialize: mode === 'create-new' || initializeWriter, requireCurrentHead: true,
    initializeArchive: options.initializeArchive, resumePristineArchive: options.resumePristineArchive,
    timeoutMs: options.timeoutMs ?? 3000, transport: options.transport,
    maxArchiveBlocks: options.maxArchiveBlocks, maxArchiveBytes: options.maxArchiveBytes };
  let writer: ReturnType<typeof createRetainedHistoryCheckpointWriter> | undefined, closed = false, busy = false, fenced = false;
  let observing = 0;
  let restoration: Awaited<ReturnType<typeof openPolicyObserverRestoration>> | undefined;
  // Only the committed and pending states are needed after opening. All retained
  // ciphertext is authenticated and replayed before these cached states are used.
  const states = new Map<string, AdmissionPolicyObserverState>();
  const resolved = new Map<string, ResolvedAdmissionPolicy>();
  const archiveBounds = policyObserverArchiveLimits(options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES, 30000);
  function pageReader(signal?: AbortSignal, account?: (bytes: number) => void) {
    return createPolicyObserverPageReader({ source: function* () { if (options.ancestrySource) yield* options.ancestrySource(); if (writer) yield* writer.history(); },
      historyContext, key, maxBlocks: options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maxBytes: options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES, timeoutMs: 30000, signal, account });
  }
  async function validateCurrent(state: AdmissionPolicyObserverState, reader = pageReader(), signal?: AbortSignal) {
    if (state.policy.version !== 3) return;
    const capability = resolved.get(historyCheckpointEnvelopeId(retained().block));
    if (!capability) throw new Error('V3 observer requires resolved retained original ancestry');
    await lookupResolvedAdmissionPolicyKey({ policy: capability, issuerKey: state.policy.activeKey, reader, limits: archiveBounds, signal });
  }
  function close() { if (!closed) { closed = true; writer?.close(); restoration?.close(); signer.secretKey.fill(0); key.fill(0); states.clear(); resolved.clear(); } }
  function live() { if (closed) throw new Error('Protected policy observer is closed'); }
  async function decode(block: HistoryCheckpointEnvelope) {
    if (block.generation !== root.generation) throw new Error('Policy observer snapshot belongs to another generation');
    return decodePolicyObserverSnapshot(block, historyContext, context, key, true);
  }
  function retained() {
    live(); const saved = writer!.read(), block = saved.pending ?? saved.committed?.envelope ?? root;
    const state = states.get(historyCheckpointEnvelopeId(block));
    if (!state) throw new Error('Policy observer history has not been authenticated');
    return { saved, block, state };
  }
  function trim() {
    const saved = writer!.read(), keep = new Set([rootId,
      ...(saved.committed ? [historyCheckpointEnvelopeId(saved.committed.envelope)] : []),
      ...(saved.pending ? [historyCheckpointEnvelopeId(saved.pending)] : [])]);
    for (const id of states.keys()) if (!keep.has(id)) { states.delete(id); resolved.delete(id); }
  }
  function usable(state: AdmissionPolicyObserverState) {
    if (state.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations');
    assertPolicyObserverCurrent(state.policy, now());
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    live(); if (fenced) throw new Error('Policy observer is permanently fenced for recovery');
    if (busy || observing) throw new Error('Protected policy observer operation is already in progress'); busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function confirm(operation?: {signal?: AbortSignal; deadline?: number}) {
    const { block } = retained(); await writer!.replicate(block, operation); live(); trim(); return retained();
  }
  async function applyAdvance(value: unknown, archivePages: readonly { digest: string; bytes: Uint8Array }[], operation?: ReturnType<typeof createPolicyObserverRemoteOperation>) {
      if (!Array.isArray(archivePages) || archivePages.length > 2) throw new Error('Observer append payload exceeds its page bound');
      const input = structuredClone(value), supplied = archivePages.map(page => ({ digest: page.digest, data: Buffer.from(page.bytes).toString('base64url') }));
      if (supplied.length > 2) throw new Error('Observer append payload exceeds its page bound');
      operation?.live();
      const read = <T>(work: () => Promise<T>) => operation ? operation.wait(work) : work();
      const { state, block, saved } = retained();
      const validationReader = pageReader(operation?.signal);
      let next: AdmissionPolicyObserverState, capability = resolved.get(historyCheckpointEnvelopeId(block));
      if ((input as { policy?: { version?: unknown } })?.policy?.version === 3) {
        if (!exactWitnessFields(input, ['commitment','policy'])) throw new Error('Invalid v3 observer advance');
        const policy = await read(() => verifyAdmissionPolicyV3(input.policy, context.authority)), commitment = parseAdmissionPolicyAdvanceCommitment(input.commitment, context);
        if (policy.revision !== commitment.next.revision || archivedAdmissionPolicyDigest(policy) !== commitment.next.digest) throw new Error('V3 observer body differs from signed digest');
        if (state.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations');
        if (commitment.next.revision === policyObserverStateHead(state, context).revision && state.advance) {
          if (sameAdmissionPolicyHead(commitment.next, state.advance.next) && sameAdmissionPolicyHead(commitment.previous, state.advance.previous)) next = state;
          else next = { ...state, conflict: commitment };
        } else {
          if (!capability) throw new Error('V3 migration requires retained original resolved ancestry');
          next = await read(() => parsePolicyObserverSnapshot({ version: 2, contextId: admissionPolicyObserversId(context), policy, previous: state.policy, advance: commitment,
            conflict: null, archiveAppend: supplied }, context));
          capability = await read(() => resolveObserverSnapshot(next, context, { previous: capability!, reader: validationReader, limits: archiveBounds, signal: operation?.signal }));
        }
      } else {
        if (supplied.length) throw new Error('Legacy observer advance refuses archive pages');
        const advance = await read(() => parseAdmissionPolicyAdvance(input, context)); live();
        next = advanceAdmissionPolicyObserverState(state, advance, context);
        if (next !== state && !next.conflict && capability) capability = await read(() => resolveObserverSnapshot(next, context, { previous: capability!, reader: validationReader, limits: archiveBounds, signal: operation?.signal }));
      }
      if (next === state) { await confirm(operation); usable(state); await read(() => validateCurrent(state, validationReader, operation?.signal)); return structuredClone(policyObserverStateHead(state, context)); }
      if (saved.pending) throw new Error('Complete the pending policy observer history first');
      if (!saved.committed) throw new Error('Confirm the policy observer genesis before advancing');
      if (!next.conflict) assertPolicyObserverCurrent(next.policy, now());
      operation?.live();
      const plaintext = Buffer.from(JSON.stringify(next));
      if (plaintext.length > ADMISSION_POLICY_OBSERVER_MAX_BYTES) throw new Error('Policy observer snapshot exceeds its existing byte bound');
      let pending: HistoryCheckpointEnvelope;
      try {
        if (block.sequence >= Number.MAX_SAFE_INTEGER - 2) throw new Error('Policy observer history sequence exhausted');
        const header = { kind: 'checkpoint' as const, generation: root.generation, sequence: block.sequence + 1, previous: historyCheckpointEnvelopeId(block) };
        // Keep room for the one terminal conflict record even at archive capacity.
        const reservedBytes = next.conflict ? 0 : historyCheckpointEnvelopeByteLength({ context: historyContext,
          header: { ...header, sequence: header.sequence + 1 }, plaintextBytes: plaintext.length + 4096 });
        const reservedHeader = reservedBytes ? { ...header, checkpointReserveBytes: historyCheckpointReserveBucket(reservedBytes) } : header;
        const bytes = historyCheckpointEnvelopeByteLength({ context: historyContext, header: reservedHeader, plaintextBytes: plaintext.length });
        const usage = writer!.historyUsage();
        if (!next.conflict && (usage.retainedBlocks + 2 > usage.maximumBlocks
          || usage.retainedCiphertextBytes + bytes + reservedBytes > usage.maximumCiphertextBytes)) throw new Error('Policy observer archive needs conflict headroom');
        // A conflict must still reach the durable writer intent if an operator
        // has lowered archive limits since the preceding reservation. Replication
        // may then refuse, but reopen must retain the terminal pending fence.
        pending = sealHistoryCheckpoint({ context: historyContext, header: reservedHeader, plaintext, encryptionKey: key, signingKey: signer });
      } finally { plaintext.fill(0); }
      states.set(historyCheckpointEnvelopeId(pending), next); if (capability) resolved.set(historyCheckpointEnvelopeId(pending), capability);
      try { operation?.live(); await writer!.replicate(pending, operation); live(); }
      finally { trim(); }
      usable(next); await read(() => validateCurrent(next, validationReader, operation?.signal)); operation?.live(); return structuredClone(policyObserverStateHead(next, context));
  }
  const fencePath = join(writerOptions.directory, POLICY_OBSERVER_RECOVERY_FENCE);
  const stateDigest = () => historyDigest(JSON.stringify(retained().state));
  function fenceRecord() { return { version: 1, contextId: historyCheckpointContextId(historyContext), genesisId, rootId, stateDigest: stateDigest() }; }
  function openFence(mode: 'create-new' | 'open-existing') {
    const expected = fenceRecord();
    return run(() => openEncryptedLocalState<typeof expected>({ path: fencePath, key, domain: 'resonance:policy-observer-recovery-fence:v1',
      maxBytes: 4096, mode, initial: expected, validate: (value): value is typeof expected =>
        exactWitnessFields(value, ['version', 'contextId', 'genesisId', 'rootId', 'stateDigest'])
        && Object.keys(expected).every(field => value[field] === expected[field as keyof typeof expected]) }));
  }
  try {
    const expected = policyObserverHistoryContext(context, Buffer.from(signer.publicKey).toString('base64url'));
    if (historyCheckpointContextId(historyContext) !== historyCheckpointContextId(expected)) throw new Error('Wrong protected policy observer history pins');
    if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Policy observer requires its independently pinned genesis');
    const initial = await decodePolicyObserverSnapshot(genesis, historyContext, context, key);
    if (initial.previous !== null) throw new Error('Policy observer root must contain its initial policy');
    let baseline = initial;
    let baselineResolved: ResolvedAdmissionPolicy | undefined = await resolveAdmissionPolicy({ context, genesis: initial.policy, advances: [], selectedHead: context.genesis,
      reader: pageReader(), limits: archiveBounds });
    if (root.kind === 'continuation') {
      let replay: Awaited<ReturnType<typeof replayPolicyObserverHistory>> | undefined;
      if (options.ancestrySource) replay = await replayPolicyObserverHistory({ context, historyContext, genesisId, proposal: root.proposal, encryptionKey: key,
        blocks: options.ancestrySource(), blockSource: options.ancestrySource });
      restoration = await openPolicyObserverRestoration({ directory: writerOptions.directory, encryptionKey: key, context,
        historyContext, genesisId, root, mode, restore, expectedReplayDigest, resolved: replay?.resolved });
      baseline = restoration.state; baselineResolved = replay?.resolved;
      if (replay && JSON.stringify(replay.state) !== JSON.stringify(baseline)) throw new Error('Restored baseline differs from retained original ancestry');
    } else if (rootId !== genesisId || root.generation !== 0 || root.sequence !== 0 || restore) throw new Error('Invalid policy observer root or restoration');
    states.set(rootId, baseline); if (baselineResolved) resolved.set(rootId, baselineResolved);
    if (initializeWriter && mode === 'open-existing' && existsSync(join(writerOptions.directory, 'payloads'))) {
      throw new Error('Cannot recreate a missing observer writer alongside retained archive evidence');
    }
    writer = createRetainedHistoryCheckpointWriter(writerOptions);
    let priorResolved = baselineResolved;
    let previous: AdmissionPolicyObserverState | undefined, last: HistoryCheckpointEnvelope | undefined;
    const start = performance.now(); let count = 0, readBlocks = 0, readBytes = 0;
    const account = (size: number) => { if (++readBlocks > (options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS) || (readBytes += size) > (options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES)) throw new Error('Observer opening cumulative read budget exceeded'); };
    const openingReader = pageReader(undefined, account);
    const saved = writer.read();
    for (const block of writer.history()) {
      if (performance.now() - start >= 30000) throw new Error('Policy observer replay timed out');
      account(Buffer.byteLength(JSON.stringify(block)));
      const id = historyCheckpointEnvelopeId(block), state = id === rootId ? baseline : await decode(block);
      if (!previous) { if (id !== rootId) throw new Error('Policy observer history lost its genesis'); }
      else {
        if (block.sequence !== last!.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(last!)) throw new Error('Policy observer history has a gap');
        assertPolicyObserverStateSuccessor(previous, state, context);
        if (!state.conflict && priorResolved) priorResolved = await resolveObserverSnapshot(state, context, { previous: priorResolved, reader: openingReader, limits: archiveBounds });
        else if (state.policy.version === 3 && !priorResolved) throw new Error('V3 observer lost resolved original ancestry');
      }
      if (id === rootId || saved.committed && id === historyCheckpointEnvelopeId(saved.committed.envelope) || saved.pending && id === historyCheckpointEnvelopeId(saved.pending))  { states.set(id, state); if (priorResolved) resolved.set(id, priorResolved); }
      previous = state; last = block;
      if (++count % 16 === 0) await yieldToEventLoop();
    }
    if (saved.pending && !states.has(historyCheckpointEnvelopeId(saved.pending))) {
      const pending = saved.pending, state = await decode(pending);
      if (previous) assertPolicyObserverStateSuccessor(previous, state, context);
      else if (historyCheckpointEnvelopeId(pending) !== rootId) throw new Error('Policy observer pending history lost its genesis');
      if (!state.conflict && priorResolved) priorResolved = await resolveObserverSnapshot(state, context, { previous: priorResolved, reader: openingReader, limits: archiveBounds });
      else if (state.policy.version === 3 && !priorResolved) throw new Error('V3 pending observer lost original ancestry');
      states.set(historyCheckpointEnvelopeId(pending), state); if (priorResolved) resolved.set(historyCheckpointEnvelopeId(pending), priorResolved);
    }
    if (performance.now() - start >= 30000) throw new Error('Policy observer replay timed out');
    retained();
    if (existsSync(fencePath)) { const marker = openFence('open-existing'); marker.close(); fenced = true; }
  } catch (error) { close(); throw error; }
  return {
    maximumConcurrentObservations,
    /** Local capability only: callers must be captured before the common read begins. */
    maximumObservationBatchSize: maximumConcurrentObservations,
    /** Aggregate local observations: no history replay, copies of policy content,
     * signatures or network probes. This does not establish a current quorum. */
    health() {
      const { state, saved } = retained(); let policyCurrent = true;
      try { assertPolicyObserverCurrent(state.policy, now()); } catch { policyCurrent = false; }
      return { pending: saved.pending !== null, policyCurrent, blocked: state.conflict !== null, fenced, ...writer!.historyUsage() };
    },
    status() {
      const { state, saved } = retained();
      return { head: structuredClone(policyObserverStateHead(state, context)), blocked: state.conflict !== null,
        pending: saved.pending !== null, fenced, evidence: state.conflict ? structuredClone([state.advance!, state.conflict]) : [], ...writer!.historyUsage() };
    },
    policy() { return structuredClone(retained().state.policy); },
    /** Read a signed successor from authenticated retained local history. This
     * makes no freshness claim and does not create or repair missing evidence. */
    async successor(value: unknown, signal?: AbortSignal) {
      live(); signal?.throwIfAborted(); const previous = parseAdmissionPolicyHead(value);
      const current = retained();
      if (current.state.conflict || current.saved.pending) throw new Error('Observer policy history is unavailable for transfer');
      const baseline = states.get(rootId)!, baselineHead = policyObserverStateHead(baseline, context);
      let state = baseline;
      if (!baseline.advance || !sameAdmissionPolicyHead(baseline.advance.previous, previous)) {
        const sequence = previous.revision - baselineHead.revision + 1;
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > (current.saved.committed?.envelope.sequence ?? -1)) {
          if (!options.ancestrySource || root.kind !== 'continuation') throw new PolicySuccessorUnavailableError('Requested policy successor is outside this retained generation');
          const replay = await replayPolicyObserverHistory({ context, historyContext, genesisId, proposal: root.proposal, encryptionKey: key,
            blocks: options.ancestrySource(), blockSource: options.ancestrySource, successorOf: previous, signal, timeoutMs: 3000 });
          live(); signal?.throwIfAborted();
          const latest = retained();
          if (latest.state.conflict || latest.saved.pending) throw new Error('Observer policy history changed during archive transfer');
          if (replay.state.conflict || !replay.successor) throw new PolicySuccessorUnavailableError('Requested successor absent from retained original ancestry');
          return replay.successor;
        }
        state = await decode(writer!.historyBlock(sequence)); live(); signal?.throwIfAborted();
      }
      if (state.conflict || !state.advance || !sameAdmissionPolicyHead(state.advance.previous, previous)) throw new Error('Retained policy successor differs from request');
      const latest = retained();
      if (latest.state.conflict || latest.saved.pending) throw new Error('Observer policy history changed during transfer');
      return structuredClone({ commitment: state.advance, policy: state.policy });
    },
    async archivePage(digest: string, signal?: AbortSignal) {
      live(); signal?.throwIfAborted(); const current = retained();
      if (busy || observing >= maximumConcurrentObservations || current.saved.pending || current.state.conflict) throw new Error('Observer archive is unavailable during pending/conflicting work');
      const reader = pageReader(signal);
      observing++;
      try { await validateCurrent(current.state, reader, signal); const bytes = await reader(digest, signal ?? new AbortController().signal); live(); signal?.throwIfAborted(); return bytes; }
      finally { observing--; }
    },
    /** Local knowledge for explicit recovery review, including an unacknowledged
     * pending head/conflict. This is neither a global view nor signing readiness. */
    recoveryState() { return structuredClone(retained().state); },
    /** Review is read-only. Applying its capability first durably confirms all
     * local evidence, then fences this directory before remote freeze begins. */
    reviewRecoverySource(): PolicyObserverRecoverySource {
      live(); if (busy || observing) throw new Error('Cannot review an active policy observer');
      const state = structuredClone(retained().state), digest = stateDigest();
      const source = Object.freeze({ directory: resolve(writerOptions.directory), contextId: historyCheckpointContextId(historyContext),
        genesisId, rootId, generation: root.generation, stateDigest: digest });
      recoverySources.set(source, { state, async fence() {
        live(); if (busy || observing) throw new Error('Cannot fence an active policy observer');
        if (stateDigest() !== digest) throw new Error('Policy observer changed since recovery review');
        if (fenced) return;
        busy = true;
        try {
          // An existing write certificate already proves four durable copies.
          // A frozen predecessor may no longer answer a fresh write, but its
          // committed state must still be preserved by the selected ancestry.
          const saved = retained().saved;
          if (saved.pending || !saved.committed) await confirm();
          live(); // Pending conflicts are copied without asking usable() to sign them.
          if (stateDigest() !== digest) throw new Error('Policy observer changed during recovery confirmation');
          try { const marker = openFence('create-new'); marker.close(); fenced = true; }
          catch (error) { close(); throw error; } // Never guess whether a failed flush published the fence.
        } finally { busy = false; }
      } });
      return source;
    },
    /** No persistent ready flag: every observation performs another fresh check. */
    ready() { return exclusive(async () => { const { state } = await confirm(); usable(state); await validateCurrent(state); }); },
    async observeBatch(values: readonly unknown[], checks: readonly (() => void)[] = []): Promise<PromiseSettledResult<AdmissionPolicyHeadVote>[]> {
      live(); if (fenced) throw new Error('Policy observer is permanently fenced for recovery');
      if (!Array.isArray(values) || !values.length || values.length > maximumConcurrentObservations
        || checks.length !== 0 && (checks.length !== values.length || checks.some(check => typeof check !== 'function'))) {
        throw new Error('Invalid policy observation batch');
      }
      if (busy || observing + values.length > maximumConcurrentObservations) throw new Error('Protected policy observer operation is already in progress');
      // Snapshot every caller before beginning any shared freshness work. These
      // checks are trusted local closures, never fields accepted from the wire.
      const localChecks = [...checks], started = performance.now();
      const requests = values.map(value => parseAdmissionPolicyHeadRequest(value, context, now()));
      const budgets = requests.map(request => request.expiresAt - now());
      observing += requests.length;
      try {
        const refused = requests.map((_request, index): PromiseRejectedResult | undefined => {
          try { localChecks[index]?.(); } catch (reason) { return { status: 'rejected', reason }; }
        });
        if (refused.every(result => result !== undefined)) return refused as PromiseRejectedResult[];
        const validationReader = pageReader();
        const before = retained(); usable(before.state); await validateCurrent(before.state, validationReader);
        if (before.saved.pending) throw new Error('Complete the pending policy observer history first');
        if (!before.saved.committed) throw new Error('Confirm the policy observer root before observing');
        await writer!.observeCurrent(); live(); const { state } = retained(); usable(state); await validateCurrent(state, validationReader);
        return requests.map((request, index): PromiseSettledResult<AdmissionPolicyHeadVote> => {
          if (refused[index]) return refused[index]!;
          try {
            const current = () => {
              localChecks[index]?.(); live(); usable(state);
              if (performance.now() - started >= budgets[index]) throw new Error('Policy observation completed too late');
              parseAdmissionPolicyHeadRequest(request, context, now());
            };
            current(); const vote = createAdmissionPolicyHeadVote(request, policyObserverStateHead(state, context), context, signer, now());
            current(); return { status: 'fulfilled', value: vote };
          } catch (reason) { return { status: 'rejected', reason }; }
        });
      } finally { observing -= requests.length; }
    },
    async observe(value: unknown) {
      live(); if (fenced) throw new Error('Policy observer is permanently fenced for recovery');
      if (busy || observing >= maximumConcurrentObservations) throw new Error('Protected policy observer operation is already in progress');
      observing++;
      try {
        const request = parseAdmissionPolicyHeadRequest(value, context, now()), started = performance.now(), remaining = request.expiresAt - now();
        const validationReader = pageReader();
        const before = retained(); usable(before.state); await validateCurrent(before.state, validationReader);
        if (before.saved.pending) throw new Error('Complete the pending policy observer history first');
        if (!before.saved.committed) throw new Error('Confirm the policy observer root before observing');
        await writer!.observeCurrent(); live(); const { state } = retained(); await validateCurrent(state, validationReader);
        if (performance.now() - started >= remaining) throw new Error('Policy observation completed too late');
        usable(state); return createAdmissionPolicyHeadVote(request, policyObserverStateHead(state, context), context, signer, now());
      } finally { observing--; }
    },
    advance(value: unknown, archivePages: readonly { digest: string; bytes: Uint8Array }[] = []) { return exclusive(() => applyAdvance(value, archivePages)); },
    advanceRemote(value: unknown, request: { deadline: number; signal?: AbortSignal; check?: () => void }) { return exclusive(async () => {
      if (!options.remoteArchive) throw new Error('Observer does not support remote v3 archive ingestion');
      const input = structuredClone(value), operation = createPolicyObserverRemoteOperation({ ...request, archive: options.remoteArchive });
      try {
        if (!exactWitnessFields(input, ['commitment','policy'])) throw new Error('Invalid remote v3 advance');
        const commitment = parseAdmissionPolicyAdvanceCommitment(input.commitment, context);
        const policy = await operation.wait(() => verifyAdmissionPolicyV3(input.policy, context.authority));
        if (policy.revision !== commitment.next.revision || archivedAdmissionPolicyDigest(policy) !== commitment.next.digest
          || policy.archive.contextId !== admissionPolicyObserversId(context)) throw new Error('Remote v3 advance differs from pinned signed head/context');
        const before = retained();
        if (before.state.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations');
        // Duplicates/conflicts use the already retained pages and existing terminal-fence path.
        if (commitment.next.revision === policyObserverStateHead(before.state, context).revision) return await applyAdvance(input, [], operation);
        if (before.saved.pending || !before.saved.committed || !sameAdmissionPolicyHead(commitment.previous, policyObserverStateHead(before.state, context))) throw new Error('Remote v3 advance requires the exact committed predecessor');
        if (before.state.policy.version === 1) throw new Error('Remote v3 migration requires a v2 predecessor');
        const prefix = before.state.policy.version === 3 ? before.state.policy.archive : emptyAdmissionPolicyArchive(admissionPolicyObserversId(context));
        const count = policy.archive.pageCount - prefix.pageCount;
        if (count < 0 || count > 2 || policy.archive.entryCount < prefix.entryCount || policy.archive.archiveBytes < prefix.archiveBytes) throw new Error('Remote v3 append exceeds its immutable prefix envelope');
        const pages: Array<{digest: string; bytes: Uint8Array}> = [];
        let digest = policy.archive.root, remaining = policy.archive.entryCount, total = 0;
        for (let index = policy.archive.pageCount - 1; index >= prefix.pageCount; index--) {
          if (!digest) throw new Error('Remote v3 append omitted its page root');
          const bytes = await operation.page(context, commitment.next, digest, Buffer.from(signer.publicKey).toString('base64url'));
          const page = await operation.wait(() => decodeAdmissionPolicyArchivePage(bytes));
          remaining -= page.entries.length; total += bytes.length;
          if (page.contextId !== policy.archive.contextId || page.index !== index || page.firstEntry !== remaining) throw new Error('Remote v3 archive page order/context differs');
          pages.unshift({digest,bytes}); digest = page.previous;
        }
        if (digest !== prefix.root || remaining !== prefix.entryCount || total !== policy.archive.archiveBytes - prefix.archiveBytes) throw new Error('Remote v3 append rewrote its exact old root prefix');
        operation.live();
        if (historyCheckpointEnvelopeId(retained().block) !== historyCheckpointEnvelopeId(before.block)) throw new Error('Remote predecessor changed during page acquisition');
        return await applyAdvance(input, pages, operation);
      } finally { operation.close(); }
    }); },

    close,
  };
}
