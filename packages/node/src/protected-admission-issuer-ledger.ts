/** Volunteer-protected issuer. This API directly owns its encrypted image and decisions. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor,
  admissionAuthorityFingerprint, admissionPolicyDigest, admissionPolicyKeys, isArchivedAdmissionKey } from '@resonance/core/admission-policy';
import { verifyAdmissionIssuanceAllocation, admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent,
  selectAdmissionIssuerAllocation } from '@resonance/core/admission-issuance-allocation';
import { verifyAdmissionClaimAssignment, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openProtectedIssuerHistory, type ProtectedIssuerHistoryOptions } from '@resonance/relay/protected-issuer-history';
import { admissionKeyFingerprint } from './admission-wallet-profile.js';
import { prepareAdmissionBatchIssuer, validateAdmissionIssuanceTarget, type AdmissionIssuanceResponse } from './blind-admission-issuance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { matchesAdmissionPolicyHead, parseAdmissionPolicyAdvance, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyQuery, type AdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { inspectAdmissionPolicyObservation, parseAdmissionPolicyTrust } from '@resonance/core/admission-policy-trust';

import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis } from './protected-admission-issuer-state.js';
import { readPreparedProtectedIssuerRestore, type PreparedProtectedIssuerRestore } from './admission-issuer-history-restore.js';
import { DOMAIN, permitHash, totals, canonicalClaim, claimDigest, claimScopeBinding,
  assertAdmissionIssuerPolicy, validateAdmissionIssuerPermit, deriveAdmissionIssuerEncryptionKey, IssuerPolicyObservationExpiredError, type State, type AdmissionIssuancePermit } from './admission-issuer-state.js';

export interface ProtectedAdmissionIssuerLedgerOptions {
  path: string;
  expectedProfile: unknown;
  privateKey: CryptoKey;
  expectedAllocationAuthority: string;
  protection: Omit<ProtectedIssuerHistoryOptions<State>, 'path' | 'domain' | 'encryptionKey' | 'initial' | 'validate' | 'initialize' | 'restore' | 'assertTransition' | 'validateGenesis'>;
  /** Fresh creation only. Existing local ledgers cannot be promoted through this API. */
  initialize?: { allocation: unknown; communityPolicy: unknown; observers: unknown };
  /** Reviewed restoration is an in-process capability, never a serialized snapshot or generic adapter option. */
  restore?: { preparation: PreparedProtectedIssuerRestore; approvedDigest: string };
  now?: () => number;
}
export async function openProtectedAdmissionIssuerLedger(options: ProtectedAdmissionIssuerLedgerOptions) {
  if (Object.hasOwn(options.protection, 'restore') || Object.hasOwn(options.protection, 'assertTransition') || Object.hasOwn(options.protection, 'validateGenesis')) {
    throw new Error('Protected issuer restoration and transition validation require the business API capability');
  }
  if (options.initialize && options.restore) throw new Error('Protected issuer initialization and restoration are mutually exclusive');
  // Freeze all caller-owned configuration and pins before the first asynchronous verifier.
  options = { ...options, path: options.path, expectedProfile: structuredClone(options.expectedProfile),
    initialize: options.initialize === undefined ? undefined : structuredClone(options.initialize),
    restore: options.restore === undefined ? undefined : { preparation: options.restore.preparation, approvedDigest: options.restore.approvedDigest },
    protection: { ...options.protection, context: structuredClone(options.protection.context), members: structuredClone(options.protection.members),
      signingKey: { publicKey: Uint8Array.from(options.protection.signingKey.publicKey), secretKey: Uint8Array.from(options.protection.signingKey.secretKey) } } };
  const now = options.now ?? Date.now;
  try {
    const authority = options.expectedAllocationAuthority;
    if (options.protection.context.authority !== authority) throw new Error('Protected issuer history authority differs from its independent allocation pin');
    const issuer = await prepareAdmissionBatchIssuer({ expectedProfile: options.expectedProfile, privateKey: options.privateKey });
    const profile = structuredClone(issuer.profile);
    const validate = (value: unknown) => parseProtectedIssuerImage(value, { profile, authority });
    let initial: State | undefined;
    if (options.initialize) {
      const manifest = await verifyAdmissionIssuanceAllocation(structuredClone(options.initialize.allocation), authority);
      if (manifest.version !== 2) throw new Error('Protected issuer requires a v2 authority-assigned allocation');
      assertAdmissionIssuanceAllocationCurrent(manifest, now());
      const selected = selectAdmissionIssuerAllocation(manifest, profile);
      const policy = await verifyAdmissionPolicy(structuredClone(options.initialize.communityPolicy), authority);
      assertAdmissionPolicyCurrent(policy, now());
      if (options.protection.context.policyDigest !== `sha256:${admissionPolicyDigest(policy)}`) throw new Error('Protected issuer history policy differs from its independently pinned genesis');
      const observers = parseAdmissionPolicyObservers(structuredClone(options.initialize.observers));
      if (!matchesAdmissionPolicyHead(policy, observers.genesis)) throw new Error('Issuer observer enrollment requires its independently pinned genesis');
      initial = await validate({ version: 8, allocation: { manifest, authority, digest: admissionIssuanceAllocationDigest(manifest) },
        claimMode: 'authority-assigned-v1', profile, policy: { batchSize: selected.batchSize, maxPermits: selected.maxPermits }, entries: [], communityPolicy: policy,
        freshness: parseAdmissionPolicyTrust({ context: observers, installed: observers.genesis, observed: observers.genesis }, policy) });
      // Creation cannot seal an already inactive issuer baseline.
      const id = admissionKeyFingerprint(profile.issuerPublicKey), entry = admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id)!;
      if (policy.activeKey !== id || now() < entry.notBefore || now() >= entry.issueUntil || isArchivedAdmissionKey(policy, id)) throw new Error('Issuer is retired or inactive under the signed community policy');
    }
    const key = await deriveAdmissionIssuerEncryptionKey(options.privateKey);
    let storage: Awaited<ReturnType<typeof openProtectedIssuerHistory<State>>>;
    try {
      if (initial) {
        assertAdmissionIssuanceAllocationCurrent(initial.allocation!.manifest, now());
        assertAdmissionIssuerPolicy(initial, profile, now());
      }
      const restored = options.restore === undefined ? undefined : readPreparedProtectedIssuerRestore(options.restore.preparation, options.restore.approvedDigest,
        { path: options.path, writerDirectory: options.protection.writerDirectory, context: options.protection.context, profile, authority });
      storage = await openProtectedIssuerHistory<State>({ ...options.protection, path: options.path, domain: DOMAIN, encryptionKey: key,
        initialize: !!options.initialize || !!restored, initial: initial!, validate, assertTransition: assertProtectedIssuerImageSuccessor, validateGenesis: image => assertProtectedIssuerGenesis(image, options.protection.context), restore: restored });
    }
    finally { key.fill(0); }
    let busy = false, observation: { query: AdmissionPolicyQuery; deadline: number } | undefined;
    function live() { const state = storage.read(); if (state.version === 9) throw new Error('Issuer ledger is permanently retired'); return state; }
    function checkPolicy(recover = false) { assertAdmissionIssuerPolicy(live(), profile, (options.now ?? Date.now)(), recover); }
    function checkAllocationIssuance() {
      const allocation = live().allocation;
      if (allocation) assertAdmissionIssuanceAllocationCurrent(allocation.manifest, (options.now ?? Date.now)());
    }
    function available() { storage.assertServing(); live(); if (busy) throw new Error('Issuer approval or policy update is already in progress'); }
    async function checkFreshness(reply: unknown) {
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
      if (inspected.state !== state.freshness) await storage.commit({ ...state, freshness: inspected.state });
      if (inspected.error) throw new Error(inspected.error);
      const head = inspected.state.installed;
      const assertCurrent = () => {
        storage.assertServing(); const retained = live().freshness, now = (options.now ?? Date.now)();
        if (!retained || retained.conflict || !sameAdmissionPolicyHead(retained.installed, head) || !sameAdmissionPolicyHead(retained.observed, head)) throw new Error('Issuer policy observation changed');
        if (performance.now() >= pending.deadline || now < pending.query.request.issuedAt || now >= pending.query.request.expiresAt) throw new IssuerPolicyObservationExpiredError();
      };
      assertCurrent(); return assertCurrent;
    }
    function planRetirement(authority: string) {
      available(); const state = live(), policy = state.communityPolicy;
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
    function validatePermit(value: unknown): asserts value is AdmissionIssuancePermit { validateAdmissionIssuerPermit(value, storage.read(), profile); }
    async function grantClaimPermit(handle: unknown, policyReply?: unknown, assignment?: SignedAdmissionClaimAssignment): Promise<AdmissionIssuancePermit> {
        if (!canonicalClaim(handle)) throw new Error('Claim handle must be canonical base64url for exactly 32 opaque bytes');
        const assertCurrent = await checkFreshness(policyReply); const state = storage.read();
        const binding = claimScopeBinding(profile, state.policy, state.allocation?.digest);
        const digest = claimDigest(binding, handle);
        const previous = state.entries.find(entry => entry.claim?.digest === digest);
        checkPolicy(!!state.allocation && !!previous);
        if (!previous) checkAllocationIssuance();
        if (!previous && state.entries.length >= state.policy.maxPermits) throw new Error('Issuer permit allowance exhausted');
        const secret = previous?.claim!.secret ?? randomBytes(32).toString('base64url');
        if (!previous) await storage.commit({ ...state, entries: [...state.entries, { permitHash: permitHash(secret), claim: { digest, binding, secret }, ...(assignment ? { assignment } : {}) }] });
        checkPolicy(!!previous); if (!previous) checkAllocationIssuance(); assertCurrent();
        return { version: 1, kind: 'admission-issuance-permit', scope: structuredClone(profile.scope),
          keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), count: state.policy.batchSize, secret };
    }
    const api = {
      async ready() {
        if (busy) throw new Error('Issuer operation is already in progress');
        busy = true; observation = undefined;
        try { await storage.ready(); } finally { busy = false; }
      },
      enrollment() { return storage.enrollment(); },
      planRetirement,
      /** Operator metadata only. The caller collects four live observations on
       * this exact challenge and returns the reply once; no proof survives reopen. */
      preparePolicyObservation() {
        available(); const freshness = live().freshness, now = (options.now ?? Date.now)();
        if (!freshness || freshness.conflict) throw new Error('Issuer policy observers are absent or conflicting');
        if (observation && performance.now() < observation.deadline && now < observation.query.request.expiresAt) throw new Error('An issuer policy observation is already pending');
        const query = createAdmissionPolicyQuery(freshness.context, now);
        observation = { query, deadline: performance.now() + 3000 };
        return { context: structuredClone(freshness.context), query: structuredClone(query) };
      },
      cancelPolicyObservation() { available(); observation = undefined; },
      async retire(authority: string, approvedDigest: string) {
        const plan = planRetirement(authority);
        if (approvedDigest !== plan.approvalDigest) throw new Error('Issuer history changed or approval does not match; review retirement again');
        busy = true; observation = undefined;
        try {
          const state = live(), retiredAt = now(); assertAdmissionPolicyCurrent(state.communityPolicy!, retiredAt);
          if (retiredAt < plan.retryUntil) throw new Error('Issuer history must remain until the key retry cutoff');
          await storage.commit({ ...state, version: 9, communityPolicy: state.communityPolicy!, entries: [], retirement: { retiredAt, ...totals(state) } });
          storage.assertServing(); return plan;
        } finally { busy = false; }
      },
      async installPolicy(value: unknown, authority: string, pins: { observers?: unknown; advance?: unknown } = {}) {
        available(); const state = storage.read();
        if (state.allocation && state.allocation.authority !== authority) throw new Error('Community policy authority does not match the pinned issuer allocation');
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
          await storage.commit({ ...state, communityPolicy: policy, ...(freshness ? { freshness } : {}) });
        } finally { busy = false; }
      },
      status() {
        const state = storage.read(), { policy, entries } = state, counts = totals(state), retired = state.version === 9;
        return { protection: storage.status(), ...policy, ...counts, preparedPermits: entries.filter(entry => entry.preparedResponse).length, permanentlyRetired: retired, retainedEntries: entries.length,
          ...(state.freshness ? { policyFreshness: { requiresObservation: true, installedRevision: state.freshness.installed.revision,
            observedRevision: state.freshness.observed.revision, conflict: !!state.freshness.conflict } } : {}),
          remainingPermits: retired ? 0 : policy.maxPermits - counts.allocatedPermits,
          unallocatedPermitsCancelled: retired ? policy.maxPermits - counts.allocatedPermits : 0,
          tokenBudget: policy.batchSize * policy.maxPermits, allocatedTokens: counts.allocatedPermits * policy.batchSize,
          boundTokens: counts.boundPermits * policy.batchSize, ...(retired ? { retiredAt: state.retirement.retiredAt } : {}) };
      },
      async grantForAssignment(value: unknown, policyReply?: unknown): Promise<AdmissionIssuancePermit> {
        available(); const state = live();
        if (state.version !== 8 || !state.allocation) throw new Error('Ledger was not created in authority-assigned mode');
        const input = structuredClone(value), reply = structuredClone(policyReply), allocation = structuredClone(state.allocation);
        busy = true;
        try {
          const assignment = await verifyAdmissionClaimAssignment(input, allocation.manifest, allocation.authority);
          live();
          if (assignment.issuerKeyFingerprint !== admissionKeyFingerprint(profile.issuerPublicKey)) throw new Error('Signed claim assignment selects another issuer');
          return await grantClaimPermit(assignment.claimHandle, reply, assignment);
        } finally { busy = false; }
      },
      async approve(permitValue: unknown, requestValue: unknown, policyReply?: unknown): Promise<AdmissionIssuanceResponse> {
        available(); validatePermit(permitValue); validateAdmissionIssuanceTarget(requestValue, profile);
        const request = structuredClone(requestValue); const digest = permitHash(permitValue.secret);
        const state = storage.read(); const index = state.entries.findIndex(entry => entry.permitHash === digest);
        if (index < 0) throw new Error('Unknown issuance permit');
        if (request.requests.length !== state.policy.batchSize) throw new Error(`This permit requires exactly ${state.policy.batchSize} blinded requests`);
        const entry = state.entries[index];
        if (entry.batchId && entry.batchId !== request.batchId) throw new Error('Permit is already bound to another batch; only the exact original request can be retried');
        if (state.entries.some((other, i) => i !== index && other.batchId === request.batchId)) throw new Error('Batch is already assigned to another permit');
        busy = true;
        try {
          const assertCurrent = await checkFreshness(policyReply);
          if (entry.batchId && !entry.preparedResponse && !entry.response) throw new Error('Issuer batch signing outcome is unresolved; this reserved batch cannot be signed again or refunded');
          if (entry.response) { checkPolicy(true); assertCurrent(); return structuredClone(entry.response); }
          checkPolicy(); checkAllocationIssuance();
          // Reserve the ENTIRE batch before the first blind signature. A crash or lost
          // output leaves only this exact batch eligible. Nothing ever refunds its allowance.
          if (!entry.batchId) await storage.commit({ ...state, entries: state.entries.map((item, i) => i === index ? { ...item, batchId: request.batchId } : item) });
          if (!entry.preparedResponse) {
            const reserved = live(), placeholder: AdmissionIssuanceResponse = { version: 1, kind: 'admission-issuance-response', batchId: request.batchId,
              responses: Array.from({ length: reserved.policy.batchSize }, () => Buffer.alloc(256).toString('base64url')) };
            const prepared = { ...reserved, entries: reserved.entries.map((item, i) => i === index ? { ...item, preparedResponse: placeholder } : item) };
            const completed = { ...reserved, entries: reserved.entries.map((item, i) => i === index ? { ...item, response: placeholder } : item) };
            await storage.assertCapacity([prepared, completed]);
          }
          checkPolicy(); checkAllocationIssuance(); assertCurrent();
          const response = entry.preparedResponse ?? await issuer.issue(request);
          if (!entry.preparedResponse) {
            // Keep completed crypto private across an expired observation or a
            // crash. Prepared signatures are NOT an approved cached response:
            // promotion still needs a fresh quorum and the active issuance window.
            const reserved = live();
            await storage.commit({ ...reserved, version: 8, entries: reserved.entries.map((item, i) => i === index ? { ...item, preparedResponse: response } : item) });
          }
          checkPolicy(); checkAllocationIssuance(); assertCurrent();
          const reserved = storage.read(); // Lock/close during crypto must prevent output.
          await storage.commit({ ...reserved, entries: reserved.entries.map((item, i) => i === index ? { permitHash: item.permitHash, ...(item.claim ? { claim: item.claim } : {}), ...(item.assignment ? { assignment: item.assignment } : {}), batchId: request.batchId, response } : item) });
          checkPolicy(); checkAllocationIssuance(); assertCurrent();
          return structuredClone(response); // Only a durably cached response may leave this boundary.
        } finally { busy = false; }
      },
      close() { observation = undefined; storage.close(); },
    };
    return api;
  } finally { options.protection.signingKey.secretKey.fill(0); }
}
export type ProtectedAdmissionIssuerLedger = Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
