/** Experimental policy observer backed by the existing four-copy history writer.
 * Explicit configuration is required; reopening never reconstructs lost state. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { assertAdmissionPolicyCurrent } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, createAdmissionPolicyHeadVote, parseAdmissionPolicyHeadRequest,
  parseAdmissionPolicyObservers, parseAdmissionPolicyHead, type AdmissionPolicyObservers, type AdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionPolicyAdvance, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyCheckpointEnvelopeByteLength, historyCheckpointReserveBucket, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
import { advanceAdmissionPolicyObserverState, assertPolicyObserverStateSuccessor,
  parseAdmissionPolicyObserverState, policyObserverStateHead, type AdmissionPolicyObserverState } from './admission-policy-observer-state.js';

import { decodePolicyObserverSnapshot, policyObserverHistoryContext } from './policy-observer-history-replay.js';
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
    assertAdmissionPolicyCurrent(state.policy, now());
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
  function close() { if (!closed) { closed = true; writer?.close(); restoration?.close(); signer.secretKey.fill(0); key.fill(0); states.clear(); } }
  function live() { if (closed) throw new Error('Protected policy observer is closed'); }
  async function decode(block: HistoryCheckpointEnvelope) {
    if (block.generation !== root.generation) throw new Error('Policy observer snapshot belongs to another generation');
    return decodePolicyObserverSnapshot(block, historyContext, context, key);
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
    for (const id of states.keys()) if (!keep.has(id)) states.delete(id);
  }
  function usable(state: AdmissionPolicyObserverState) {
    if (state.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations');
    assertAdmissionPolicyCurrent(state.policy, now());
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    live(); if (fenced) throw new Error('Policy observer is permanently fenced for recovery');
    if (busy || observing) throw new Error('Protected policy observer operation is already in progress'); busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function confirm() {
    const { block } = retained(); await writer!.replicate(block); live(); trim(); return retained();
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
    if (root.kind === 'continuation') {
      restoration = await openPolicyObserverRestoration({ directory: writerOptions.directory, encryptionKey: key, context,
        historyContext, genesisId, root, mode, restore, expectedReplayDigest });
      baseline = restoration.state;
    } else if (rootId !== genesisId || root.generation !== 0 || root.sequence !== 0 || restore) throw new Error('Invalid policy observer root or restoration');
    states.set(rootId, baseline);
    if (initializeWriter && mode === 'open-existing' && existsSync(join(writerOptions.directory, 'payloads'))) {
      throw new Error('Cannot recreate a missing observer writer alongside retained archive evidence');
    }
    writer = createRetainedHistoryCheckpointWriter(writerOptions);
    let previous: AdmissionPolicyObserverState | undefined, last: HistoryCheckpointEnvelope | undefined;
    const start = performance.now(); let count = 0;
    const saved = writer.read();
    for (const block of writer.history()) {
      if (performance.now() - start >= 30000) throw new Error('Policy observer replay timed out');
      const id = historyCheckpointEnvelopeId(block), state = id === rootId ? baseline : await decode(block);
      if (!previous) { if (id !== rootId) throw new Error('Policy observer history lost its genesis'); }
      else {
        if (block.sequence !== last!.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(last!)) throw new Error('Policy observer history has a gap');
        assertPolicyObserverStateSuccessor(previous, state, context);
      }
      if (id === rootId || saved.committed && id === historyCheckpointEnvelopeId(saved.committed.envelope) || saved.pending && id === historyCheckpointEnvelopeId(saved.pending)) states.set(id, state);
      previous = state; last = block;
      if (++count % 16 === 0) await yieldToEventLoop();
    }
    if (saved.pending && !states.has(historyCheckpointEnvelopeId(saved.pending))) {
      const pending = saved.pending, state = await decode(pending);
      if (previous) assertPolicyObserverStateSuccessor(previous, state, context);
      else if (historyCheckpointEnvelopeId(pending) !== rootId) throw new Error('Policy observer pending history lost its genesis');
      states.set(historyCheckpointEnvelopeId(pending), state);
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
      try { assertAdmissionPolicyCurrent(state.policy, now()); } catch { policyCurrent = false; }
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
          throw new PolicySuccessorUnavailableError('Requested policy successor is outside this retained generation');
        }
        state = await decode(writer!.historyBlock(sequence)); live(); signal?.throwIfAborted();
      }
      if (state.conflict || !state.advance || !sameAdmissionPolicyHead(state.advance.previous, previous)) throw new Error('Retained policy successor differs from request');
      const latest = retained();
      if (latest.state.conflict || latest.saved.pending) throw new Error('Observer policy history changed during transfer');
      return structuredClone({ commitment: state.advance, policy: state.policy });
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
    ready() { return exclusive(async () => { const { state } = await confirm(); usable(state); }); },
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
        const before = retained(); usable(before.state);
        if (before.saved.pending) throw new Error('Complete the pending policy observer history first');
        if (!before.saved.committed) throw new Error('Confirm the policy observer root before observing');
        await writer!.observeCurrent(); live(); const { state } = retained(); usable(state);
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
        const before = retained(); usable(before.state);
        if (before.saved.pending) throw new Error('Complete the pending policy observer history first');
        if (!before.saved.committed) throw new Error('Confirm the policy observer root before observing');
        await writer!.observeCurrent(); live(); const { state } = retained();
        if (performance.now() - started >= remaining) throw new Error('Policy observation completed too late');
        usable(state); return createAdmissionPolicyHeadVote(request, policyObserverStateHead(state, context), context, signer, now());
      } finally { observing--; }
    },
    advance(value: unknown) { return exclusive(async () => {
      const advance = await parseAdmissionPolicyAdvance(value, context); live();
      const { state, block, saved } = retained();
      const next = advanceAdmissionPolicyObserverState(state, advance, context);
      if (next === state) { await confirm(); usable(state); return structuredClone(policyObserverStateHead(state, context)); }
      if (saved.pending) throw new Error('Complete the pending policy observer history first');
      if (!saved.committed) throw new Error('Confirm the policy observer genesis before advancing');
      if (!next.conflict) assertAdmissionPolicyCurrent(next.policy, now());
      const plaintext = Buffer.from(JSON.stringify(next));
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
      states.set(historyCheckpointEnvelopeId(pending), next);
      try { await writer!.replicate(pending); live(); }
      finally { trim(); }
      usable(next); return structuredClone(policyObserverStateHead(next, context));
    }); },
    close,
  };
}
