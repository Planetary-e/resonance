import { copyAdmissionReplayValue } from '@resonance/core';
import { ownAdmissionReplayValue, isOwnedAdmissionReplayValue, chargeAdmissionReplayCopy } from '@resonance/core';
import { createHash } from 'node:crypto';
import { createAdmissionOriginalReferences, originalReferenceWorkBudget, type OriginalReferenceWorkBudget } from './admission-original-references.js';
/** Policy evidence lives only in the role's funded authenticated retained history.
 * Readers retain one checkpoint/page at a time and share core operation accounting. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { AdmissionPolicyArchiveBudget, AdmissionPolicyArchiveExecutionContext } from '@resonance/core/admission-policy-archive';
import { parseAdmissionPolicyProofReference, parseAdmissionPolicyProofAppend, resolveAdmissionPolicy, resolveAdmissionPolicyAdvance, inspectResolvedAdmissionPolicy, archivedAdmissionPolicyDigest, type AdmissionPolicyProofReference, type AdmissionPolicyProofAppend, type AdmissionPolicyArchiveReader, type ResolvedAdmissionPolicy, type ArchivedAdmissionPolicy, type AdmissionPolicyHistoryMembership } from '@resonance/core/admission-policy-archive';
import { admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { assertHistorySuccessorChain } from '@resonance/core/history-successor';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { openHistoryCheckpoint, historyCheckpointContextId, HISTORY_ENVELOPE_MAX_BYTES, HISTORY_DELTA_MAX_PAYLOAD, type HistoryCheckpointContext, historyCheckpointEnvelopeId, parseHistoryCheckpointEnvelope, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';

export interface PolicyProofImage { policyProof?: AdmissionPolicyProofReference; policyProofAppend?: AdmissionPolicyProofAppend }
export interface PolicyProofOperation { budget?: AdmissionPolicyArchiveBudget; startup?: AdmissionPolicyArchiveExecutionContext; originalReferenceWork?: OriginalReferenceWorkBudget }
export function policyProofBudget(operation: PolicyProofOperation | undefined, reference: AdmissionPolicyProofReference, signal?: AbortSignal, deadline?: number) {
  const startup = operation?.startup;
  startup?.check();
  const budget = operation?.budget ?? new AdmissionPolicyArchiveBudget({ limits: reference.limits, signal,
    deadline: startup ? Math.min(startup.executionDeadline, deadline ?? Infinity) : deadline, execution: startup?.execution });
  if (budget.execution.version === 2 && (!startup || JSON.stringify(startup.execution) !== JSON.stringify(budget.execution))) throw new Error('Offline startup budget cannot authorize a live operation');
  if (JSON.stringify(budget.limits) !== JSON.stringify(reference.limits)) throw new Error('Protected proof operation funding bounds changed');
  if (operation) operation.budget = budget;
  budget.addSignal(startup?.controller.signal); budget.addSignal(signal); budget.restrictDeadline(deadline); budget.check();
  return budget;
}
export type PolicyProofCache = Map<string, { policy: ResolvedAdmissionPolicy; reference: AdmissionPolicyProofReference; catalogue: string }>;
export interface PolicyProofHistory {
  source(): Iterable<HistoryCheckpointEnvelope>; context: HistoryCheckpointContext; encryptionKey: Uint8Array;
  /** A not-yet-published complete checkpoint is considered only inside its owner's exclusive operation. */
  candidate?: PolicyProofImage; signal?: AbortSignal; deadline?: number;
  operation?: PolicyProofOperation;
  /** At most current/pending opaque heads; no archive entries or pages are cached. Replay helpers allocate their own operation-local map. */
  cache?: PolicyProofCache;
  membershipCache?: Map<string, AdmissionPolicyHistoryMembership>;
}
/** A capability owned by one replay, never an on-disk or cross-operation cache.
 * Snapshot every envelope before the first await; the main replay still validates
 * the complete selected chain and every business record independently. */
