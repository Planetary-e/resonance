/** Experimental policy observer backed by the existing four-copy history writer.
 * No production admission/CLI wiring and no automatic lost-state reconstruction. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { assertAdmissionPolicyCurrent } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, createAdmissionPolicyHeadVote, parseAdmissionPolicyHeadRequest,
  parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyCheckpointEnvelopeByteLength, historyCheckpointReserveBucket,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
import { advanceAdmissionPolicyObserverState, assertPolicyObserverStateSuccessor,
  parseAdmissionPolicyObserverState, policyObserverStateHead, type AdmissionPolicyObserverState } from './admission-policy-observer-state.js';

import { decodePolicyObserverSnapshot, policyObserverHistoryContext } from './policy-observer-history-replay.js';
import { openPolicyObserverRestoration, type PreparedPolicyObserverRestore } from './policy-observer-history-restore.js';
export { policyObserverHistoryContext } from './policy-observer-history-replay.js';

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
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  now?: () => number;
}) {
  if (!['create-new', 'open-existing'].includes(options.mode)) throw new Error('Protected policy observer requires an explicit open mode');
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Protected policy observer requires a 32-byte encryption key');
  const context = parseAdmissionPolicyObservers(options.context), historyContext = parseHistoryCheckpointContext(options.historyContext);
  const root = parseHistoryCheckpointEnvelope(options.root, historyContext), rootId = historyCheckpointEnvelopeId(root);
  const genesis = parseHistoryCheckpointEnvelope(options.genesis ?? root, historyContext), genesisId = historyCheckpointEnvelopeId(genesis);
  const mode = options.mode, restore = options.restore && { ...options.restore }, initializeWriter = options.initializeWriter;
  const signer = copyAdmissionSigningKey(options.signingKey), key = Uint8Array.from(options.encryptionKey), now = options.now ?? Date.now;
  const writerOptions = { directory: options.directory, localKey: key, context: historyContext, signingKey: signer, rootId, generation: root.generation, genesisId,
    ...(root.kind === 'continuation' ? { continuation: root } : {}),
    members: structuredClone(options.members), initialize: mode === 'create-new' || initializeWriter, requireCurrentHead: true,
    initializeArchive: options.initializeArchive, resumePristineArchive: options.resumePristineArchive,
    timeoutMs: options.timeoutMs ?? 3000, transport: options.transport,
    maxArchiveBlocks: options.maxArchiveBlocks, maxArchiveBytes: options.maxArchiveBytes };
  let writer: ReturnType<typeof createRetainedHistoryCheckpointWriter> | undefined, closed = false, busy = false;
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
    live(); if (busy) throw new Error('Protected policy observer operation is already in progress'); busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function confirm() {
    const { block } = retained(); await writer!.replicate(block); live(); trim(); return retained();
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
        historyContext, genesisId, root, mode, restore });
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
  } catch (error) { close(); throw error; }
  return {
    status() {
      const { state, saved } = retained();
      return { head: structuredClone(policyObserverStateHead(state, context)), blocked: state.conflict !== null,
        pending: saved.pending !== null, evidence: state.conflict ? structuredClone([state.advance!, state.conflict]) : [], ...writer!.historyUsage() };
    },
    policy() { return structuredClone(retained().state.policy); },
    /** Local knowledge for explicit recovery review, including an unacknowledged
     * pending head/conflict. This is neither a global view nor signing readiness. */
    recoveryState() { return structuredClone(retained().state); },
    /** No persistent ready flag: every observation performs another fresh check. */
    ready() { return exclusive(async () => { const { state } = await confirm(); usable(state); }); },
    observe(value: unknown) { return exclusive(async () => {
      const request = parseAdmissionPolicyHeadRequest(value, context, now()), started = performance.now(), remaining = request.expiresAt - now();
      const before = retained(); usable(before.state);
      if (before.saved.pending) throw new Error('Complete the pending policy observer history first');
      if (!before.saved.committed) throw new Error('Confirm the policy observer root before observing');
      await writer!.observeCurrent(); live(); const { state } = retained();
      if (performance.now() - started >= remaining) throw new Error('Policy observation completed too late');
      usable(state); return createAdmissionPolicyHeadVote(request, policyObserverStateHead(state, context), context, signer, now());
    }); },
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
