/** Offline invitation admission. No member identifier is added to issuance or redemption. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor,
  admissionAuthorityFingerprint, admissionPolicyDigest, admissionPolicyKeys, isArchivedAdmissionKey, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { prepareAdmissionBatchIssuer, validateAdmissionIssuanceTarget, type AdmissionIssuanceResponse } from './blind-admission-issuance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { matchesAdmissionPolicyHead, parseAdmissionPolicyAdvance, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyQuery, type AdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { inspectAdmissionPolicyObservation, parseAdmissionPolicyTrust, type AdmissionPolicyTrust } from '@resonance/core/admission-policy-trust';

export interface AdmissionIssuancePermit {
  version: 1; kind: 'admission-issuance-permit'; scope: AdmissionWalletProfileV1['scope'];
  keyFingerprint: string; count: number; secret: string;
}
export interface AdmissionIssuerPolicy { batchSize: number; maxPermits: number }
interface ClaimBinding { digest: string; binding: string; secret: string }
interface Entry { claim?: ClaimBinding; permitHash: string; batchId?: string; preparedResponse?: AdmissionIssuanceResponse; response?: AdmissionIssuanceResponse }
interface Totals { allocatedPermits: number; boundPermits: number; completedPermits: number }
interface BaseState { claimMode?: 'operator-claim-required-v1'; profile: AdmissionWalletProfileV1; policy: AdmissionIssuerPolicy; entries: Entry[]; communityPolicy?: SignedAdmissionPolicy; freshness?: AdmissionPolicyTrust }
type State = (BaseState & { version: 1 | 3 | 4 }) | (BaseState & {
  version: 2 | 5; communityPolicy: SignedAdmissionPolicy; retirement: Totals & { retiredAt: number };
});
const DOMAIN = 'resonance:admission-issuer-ledger:v1';
const MAX_BYTES = 8 * 1024 * 1024;
export class IssuerPolicyObservationExpiredError extends Error {
  constructor() { super('Issuer policy observation expired; collect a new observation for the exact reserved batch'); this.name = 'IssuerPolicyObservationExpiredError'; }
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function validatePolicy(policy: unknown): asserts policy is AdmissionIssuerPolicy {
  if (!exact(policy, ['batchSize', 'maxPermits']) || !Number.isInteger(policy.batchSize) || (policy.batchSize as number) < 1 || (policy.batchSize as number) > 32
    || !Number.isInteger(policy.maxPermits) || (policy.maxPermits as number) < 1 || (policy.maxPermits as number) > 256) {
    throw new Error('Issuer policy requires a fixed batch size of 1–32 and a maximum of 1–256 permits');
  }
}
function permitHash(secret: string) { return createHash('sha256').update(`${DOMAIN}:permit\n${secret}`).digest('hex'); }
function totals(state: State): Totals {
  if ((state.version === 2 || state.version === 5)) {
    const { allocatedPermits, boundPermits, completedPermits } = state.retirement;
    return { allocatedPermits, boundPermits, completedPermits };
  }
  return { allocatedPermits: state.entries.length, boundPermits: state.entries.filter(entry => entry.batchId).length,
    completedPermits: state.entries.filter(entry => entry.response).length };
}
function validState(value: unknown, profile: AdmissionWalletProfileV1): value is State {
  const version = (value as State | null)?.version;
  if (!exact(value, ['version', 'profile', 'policy', 'entries',
    ...(version === 2 || version === 5 || (value as State)?.communityPolicy ? ['communityPolicy'] : []), ...(version === 2 || version === 5 ? ['retirement'] : []),
    ...(version === 4 || version === 5 ? ['claimMode'] : []),
    ...((value as State)?.freshness ? ['freshness'] : [])])
    || (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5)
    || JSON.stringify(value.profile) !== JSON.stringify(profile)) return false;
  if ((version === 4 || version === 5) && value.claimMode !== 'operator-claim-required-v1') return false;
  try { validatePolicy(value.policy); } catch { return false; }
  if (value.freshness) { try { if (!value.communityPolicy) return false; parseAdmissionPolicyTrust(value.freshness, value.communityPolicy as SignedAdmissionPolicy); } catch { return false; } }
  if (!Array.isArray(value.entries) || value.entries.length > value.policy.maxPermits) return false;
  if (version === 2 || version === 5) {
    const r = value.retirement;
    return value.entries.length === 0 && !!value.communityPolicy
      && exact(r, ['retiredAt','allocatedPermits','boundPermits','completedPermits'])
      && [r.retiredAt, r.allocatedPermits, r.boundPermits, r.completedPermits].every(n => Number.isSafeInteger(n) && (n as number) >= 0)
      && (r.completedPermits as number) <= (r.boundPermits as number)
      && (r.boundPermits as number) <= (r.allocatedPermits as number) && (r.allocatedPermits as number) <= value.policy.maxPermits;
  }
  const permits = new Set<string>(); const batches = new Set<string>(); const claims = new Set<string>();
  for (const entry of value.entries) {
    if (!exact(entry, [...(entry?.response !== undefined ? ['permitHash', 'batchId', 'response']
      : (version === 3 || version === 4) && entry?.preparedResponse !== undefined ? ['permitHash', 'batchId', 'preparedResponse'] : entry?.batchId !== undefined ? ['permitHash', 'batchId'] : ['permitHash']), ...(version === 4 ? ['claim'] : [])])
      || !hex(entry.permitHash) || permits.has(entry.permitHash)) return false;
    if (version === 4) {
      const claim = entry.claim;
      if (!exact(claim, ['digest', 'binding', 'secret']) || !hex(claim.digest) || claims.has(claim.digest)
        || claim.binding !== claimScopeBinding(profile, value.policy) || !canonicalClaim(claim.secret) || permitHash(claim.secret) !== entry.permitHash) return false;
      claims.add(claim.digest);
    }
    permits.add(entry.permitHash);
    if (entry.batchId !== undefined) {
      if (!hex(entry.batchId) || batches.has(entry.batchId)) return false;
      batches.add(entry.batchId);
    }
    if (entry.response !== undefined || entry.preparedResponse !== undefined) {
      const response = entry.response ?? entry.preparedResponse;
      if (!exact(response, ['version', 'kind', 'batchId', 'responses']) || response.version !== 1 || response.kind !== 'admission-issuance-response'
        || response.batchId !== entry.batchId || !Array.isArray(response.responses) || response.responses.length !== value.policy.batchSize
        || response.responses.some(bytes => typeof bytes !== 'string' || bytes.length !== 342 || Buffer.from(bytes, 'base64url').length !== 256
          || Buffer.from(bytes, 'base64url').toString('base64url') !== bytes)) return false;
    }
  }
  return true;
}

function canonicalClaim(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function claimScopeBinding(profile: AdmissionWalletProfileV1, policy: AdmissionIssuerPolicy) {
  return createHash('sha256').update(JSON.stringify(['resonance:operator-claim-scope:v1', profile.scope, admissionKeyFingerprint(profile.issuerPublicKey), policy.batchSize])).digest('hex');
}

/** create is explicit initialization only. Ordinary opens MUST find the existing ledger.
 * A ledger and signing key belong to one operator/device; copying or rolling back them
 * defeats local allowance enforcement and is not a distributed issuance protocol.
 */