interface ReplayProofProgress {
  context: string; key: Buffer; operation: PolicyProofOperation; sourceBytes: number;
  scope?: string; budget?: AdmissionPolicyArchiveBudget;
  images?: PolicyProofImage[]; loading?: Promise<void>; released: boolean;
  shared: boolean; records: Map<number, unknown>; decoded: number; decode(index: number): unknown;
}
const replayProofSources = new WeakMap<PolicyProofHistory['source'], ReplayProofProgress>();
const replayProofCaches = new WeakMap<PolicyProofCache, ReplayProofProgress>();
const replayMembershipCaches = new WeakMap<Map<string, AdmissionPolicyHistoryMembership>, ReplayProofProgress>();
function freezeReplayValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeReplayValue(child);
    Object.freeze(value);
  }
  return value;
}
export function createPolicyProofReplayHistory(options: PolicyProofHistory & { shareDecodedRecords?: boolean }): PolicyProofHistory & { release(): void } {
  if (!options.operation || (!options.operation.startup && !options.operation.budget)) throw new Error('Proof progress requires one explicit bounded replay operation');
  const operation = options.operation, context = freezeReplayValue(copyAdmissionReplayValue(options.context));
  const key = Buffer.from(options.encryptionKey); let blocks: HistoryCheckpointEnvelope[] = [];
  let bytes = 0;
  try {
    for (const block of options.source()) {
      operation.startup?.check(); operation.budget?.check(); options.signal?.throwIfAborted();
      const encoded = JSON.stringify(block), size = Buffer.byteLength(encoded);
      if (blocks.length >= 10001 || size > HISTORY_ENVELOPE_MAX_BYTES || (bytes += size) > 256 * 1024 * 1024) {
        throw new Error('Proof replay snapshot exceeds existing history capacity');
      }
      if (isOwnedAdmissionReplayValue(block)) blocks.push(block);
      else {
        (operation.originalReferenceWork ?? originalReferenceWorkBudget(operation.startup ?? operation)).charge(size);
        blocks.push(ownAdmissionReplayValue(freezeReplayValue(JSON.parse(encoded) as HistoryCheckpointEnvelope)));
      }
    }
  } catch (error) { key.fill(0); throw error; }
  Object.freeze(blocks);
  const state: ReplayProofProgress = { context: historyCheckpointContextId(context), key: Buffer.from(key), operation, sourceBytes: bytes, released: false, shared: options.shareDecodedRecords === true, records: new Map(), decoded: 0, decode: () => { throw new Error("Replay decoder unavailable"); } };
  const workBudget = operation.originalReferenceWork ?? originalReferenceWorkBudget(operation.startup ?? operation);
  operation.originalReferenceWork = workBudget;
  let originals: ReturnType<typeof createAdmissionOriginalReferences> | undefined;
  let head: HistoryCheckpointEnvelope | undefined, ids: string[] = [];
  state.decode = (index: number) => {
    if (state.released) throw new Error('Proof replay is released');
    operation.startup?.check(); operation.budget?.check(); options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(index) || index < 0 || index >= blocks.length) throw new Error('Proof replay occurrence differs');
    originals ??= createAdmissionOriginalReferences(state.context, { workBudget, check: () => { operation.startup?.check(); operation.budget?.check(); if (state.released) throw new Error('Proof replay is released'); } });
    for (; state.decoded <= index; state.decoded++) {
      const block = parseHistoryCheckpointEnvelope(blocks[state.decoded], context), id = historyCheckpointEnvelopeId(block);
      if (!head) { if (block.kind !== 'checkpoint' || block.generation !== 0 || block.sequence !== 0 || block.previous !== null) throw new Error('Proof replay lost original genesis'); ids = [id]; }
      else if (block.kind === 'continuation') { if (block.proposal.generation !== head.generation || block.generation <= head.generation) throw new Error('Proof replay continuation differs'); assertHistorySuccessorChain(block.proposal, ids); ids = [id]; }
      else { if (block.generation !== head.generation || block.sequence !== head.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(head)) throw new Error('Proof replay has a missing or conflicting tail'); ids.push(id); }
      if (block.kind !== 'continuation') {
        const bytes = openHistoryCheckpoint(block, context, key);
        try { state.records.set(state.decoded, ownAdmissionReplayValue(freezeReplayValue(originals.accept(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)), block.previous, block.kind === 'delta' ? HISTORY_DELTA_MAX_PAYLOAD : undefined)))); }
        finally { bytes.fill(0); }
      }
      head = block;
    }
    return state.records.get(index);
  };
  const source = () => { if (state.released) throw new Error('Proof replay is released'); return blocks; };
  replayProofSources.set(source, state);
  const cache: PolicyProofCache = new Map(), membershipCache = new Map<string, AdmissionPolicyHistoryMembership>();
  replayProofCaches.set(cache, state); replayMembershipCaches.set(membershipCache, state);
  return { ...options, source, context, encryptionKey: key, cache, membershipCache,
    release() { state.released = true; state.images = undefined; state.records.clear(); originals = undefined; head = undefined; ids = []; state.decode = () => { throw new Error("Proof replay is released"); }; blocks = []; cache.clear(); membershipCache.clear(); state.key.fill(0); key.fill(0); } };
}
export function decodePolicyProofReplayRecord(options: PolicyProofHistory, index: number, occurrence: HistoryCheckpointEnvelope): unknown {
  const state = replayProofSources.get(options.source);
  if (!state || !state.shared || state.released || state.operation !== options.operation || state.context !== historyCheckpointContextId(options.context) || !state.key.equals(options.encryptionKey)
    || [...options.source()][index] !== occurrence) throw new Error('Proof replay source/context/key/operation/occurrence changed');
  return state.decode(index);
}
export function createAdmissionPolicyHistoryProof(options: PolicyProofHistory & { reference: AdmissionPolicyProofReference; signal?: AbortSignal }) {
  // Caller-owned candidate metadata is copied before any asynchronous validation.
  options = { ...options, candidate: options.candidate && copyAdmissionReplayValue({ policyProof: options.candidate.policyProof,
    policyProofAppend: options.candidate.policyProofAppend }) };
  const reference = parseAdmissionPolicyProofReference(options.reference);
  const progress = replayProofSources.get(options.source);
  if ((options.cache && replayProofCaches.has(options.cache) && replayProofCaches.get(options.cache) !== progress)
    || (options.membershipCache && replayMembershipCaches.has(options.membershipCache) && replayMembershipCaches.get(options.membershipCache) !== progress)) throw new Error('Proof replay source substituted');
  if (progress && (progress.released || progress.operation !== options.operation
    || progress.context !== historyCheckpointContextId(options.context) || !progress.key.equals(options.encryptionKey))) {
    throw new Error('Proof replay source/context/key/operation changed');
  }
  const budget = policyProofBudget(options.operation, reference, options.signal, options.deadline);
  if (progress) {
    const scope = JSON.stringify([admissionPolicyObserversId(reference.context), reference.limits]);
    if ((progress.scope && progress.scope !== scope) || (progress.budget && progress.budget !== budget)) throw new Error('Proof replay funding/context scope changed');
    progress.scope = scope; progress.budget = budget;
  }
  const execution = options.operation?.startup?.execution;
  const workBudget = options.operation?.originalReferenceWork ?? originalReferenceWorkBudget(options.operation?.startup ?? options.operation ?? budget);
  if (options.operation) options.operation.originalReferenceWork = workBudget;
  let reads = 0;
  async function* originalImages(): AsyncGenerator<PolicyProofImage> {
    const originals = createAdmissionOriginalReferences(historyCheckpointContextId(options.context), { check: () => budget.check(), workBudget });
    let occurrence = 0;
    for (const block of options.source()) {
      const index = occurrence++;
      budget.check(); budget.charge('maxHistoryBytes', Buffer.byteLength(JSON.stringify(block)));
      // Read count is cumulative across ancestry and all page rescans.
      budget.charge('maxPageReads', 1);
      if (++reads % 16 === 0) await budget.wait(() => yieldToEventLoop());
      // Chain-only occurrences must authenticate before publishing any retained image.
      if (progress?.shared) decodePolicyProofReplayRecord(options, index, block);
      if (block.kind !== 'checkpoint' && block.kind !== 'delta') continue;
      const bytes = progress?.shared ? undefined : openHistoryCheckpoint(block, options.context, options.encryptionKey);
      try {
        const raw = (progress?.shared ? decodePolicyProofReplayRecord(options, index, block) : originals.accept(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes!)), block.previous,
          block.kind === 'delta' ? HISTORY_DELTA_MAX_PAYLOAD : undefined)) as Record<string, any>;
        // Relay complete records wrap their business image; issuer records are images.
        const image = raw.kind === 'admission-spend-checkpoint' ? raw : raw.image ?? raw;
        if (image.policyProof !== undefined) {
          const pin = parseAdmissionPolicyProofReference(image.policyProof);
          if (admissionPolicyObserversId(pin.context) !== admissionPolicyObserversId(reference.context)
            || JSON.stringify(pin.limits) !== JSON.stringify(reference.limits)) throw new Error('Retained proof changed original observer pins or funded bounds');
          yield image;
        }
      } finally { bytes?.fill(0); }
    }
  }
  async function* images(): AsyncGenerator<PolicyProofImage> {
    if (!progress) yield* originalImages();
    else {
      if (!progress.loading) progress.loading = (async () => {
        const retained: PolicyProofImage[] = []; let bytes = 0;
        for await (const image of originalImages()) {
          const metadata: PolicyProofImage = { policyProof: parseAdmissionPolicyProofReference(image.policyProof),
            ...(image.policyProofAppend ? { policyProofAppend: parseAdmissionPolicyProofAppend(image.policyProofAppend) } : {}) };
          bytes += Buffer.byteLength(JSON.stringify(metadata));
          if (retained.length >= 10001 || bytes > budget.limits.maxHistoryBytes || bytes + progress.sourceBytes > 256 * 1024 * 1024) throw new Error('Proof replay metadata exceeds existing history capacity');
          retained.push(ownAdmissionReplayValue(freezeReplayValue(metadata)));
        }
        budget.check(); if (progress.released) throw new Error('Proof replay is released');
        progress.images = retained;
      })();
      await budget.wait(() => progress.loading!);
      for (const image of progress.images!) { budget.check(); yield image; }
    }
    if (options.candidate) yield options.candidate;
  }
  const reader: AdmissionPolicyArchiveReader = async (digest, signal) => {
    signal.throwIfAborted(); budget.check();
    // A complete candidate already carries at most two bounded newly appended pages.
    // Core still authenticates their canonical digest and exact signed root membership.
    const staged = options.candidate?.policyProofAppend && parseAdmissionPolicyProofAppend(options.candidate.policyProofAppend);
    const candidatePage = staged?.kind === 'advance' && staged.pages.find(page => page.digest === digest);
    if (candidatePage) return Buffer.from(candidatePage.data, 'base64url');
    for await (const image of images()) {
      const append = image.policyProofAppend && parseAdmissionPolicyProofAppend(image.policyProofAppend);
      if (append?.kind !== 'advance') continue;
      const page = append.pages.find(page => page.digest === digest);
      if (page) { budget.check(); signal.throwIfAborted(); return Buffer.from(page.data, 'base64url'); }
    }
    throw new Error('Required policy page is absent from retained original role history');
  };
  async function resolve(retainIssuerKeys?: readonly string[]): Promise<ResolvedAdmissionPolicy> {
    const catalogue = JSON.stringify(retainIssuerKeys ?? null);
    const appendHash = createHash('sha256').update(JSON.stringify(options.candidate?.policyProofAppend ?? null)).digest('hex');
    const cacheKey = `${reference.reference}:${catalogue}:${appendHash}`;
    const cached = options.cache?.get(cacheKey);
    if (cached) { budget.check(); return cached.policy; }
    const remember = (policy: ResolvedAdmissionPolicy) => {
      budget.check();
      if (options.cache) {
        options.cache.set(cacheKey, { policy, reference, catalogue });
        while (options.cache.size > 2) options.cache.delete(options.cache.keys().next().value!);
      }
      budget.check(); return policy;
    };
    const append = options.candidate?.policyProofAppend && parseAdmissionPolicyProofAppend(options.candidate.policyProofAppend);
    if (append?.kind === 'advance' && sameAdmissionPolicyHead(append.advance.commitment.next, reference.head)) {
      const previous = [...(options.cache?.values() ?? [])].find(value => value.catalogue === catalogue
        && admissionPolicyObserversId(value.reference.context) === admissionPolicyObserversId(reference.context)
        && JSON.stringify(value.reference.limits) === JSON.stringify(reference.limits)
        && sameAdmissionPolicyHead(value.reference.head, append.advance.commitment.previous));
      if (previous) return remember(await resolveAdmissionPolicyAdvance({ previous: previous.policy, advance: append.advance,
        selectedHead: reference.head, reader, limits: reference.limits, budget, execution, signal: options.signal }));
    }
    let genesis: unknown;
    async function* advances() {
      let head = reference.genesis;
      for await (const image of images()) {
        if (!image.policyProofAppend) continue;
        const append = parseAdmissionPolicyProofAppend(image.policyProofAppend);
        if (append.kind === 'genesis') {
          if (genesis === undefined) genesis = append.policy;
          else if (JSON.stringify(genesis) !== JSON.stringify(append.policy)) throw new Error('Retained original policy genesis changed');
          continue;
        }
        const next = append.advance.commitment.next;
        if (next.revision <= head.revision) {
          if (next.revision === head.revision && !sameAdmissionPolicyHead(next, head)) throw new Error('Retained proof append equivocated');
          continue; // Complete business checkpoints may retain the preceding append.
        }
        if (!sameAdmissionPolicyHead(append.advance.commitment.previous, head)) throw new Error('Retained policy proof has a gap or fork');
        if (next.revision > reference.head.revision) break;
        head = next; yield append.advance;
      }
    }
    // Original genesis read is itself under the same deadline/read budget.
    return remember(await resolveAdmissionPolicy({ context: reference.context, genesis: undefined, readGenesis: async () => {
      for await (const image of images()) {
        const append = image.policyProofAppend && parseAdmissionPolicyProofAppend(image.policyProofAppend);
        if (append?.kind === 'genesis') { genesis = append.policy; return genesis; }
      }
      throw new Error('Original policy genesis is absent from retained role history');
    }, retainIssuerKeys, retainOnlyRequestedIssuerKeys: true, advances: advances(), selectedHead: reference.head, reader, limits: reference.limits, budget, execution, signal: options.signal }));
  }
  return { reference, budget, reader, resolve,
    async advance(previous: ResolvedAdmissionPolicy, appendValue: unknown, selected = reference.head) {
      const append = parseAdmissionPolicyProofAppend(appendValue);
      if (append.kind !== 'advance') throw new Error('Policy installation requires one immediate signed advance');
      return resolveAdmissionPolicyAdvance({ previous, advance: append.advance, selectedHead: selected, reader, limits: reference.limits, budget, execution, signal: options.signal });
    },
    async matches(policy: ArchivedAdmissionPolicy, retainIssuerKeys?: readonly string[]) {
      const resolved = await resolve(retainIssuerKeys), retained = inspectResolvedAdmissionPolicy(resolved);
      if (archivedAdmissionPolicyDigest(retained.policy) !== archivedAdmissionPolicyDigest(policy)) throw new Error('Policy proof differs from installed signed body');
      return resolved;
    },
  };
}

