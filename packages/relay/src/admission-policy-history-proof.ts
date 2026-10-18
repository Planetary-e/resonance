import { createHash } from 'node:crypto';
/** Policy evidence lives only in the role's funded authenticated retained history.
 * Readers retain one checkpoint/page at a time and share core operation accounting. */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { AdmissionPolicyArchiveBudget } from '@resonance/core/admission-policy-archive';
import { parseAdmissionPolicyProofReference, parseAdmissionPolicyProofAppend, resolveAdmissionPolicy, resolveAdmissionPolicyAdvance, inspectResolvedAdmissionPolicy, archivedAdmissionPolicyDigest, type AdmissionPolicyProofReference, type AdmissionPolicyProofAppend, type AdmissionPolicyArchiveReader, type ResolvedAdmissionPolicy, type ArchivedAdmissionPolicy, type AdmissionPolicyHistoryMembership } from '@resonance/core/admission-policy-archive';
import { admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { openHistoryCheckpoint, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';

export interface PolicyProofImage { policyProof?: AdmissionPolicyProofReference; policyProofAppend?: AdmissionPolicyProofAppend }
export interface PolicyProofOperation { budget?: AdmissionPolicyArchiveBudget }
export type PolicyProofCache = Map<string, { policy: ResolvedAdmissionPolicy; reference: AdmissionPolicyProofReference; catalogue: string }>;
export interface PolicyProofHistory {
  source(): Iterable<HistoryCheckpointEnvelope>; context: HistoryCheckpointContext; encryptionKey: Uint8Array;
  /** A not-yet-published complete checkpoint is considered only inside its owner's exclusive operation. */
  candidate?: PolicyProofImage; signal?: AbortSignal; deadline?: number;
  operation?: PolicyProofOperation;
  /** At most current/pending opaque heads; no archive entries or pages are cached. Never used by offline replay. */
  cache?: PolicyProofCache;
  membershipCache?: Map<string, AdmissionPolicyHistoryMembership>;
}
export function createAdmissionPolicyHistoryProof(options: PolicyProofHistory & { reference: AdmissionPolicyProofReference; signal?: AbortSignal }) {
  const reference = parseAdmissionPolicyProofReference(options.reference);
  const budget = options.operation?.budget ?? new AdmissionPolicyArchiveBudget({ limits: reference.limits, signal: options.signal, deadline: options.deadline });
  if (JSON.stringify(budget.limits) !== JSON.stringify(reference.limits)) throw new Error('Protected proof operation funding bounds changed');
  if (options.operation) options.operation.budget = budget;
  budget.addSignal(options.signal); budget.restrictDeadline(options.deadline); budget.check();
  let reads = 0;
  async function* images(): AsyncGenerator<PolicyProofImage> {
    for (const block of options.source()) {
      budget.check(); budget.charge('maxHistoryBytes', Buffer.byteLength(JSON.stringify(block)));
      // Read count is cumulative across ancestry and all page rescans.
      budget.charge('maxPageReads', 1);
      if (++reads % 16 === 0) await budget.wait(() => yieldToEventLoop());
      if (block.kind !== 'checkpoint' && block.kind !== 'delta') continue;
      const bytes = openHistoryCheckpoint(block, options.context, options.encryptionKey);
      try {
        const raw = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
        // Relay complete records wrap their business image; issuer records are images.
        const image = raw.kind === 'admission-spend-checkpoint' ? raw : raw.image ?? raw;
        if (image.policyProof !== undefined) {
          const pin = parseAdmissionPolicyProofReference(image.policyProof);
          if (admissionPolicyObserversId(pin.context) !== admissionPolicyObserversId(reference.context)
            || JSON.stringify(pin.limits) !== JSON.stringify(reference.limits)) throw new Error('Retained proof changed original observer pins or funded bounds');
          yield image;
        }
      } finally { bytes.fill(0); }
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
        selectedHead: reference.head, reader, limits: reference.limits, budget, signal: options.signal }));
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
    }, retainIssuerKeys, retainOnlyRequestedIssuerKeys: true, advances: advances(), selectedHead: reference.head, reader, limits: reference.limits, budget, signal: options.signal }));
  }
  return { reference, budget, reader, resolve,
    async advance(previous: ResolvedAdmissionPolicy, appendValue: unknown, selected = reference.head) {
      const append = parseAdmissionPolicyProofAppend(appendValue);
      if (append.kind !== 'advance') throw new Error('Policy installation requires one immediate signed advance');
      return resolveAdmissionPolicyAdvance({ previous, advance: append.advance, selectedHead: selected, reader, limits: reference.limits, budget, signal: options.signal });
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
      budget: proof.budget, issuerKeys: options.issuerKeys ?? [], participants: options.participants, signal: options.signal });
    if (options.membershipCache) {
      options.membershipCache.set(key, membership);
      while (options.membershipCache.size > 2) options.membershipCache.delete(options.membershipCache.keys().next().value!);
    }
  }
  proof.budget.check();
  return { resolved, membership, proof };
}