export async function openAdmissionIssuerLedger(options: {
  path: string; expectedProfile: unknown; privateKey: CryptoKey; create?: AdmissionIssuerPolicy; claimRequired?: boolean; now?: () => number;
}) {
  if (options.claimRequired !== undefined && (!options.create || options.claimRequired !== true)) throw new Error('Claim-required mode is explicit creation only');
  const privateKey = options.privateKey;
  const create = options.create === undefined ? undefined : structuredClone(options.create);
  if (create) validatePolicy(create);
  const issuer = await prepareAdmissionBatchIssuer({ expectedProfile: options.expectedProfile, privateKey });
  const profile = structuredClone(issuer.profile);
  const privateBytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey));
  let key: Buffer;
  try { key = Buffer.from(hkdfSync('sha256', privateBytes, Buffer.alloc(0), DOMAIN, 32)); }
  finally { privateBytes.fill(0); }
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    storage = openEncryptedLocalState<State>({ path: options.path, key, domain: DOMAIN, maxBytes: MAX_BYTES,
      mode: create ? 'create-new' : 'open-existing',
      initial: { version: options.claimRequired ? 4 : 1, ...(options.claimRequired ? { claimMode: 'operator-claim-required-v1' as const } : {}), profile, policy: create ?? { batchSize: 1, maxPermits: 1 }, entries: [] },
      validate: (value): value is State => validState(value, profile) });
  } finally { key.fill(0); }
  try { const state = storage.read(), policy = state.communityPolicy; if (policy) {
    await verifyAdmissionPolicy(policy, policy.authority);
    if (!admissionPolicyKeys(policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Issuer is absent from its signed community policy');
    if ((state.version === 2 || state.version === 5)) {
      // Retirement seals this policy as historical evidence; it need not remain current at every subsequent open.
      const id = admissionKeyFingerprint(profile.issuerPublicKey), entry = admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id)!;
      if (policy.activeKey === id || state.retirement.retiredAt < entry.retryUntil) throw new Error('Invalid permanent issuer retirement');
      assertAdmissionPolicyCurrent(policy, state.retirement.retiredAt);
    }
  } } catch (error) { storage.close(); throw error; }
  let busy = false, observation: { query: AdmissionPolicyQuery; deadline: number } | undefined;
  function live() { const state = storage.read(); if ((state.version === 2 || state.version === 5)) throw new Error('Issuer ledger is permanently retired'); return state; }
  function checkPolicy(recover = false) {
    const policy = live().communityPolicy; if (!policy) return;
    const now = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(policy, now);
    const id = admissionKeyFingerprint(profile.issuerPublicKey);
    const entry = admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id);
    if (!entry || isArchivedAdmissionKey(policy, id) || now < entry.notBefore || now >= (recover ? entry.spendUntil : entry.issueUntil)
      || (!recover && policy.activeKey !== id)) throw new Error('Issuer is retired or inactive under the signed community policy');
  }
  function ready() { live(); if (busy) throw new Error('Issuer approval or policy update is already in progress'); }
  function checkFreshness(reply: unknown) {
    const state = live();
    if (!state.freshness) {
      if (reply !== undefined) throw new Error('Issuer has no independently pinned policy observers');
      return () => {};
    }
    const pending = observation; observation = undefined;
    if (!pending || reply === undefined) throw new Error('Prepare a new issuer policy observation before each grant or approval');
    if (performance.now() >= pending.deadline) throw new Error('Issuer policy observation expired');
    const inspected = inspectAdmissionPolicyObservation(state.freshness,
      { query: pending.query, reply: reply as import('@resonance/core/admission-policy-query').AdmissionPolicyQueryReply }, (options.now ?? Date.now)());
    if (inspected.state !== state.freshness) storage.write({ ...state, freshness: inspected.state });
    if (inspected.error) throw new Error(inspected.error);
    const head = inspected.state.installed;
    const assertCurrent = () => {
      const retained = live().freshness, now = (options.now ?? Date.now)();
      if (!retained || retained.conflict || !sameAdmissionPolicyHead(retained.installed, head) || !sameAdmissionPolicyHead(retained.observed, head)) throw new Error('Issuer policy observation changed');
      if (performance.now() >= pending.deadline || now < pending.query.request.issuedAt || now >= pending.query.request.expiresAt) throw new IssuerPolicyObservationExpiredError();
    };
    assertCurrent(); return assertCurrent;
  }
  function planRetirement(authority: string) {
    ready(); const state = live(), policy = state.communityPolicy;
    if (!policy) throw new Error('Issuer retirement requires an installed signed community policy');
    if (policy.authority !== authority) throw new Error('Issuer retirement authority does not match the pinned community authority');
    const now = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(policy, now);
    const issuerKey = admissionKeyFingerprint(profile.issuerPublicKey);
    const entry = admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey)!;
    if (policy.activeKey === issuerKey) throw new Error('Cannot permanently retire the active issuer key; install a successor first');
    if (now < entry.retryUntil) throw new Error('Issuer history must remain until the key retry cutoff');
    const ledgerPath = resolve(options.path), policyDigest = admissionPolicyDigest(policy), retained = totals(state);
    const approvalDigest = 'sha256:' + createHash('sha256').update(JSON.stringify([
      'resonance:admission-issuer-retirement:v1', ledgerPath, authority, issuerKey, policyDigest, state,
    ])).digest('hex');
    return { kind: 'admission-issuer-retirement' as const, ledgerPath, issuerKey,
      authorityFingerprint: admissionAuthorityFingerprint(authority), policyRevision: policy.revision, policyDigest,
      responseRecoveryUntil: entry.spendUntil, retryUntil: entry.retryUntil,
      recordsBefore: state.entries.length, recordsRemoved: state.entries.length, recordsAfter: 0,
      ...retained, batchSize: state.policy.batchSize, maxPermits: state.policy.maxPermits,
      unallocatedPermitsCancelled: state.policy.maxPermits - retained.allocatedPermits, approvalDigest,
      notice: 'Permanently closes this issuer ledger, including cached responses and policy changes. Lifetime totals remain; no allowance is refunded or transferred. Wallets, relays and policy key slots are unchanged.' };
  }
  function validatePermit(value: unknown): asserts value is AdmissionIssuancePermit {
    const state = storage.read();
    if (!exact(value, ['version', 'kind', 'scope', 'keyFingerprint', 'count', 'secret']) || value.version !== 1 || value.kind !== 'admission-issuance-permit'
      || !exact(value.scope, ['issuer', 'community', 'epoch'])
      || value.scope.issuer !== profile.scope.issuer || value.scope.community !== profile.scope.community || value.scope.epoch !== profile.scope.epoch
      || value.keyFingerprint !== admissionKeyFingerprint(profile.issuerPublicKey) || value.count !== state.policy.batchSize
      || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
      || Buffer.from(value.secret, 'base64url').toString('base64url') !== value.secret) throw new Error('Invalid permit for this issuer policy');
  }
  return {
    planRetirement,
    /** Operator metadata only. The caller collects four live observations on
     * this exact challenge and returns the reply once; no proof survives reopen. */
    preparePolicyObservation() {
      ready(); const freshness = live().freshness, now = (options.now ?? Date.now)();
      if (!freshness || freshness.conflict) throw new Error('Issuer policy observers are absent or conflicting');
      if (observation && performance.now() < observation.deadline && now < observation.query.request.expiresAt) throw new Error('An issuer policy observation is already pending');
      const query = createAdmissionPolicyQuery(freshness.context, now);
      observation = { query, deadline: performance.now() + 3000 };
      return { context: structuredClone(freshness.context), query: structuredClone(query) };
    },
    cancelPolicyObservation() { ready(); observation = undefined; },
    retire(authority: string, approvedDigest: string) {
      const plan = planRetirement(authority);
      if (approvedDigest !== plan.approvalDigest) throw new Error('Issuer history changed or approval does not match; review retirement again');
      const state = live();
      const retiredAt = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(state.communityPolicy!, retiredAt);
      if (retiredAt < plan.retryUntil) throw new Error('Issuer history must remain until the key retry cutoff');
      // One flushed snapshot seals the key, preserves lifetime accounting, and removes all per-permit evidence.
      storage.write({ ...state, version: state.version === 4 ? 5 : 2, communityPolicy: state.communityPolicy!, entries: [],
        retirement: { retiredAt, ...totals(state) } });
      return plan;
    },
    async installPolicy(value: unknown, authority: string, pins: { observers?: unknown; advance?: unknown } = {}) {
      ready(); const state = storage.read();
      if (state.communityPolicy && state.communityPolicy.authority !== authority) throw new Error('Community authority is already pinned');
      busy = true; observation = undefined;
      try {
        const input = structuredClone(value), advanceInput = pins.advance === undefined ? undefined : structuredClone(pins.advance);
        const observers = pins.observers === undefined ? undefined : parseAdmissionPolicyObservers(pins.observers);
        const policy = await verifyAdmissionPolicy(input, authority); storage.read();
        let freshness = state.freshness;
        if (freshness?.conflict) throw new Error('Issuer policy observations conflict; issuance is fenced');
        if (freshness && observers && admissionPolicyObserversId(observers) !== admissionPolicyObserversId(freshness.context)) throw new Error('Issuer policy observers are already pinned');
        const advance = advanceInput === undefined ? undefined : await parseAdmissionPolicyAdvance(advanceInput, freshness?.context ?? observers!);
        storage.read();
        if (!advance || !freshness || policy.revision >= freshness.observed.revision) assertAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
        if (freshness) {
          if (advance) {
            if (!matchesAdmissionPolicyHead(policy, advance.commitment.next)
              || !sameAdmissionPolicyHead(advance.commitment.previous, freshness.installed) && !sameAdmissionPolicyHead(advance.commitment.next, freshness.installed)) {
              throw new Error('Issuer policy update must extend its retained signed transition');
            }
            const head = advance.commitment.next;
            if (head.revision === freshness.observed.revision && !sameAdmissionPolicyHead(head, freshness.observed)) throw new Error('Issuer policy update conflicts with its observed floor');
            freshness = { ...freshness, installed: head, observed: head.revision > freshness.observed.revision ? head : freshness.observed };
          } else if (!matchesAdmissionPolicyHead(policy, freshness.installed)) throw new Error('Issuer policy freshness requires a signed immediate successor');
        } else if (observers) {
          if (advance || !matchesAdmissionPolicyHead(policy, observers.genesis)) throw new Error('Issuer observer enrollment requires its independently pinned genesis');
          freshness = parseAdmissionPolicyTrust({ context: observers, installed: observers.genesis, observed: observers.genesis }, policy);
        } else if (advance) throw new Error('Issuer transition requires independently pinned observers');
        if (state.communityPolicy) assertAdmissionPolicySuccessor(state.communityPolicy, policy);
        if (!admissionPolicyKeys(policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Issuer is absent from the signed community policy');
        storage.write({ ...state, communityPolicy: policy, ...(freshness ? { freshness } : {}) });
      } finally { busy = false; }
    },
    status() {
      const state = storage.read(), { policy, entries } = state, counts = totals(state), retired = (state.version === 2 || state.version === 5);
      return { ...policy, ...counts, preparedPermits: entries.filter(entry => entry.preparedResponse).length, permanentlyRetired: retired, retainedEntries: entries.length,
        ...(state.freshness ? { policyFreshness: { requiresObservation: true, installedRevision: state.freshness.installed.revision,
          observedRevision: state.freshness.observed.revision, conflict: !!state.freshness.conflict } } : {}),
        remainingPermits: retired ? 0 : policy.maxPermits - counts.allocatedPermits,
        unallocatedPermitsCancelled: retired ? policy.maxPermits - counts.allocatedPermits : 0,
        tokenBudget: policy.batchSize * policy.maxPermits, allocatedTokens: counts.allocatedPermits * policy.batchSize,
        boundTokens: counts.boundPermits * policy.batchSize, ...(retired ? { retiredAt: state.retirement.retiredAt } : {}) };
    },
    /** An explicit community invitation, with no recipient/account field. Never refund or reuse. */
    grant(policyReply?: unknown): AdmissionIssuancePermit {
      ready(); if (live().version === 4) throw new Error('Operator-approved claim required; unbound grants are disabled');
      const assertCurrent = checkFreshness(policyReply); checkPolicy(); const state = storage.read();
      if (state.entries.length >= state.policy.maxPermits) throw new Error('Issuer permit allowance exhausted');
      const secret = randomBytes(32).toString('base64url');
      storage.write({ ...state, entries: [...state.entries, { permitHash: permitHash(secret) }] });
      assertCurrent();
      return { version: 1, kind: 'admission-issuance-permit', scope: structuredClone(profile.scope),
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), count: state.policy.batchSize, secret };
    },
    /** One manually approved opaque claim per fixed batch, within this pinned local ledger only. */
    grantForClaim(handle: unknown, policyReply?: unknown): AdmissionIssuancePermit {
      ready(); if (live().version !== 4) throw new Error('Ledger was not created in claim-required mode');
      if (!canonicalClaim(handle)) throw new Error('Claim handle must be canonical base64url for exactly 32 opaque bytes');
      const assertCurrent = checkFreshness(policyReply); checkPolicy(); const state = storage.read();
      const binding = claimScopeBinding(profile, state.policy);
      const digest = createHash('sha256').update(JSON.stringify(['resonance:operator-claim:v1', binding, handle])).digest('hex');
      const previous = state.entries.find(entry => entry.claim?.digest === digest);
      if (!previous && state.entries.length >= state.policy.maxPermits) throw new Error('Issuer permit allowance exhausted');
      const secret = previous?.claim!.secret ?? randomBytes(32).toString('base64url');
      if (!previous) storage.write({ ...state, entries: [...state.entries, { permitHash: permitHash(secret), claim: { digest, binding, secret } }] });
      assertCurrent();
      return { version: 1, kind: 'admission-issuance-permit', scope: structuredClone(profile.scope),
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), count: state.policy.batchSize, secret };
    },
    async approve(permitValue: unknown, requestValue: unknown, policyReply?: unknown): Promise<AdmissionIssuanceResponse> {
      ready(); validatePermit(permitValue); validateAdmissionIssuanceTarget(requestValue, profile);
      const request = structuredClone(requestValue); const digest = permitHash(permitValue.secret);
      const state = storage.read(); const index = state.entries.findIndex(entry => entry.permitHash === digest);
      if (index < 0) throw new Error('Unknown issuance permit');
      if (request.requests.length !== state.policy.batchSize) throw new Error(`This permit requires exactly ${state.policy.batchSize} blinded requests`);
      const entry = state.entries[index];
      if (entry.batchId && entry.batchId !== request.batchId) throw new Error('Permit is already bound to another batch; only the exact original request can be retried');
      if (state.entries.some((other, i) => i !== index && other.batchId === request.batchId)) throw new Error('Batch is already assigned to another permit');
      const assertCurrent = checkFreshness(policyReply);
      if (entry.response) { checkPolicy(true); assertCurrent(); return structuredClone(entry.response); }
      checkPolicy();
      busy = true;
      try {
        // Reserve the ENTIRE batch before the first blind signature. A crash or lost
        // output leaves only this exact batch eligible. Nothing ever refunds its allowance.
        if (!entry.batchId) storage.write({ ...state, entries: state.entries.map((item, i) => i === index ? { ...item, batchId: request.batchId } : item) });
        const response = entry.preparedResponse ?? await issuer.issue(request);
        if (state.freshness && !entry.preparedResponse) {
          // Keep completed crypto private across an expired observation or a
          // crash. Prepared signatures are NOT an approved cached response:
          // promotion still needs a fresh quorum and the active issuance window.
          const reserved = live();
          storage.write({ ...reserved, version: reserved.version === 4 ? 4 : 3, entries: reserved.entries.map((item, i) => i === index ? { ...item, preparedResponse: response } : item) });
        }
        checkPolicy(); assertCurrent();
        const reserved = storage.read(); // Lock/close during crypto must prevent output.
        storage.write({ ...reserved, entries: reserved.entries.map((item, i) => i === index ? { permitHash: item.permitHash, ...(item.claim ? { claim: item.claim } : {}), batchId: request.batchId, response } : item) });
        assertCurrent();
        return structuredClone(response); // Only a durably cached response may leave this boundary.
      } finally { busy = false; }
    },
    close() { observation = undefined; storage.close(); },
  };
}
export type AdmissionIssuerLedger = Awaited<ReturnType<typeof openAdmissionIssuerLedger>>;

/** One explicit signing command may refresh an expired observation once. It
 * never retries changed policy, missing quorum, storage errors or another batch. */
export async function approveAdmissionIssuerBatch(ledger: AdmissionIssuerLedger, permit: unknown, request: unknown, observe: () => Promise<unknown>) {
  const originalPermit = structuredClone(permit), originalRequest = structuredClone(request);
  try { return await ledger.approve(originalPermit, originalRequest, await observe()); }
  catch (error) {
    if (!(error instanceof IssuerPolicyObservationExpiredError)) throw error;
    return ledger.approve(originalPermit, originalRequest, await observe());
  }
}