/** Full proof validation for one complete business image, including bounded historical attribution. */
export async function validateAdmissionPolicyHistoryImage(options: PolicyProofHistory & {
  image: PolicyProofImage; policy: ArchivedAdmissionPolicy; issuerKeys?: readonly string[];
  participants?: readonly { role: 'witness' | 'coordinator'; publicKey: string }[];
  signal?: AbortSignal;
}) {
  if (!options.image.policyProof) throw new Error('Protected archived policy has no original proof reference');
  const proof = createAdmissionPolicyHistoryProof({ ...options, reference: options.image.policyProof, candidate: options.image });
  const resolved = await proof.matches(options.policy);
  const { resolveAdmissionPolicyHistoryMembership } = await import('@resonance/core/admission-policy-archive');
  const query = createHash('sha256').update(JSON.stringify([...(options.issuerKeys ?? [])].sort()) + JSON.stringify(options.participants ?? [])).digest('hex');
  const key = `${proof.reference.reference}:${query}`;
  let membership = options.membershipCache?.get(key);
  if (!membership) {
    membership = await resolveAdmissionPolicyHistoryMembership({ policy: resolved, reader: proof.reader, limits: proof.reference.limits,
      budget: proof.budget, execution: options.operation?.startup?.execution, issuerKeys: options.issuerKeys ?? [], participants: options.participants, signal: options.signal });
    proof.budget.check();
    if (options.membershipCache) {
      options.membershipCache.set(key, membership);
      while (options.membershipCache.size > 2) options.membershipCache.delete(options.membershipCache.keys().next().value!);
    }
  }
  proof.budget.check();
  return { resolved, membership, proof };
}
