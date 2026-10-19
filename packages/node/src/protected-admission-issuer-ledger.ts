import { admissionPolicyProofReference, parseAdmissionPolicyProofAppend, parseArchivedAdmissionPolicyAdvance, verifyArchivedAdmissionPolicy, archivedAdmissionPolicyDigest, assertArchivedAdmissionPolicyCurrent, inspectResolvedAdmissionPolicy, inspectResolvedAdmissionPolicyKey, retainedResolvedAdmissionPolicyKey, AdmissionPolicyArchiveBudget, parseAdmissionPolicyProofReference, type AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
import { type PolicyProofOperation, type PolicyProofCache } from '../../relay/src/admission-policy-history-proof.js';
import type { ProtectedIssuerState as State } from './protected-admission-issuer-state.js';
/** Volunteer-protected issuer. This API directly owns its encrypted image and decisions. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, admissionAuthorityFingerprint, admissionPolicyKeys, isArchivedAdmissionKey } from '@resonance/core/admission-policy';
import { verifyAdmissionIssuanceAllocation, admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent, selectAdmissionIssuerAllocation } from '@resonance/core/admission-issuance-allocation';
import { verifyAdmissionClaimAssignment, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openProtectedIssuerHistory, readProtectedIssuerHistoryRecoverySource, fenceProtectedIssuerHistoryRecoverySource, type ProtectedIssuerHistoryRecoveryEvidence, type ProtectedIssuerHistoryOptions } from '@resonance/relay/protected-issuer-history';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { prepareAdmissionBatchIssuer, validateAdmissionIssuanceTarget, type AdmissionIssuanceResponse } from './blind-admission-issuance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyQuery, type AdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { inspectAdmissionPolicyObservation, parseAdmissionPolicyTrust } from '@resonance/core/admission-policy-trust';

import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis, validateProtectedIssuerPolicyProof } from './protected-admission-issuer-state.js';
import { readPreparedProtectedIssuerRestore, type PreparedProtectedIssuerRestore } from './admission-issuer-history-restore.js';
import { DOMAIN, permitHash, totals, canonicalClaim, claimDigest, claimScopeBinding, assertAdmissionIssuerPolicy, validateAdmissionIssuerPermit, deriveAdmissionIssuerEncryptionKey, IssuerPolicyObservationExpiredError, type AdmissionIssuancePermit } from './admission-issuer-state.js';

export interface ProtectedIssuerRecoverySource {
  readonly path: string; readonly writerDirectory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
export interface ProtectedIssuerRecoveryEvidence extends ProtectedIssuerHistoryRecoveryEvidence<State> {
  profile: AdmissionWalletProfileV1; authority: string;
}
const recoverySources = new WeakMap<ProtectedIssuerRecoverySource, { read(): ProtectedIssuerRecoveryEvidence; fence(): Promise<void> }>();
export function readProtectedIssuerRecoverySource(source: ProtectedIssuerRecoverySource): ProtectedIssuerRecoveryEvidence {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Issuer recovery requires a live authenticated source capability');
  return record.read();
}
export async function fenceProtectedIssuerRecoverySource(source: ProtectedIssuerRecoverySource): Promise<void> {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Issuer recovery requires a live authenticated source capability');
  await record.fence();
}
export interface ProtectedAdmissionIssuerLedgerOptions {
  path: string;
  expectedProfile: unknown;
  privateKey: CryptoKey;
  expectedAllocationAuthority: string;
  protection: Omit<ProtectedIssuerHistoryOptions<State>, 'path' | 'domain' | 'encryptionKey' | 'initial' | 'validate' | 'initialize' | 'restore' | 'assertTransition' | 'validateGenesis' | 'resumeRestoration' | 'resumePristineArchive' | 'validateProof'>;
  /** Fresh creation only. Existing local ledgers cannot be promoted through this API. */
  initialize?: { allocation: unknown; communityPolicy: unknown; observers: unknown };
  /** Reviewed restoration is an in-process capability, never a serialized snapshot or generic adapter option. */
  restore?: { preparation: PreparedProtectedIssuerRestore; approvedDigest: string };
  now?: () => number;
}
export async function openProtectedAdmissionIssuerLedger(options: ProtectedAdmissionIssuerLedgerOptions) {
  if (Object.hasOwn(options.protection, 'restore') || Object.hasOwn(options.protection, 'assertTransition') || Object.hasOwn(options.protection, 'validateGenesis') || Object.hasOwn(options.protection, 'resumeRestoration') || Object.hasOwn(options.protection, 'resumePristineArchive') || Object.hasOwn(options.protection, 'validateProof')) {
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
    const proofOperations = new WeakMap<object, PolicyProofOperation>(), proofCache: PolicyProofCache = new Map();
    let operationSignal: AbortSignal | undefined, installProofOperation: PolicyProofOperation | undefined;
    const proofOperation = (token: object) => {
      if (installProofOperation) return installProofOperation;
      let operation = proofOperations.get(token); if (!operation) { operation = {}; proofOperations.set(token, operation); } return operation;
    };
    const validate = (value: unknown, token?: object) => {
      const installing = installProofOperation?.budget;
      if (installing) return installing.wait(() => parseProtectedIssuerImage(value, { profile, authority }, installing.keyImports));
      const referenceValue = (value as State | null)?.policyProof;
      const operation = token ? proofOperation(token) : undefined;
      if (!operation || !referenceValue && !operation.budget) return parseProtectedIssuerImage(value, { profile, authority });
      const budget = operation.budget ??= new AdmissionPolicyArchiveBudget({ limits: parseAdmissionPolicyProofReference(referenceValue).limits, signal: operationSignal });
      return budget.wait(() => parseProtectedIssuerImage(value, { profile, authority }, budget.keyImports));
    };
    let initial: State | undefined;
    if (options.initialize) {
      const manifest = await verifyAdmissionIssuanceAllocation(structuredClone(options.initialize.allocation), authority);
      if (manifest.version !== 2) throw new Error('Protected issuer requires a v2 authority-assigned allocation');
      assertAdmissionIssuanceAllocationCurrent(manifest, now());
      const selected = selectAdmissionIssuerAllocation(manifest, profile);
      const policy = await verifyAdmissionPolicy(structuredClone(options.initialize.communityPolicy), authority);
      assertAdmissionPolicyCurrent(policy, now());
      if (options.protection.context.policyDigest !== `sha256:${archivedAdmissionPolicyDigest(policy)}`) throw new Error('Protected issuer history policy differs from its independently pinned genesis');
      const observers = parseAdmissionPolicyObservers(structuredClone(options.initialize.observers));
      if (!(policy.revision === observers.genesis.revision && archivedAdmissionPolicyDigest(policy) === observers.genesis.digest)) throw new Error('Issuer observer enrollment requires its independently pinned genesis');
      initial = await validate({ version: 8, allocation: { manifest, authority, digest: admissionIssuanceAllocationDigest(manifest) },
        claimMode: 'authority-assigned-v1', profile, policy: { batchSize: selected.batchSize, maxPermits: selected.maxPermits }, entries: [], communityPolicy: policy,
        freshness: parseAdmissionPolicyTrust({ context: observers, installed: observers.genesis, observed: observers.genesis }, policy) });
      // Creation cannot seal an already inactive issuer baseline.
      const id = admissionKeyFingerprint(profile.issuerPublicKey), entry = admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id)!;
      if (policy.activeKey !== id || now() < entry.notBefore || now() >= entry.issueUntil || isArchivedAdmissionKey(policy, id)) throw new Error('Issuer is retired or inactive under the signed community policy');
    }
    const key = await deriveAdmissionIssuerEncryptionKey(options.privateKey);
    const validateProof = (image: State, source: () => Iterable<import('@resonance/core/history-checkpoint').HistoryCheckpointEnvelope>, token?: object) =>
      validateProtectedIssuerPolicyProof(image, { source, context: options.protection.context, encryptionKey: key, signal: operationSignal, operation: token ? proofOperation(token) : undefined, cache: proofCache });
    let storage: Awaited<ReturnType<typeof openProtectedIssuerHistory<State>>>;
    try {
      if (initial) {
        assertAdmissionIssuanceAllocationCurrent(initial.allocation!.manifest, now());
        assertAdmissionIssuerPolicy(initial, profile, now());
      }
      const restored = options.restore === undefined ? undefined : readPreparedProtectedIssuerRestore(options.restore.preparation, options.restore.approvedDigest,
        { path: options.path, writerDirectory: options.protection.writerDirectory, context: options.protection.context, profile, authority });
      storage = await openProtectedIssuerHistory<State>({ ...options.protection, path: options.path, domain: DOMAIN, encryptionKey: key,
        initialize: !!options.initialize || !!restored, initial: initial!, validate, validateProof, assertTransition: assertProtectedIssuerImageSuccessor, validateGenesis: image => assertProtectedIssuerGenesis(image, options.protection.context), restore: restored, resumeRestoration: undefined, resumePristineArchive: false });
    }
    catch (error) { key.fill(0); throw error; }
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
      const now = (options.now ?? Date.now)(); assertArchivedAdmissionPolicyCurrent(policy, now);
      const issuerKey = admissionKeyFingerprint(profile.issuerPublicKey);
      const retainedPolicy = policy.version === 3 ? [...proofCache.values()].find(value => value.reference.reference === state.policyProof?.reference
        && archivedAdmissionPolicyDigest(inspectResolvedAdmissionPolicy(value.policy).policy) === archivedAdmissionPolicyDigest(policy))?.policy : undefined;
      const entry = policy.version === 3
        ? retainedPolicy && inspectResolvedAdmissionPolicyKey(retainedPolicy, retainedResolvedAdmissionPolicyKey(retainedPolicy, issuerKey))
        : admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
      if (!entry) throw new Error('Issuer retirement requires its exact resolved original membership');
      if (policy.activeKey === issuerKey) throw new Error('Cannot permanently retire the active issuer key; install a successor first');
      if (now < entry.retryUntil) throw new Error('Issuer history must remain until the key retry cutoff');
      const ledgerPath = resolve(options.path), policyDigest = archivedAdmissionPolicyDigest(policy), retained = totals(state);
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
      async reviewRecoverySource(): Promise<ProtectedIssuerRecoverySource> {
        if (busy) throw new Error('Issuer operation is already in progress');
        busy = true;
        try {
          const captured = await storage.reviewRecoverySource();
          const source = Object.freeze({ path: captured.path, writerDirectory: captured.writerDirectory, contextId: captured.contextId, genesisId: captured.genesisId,
            rootId: captured.rootId, generation: captured.generation, stateDigest: captured.stateDigest });
          recoverySources.set(source, { read() { return { ...readProtectedIssuerHistoryRecoverySource(captured), profile: structuredClone(profile), authority }; },
            async fence() {
              if (busy) throw new Error('Issuer operation is already in progress');
              busy = true; observation = undefined;
              try { await fenceProtectedIssuerHistoryRecoverySource(captured); } finally { busy = false; }
            } });
          return source;
        } finally { busy = false; }
      },
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
          const state = live(), retiredAt = now(); assertArchivedAdmissionPolicyCurrent(state.communityPolicy!, retiredAt);
          if (retiredAt < plan.retryUntil) throw new Error('Issuer history must remain until the key retry cutoff');
          await storage.commit({ ...state, version: 9, communityPolicy: state.communityPolicy!, entries: [], retirement: { retiredAt, ...totals(state) } });
          storage.assertServing(); return plan;
        } finally { busy = false; }
      },
      async backfillPolicyProof(appendValue: unknown, limits?: AdmissionPolicyArchiveLimits, signal?: AbortSignal) {
        available(); const state = live(); busy = true; observation = undefined; operationSignal = signal;
        try {
          signal?.throwIfAborted(); const append = parseAdmissionPolicyProofAppend(appendValue);
          if (!state.freshness || state.freshness.conflict) throw new Error('Issuer proof backfill requires independent nonconflicting original pins');
          let head;
          if (!state.policyProof) {
            if (append.kind !== 'genesis' || !limits) throw new Error('Issuer proof backfill starts with original genesis and explicit limits');
            head = state.freshness.context.genesis;
          } else {
            if (limits && JSON.stringify(limits) !== JSON.stringify(state.policyProof.limits)) throw new Error('Issuer proof limits are already pinned');
            if (append.kind !== 'advance' || !sameAdmissionPolicyHead(append.advance.commitment.previous, state.policyProof.head)) throw new Error('Issuer backfill requires its next signed proof step');
            head = append.advance.commitment.next;
          }
          if (head.revision > state.freshness.installed.revision) throw new Error('Issuer backfill exceeds its installed head');
          await storage.commit({ ...state, proofVersion: 1, policyProof: admissionPolicyProofReference(state.freshness.context, head, state.policyProof?.limits ?? limits!), policyProofAppend: append });
          return { head: structuredClone(head), complete: sameAdmissionPolicyHead(head, state.freshness.installed) };
        } finally { busy = false; operationSignal = undefined; }
      },
      async installPolicy(value: unknown, authority: string, pins: { observers?: unknown; advance?: unknown; pages?: Array<{ digest: string; bytes: Uint8Array }>; signal?: AbortSignal } = {}) {
        available(); const state = storage.read();
        if (state.allocation && state.allocation.authority !== authority) throw new Error('Community policy authority does not match the pinned issuer allocation');
        if (state.communityPolicy && state.communityPolicy.authority !== authority) throw new Error('Community authority is already pinned');
        busy = true; observation = undefined;
        try {
          const input = structuredClone(value), advanceInput = pins.advance === undefined ? undefined : structuredClone(pins.advance);
          const observers = pins.observers === undefined ? undefined : parseAdmissionPolicyObservers(pins.observers);
          operationSignal = pins.signal; operationSignal?.throwIfAborted();
          const budget = new AdmissionPolicyArchiveBudget({ signal: operationSignal, limits: state.policyProof?.limits ?? {
            maxPages: 1, maxEntries: 1, maxArchiveBytes: 1, maxHistoryBytes: 1, maxTransitions: 1, maxPageReads: 1, timeoutMs: 3000 } });
          installProofOperation = { budget };
          const policy = await budget.wait(() => verifyArchivedAdmissionPolicy(input, authority, budget.keyImports)); storage.read();
          if (policy.version === 3 && !state.policyProof) throw new Error('Backfill original protected policy proof before installing v3');
          let freshness = state.freshness;
          if (freshness?.conflict) throw new Error('Issuer policy observations conflict; issuance is fenced');
          if (freshness && observers && admissionPolicyObserversId(observers) !== admissionPolicyObserversId(freshness.context)) throw new Error('Issuer policy observers are already pinned');
          const advance = advanceInput === undefined ? undefined : await parseArchivedAdmissionPolicyAdvance(advanceInput, freshness?.context ?? observers!, { signal: operationSignal, budget });
          storage.read();
          if (!advance || !freshness || policy.revision >= freshness.observed.revision) assertArchivedAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
          if (freshness) {
            if (advance) {
              if (!(policy.revision === advance.commitment.next.revision && archivedAdmissionPolicyDigest(policy) === advance.commitment.next.digest)
                || !sameAdmissionPolicyHead(advance.commitment.previous, freshness.installed) && !sameAdmissionPolicyHead(advance.commitment.next, freshness.installed)) {
                throw new Error('Issuer policy update must extend its retained signed transition');
              }
              const head = advance.commitment.next;
              if (head.revision === freshness.observed.revision && !sameAdmissionPolicyHead(head, freshness.observed)) throw new Error('Issuer policy update conflicts with its observed floor');
              freshness = { ...freshness, installed: head, observed: head.revision > freshness.observed.revision ? head : freshness.observed };
            } else if (!(policy.revision === freshness.installed.revision && archivedAdmissionPolicyDigest(policy) === freshness.installed.digest)) throw new Error('Issuer policy freshness requires a signed immediate successor');
          } else if (observers) {
            if (advance || !(policy.revision === observers.genesis.revision && archivedAdmissionPolicyDigest(policy) === observers.genesis.digest)) throw new Error('Issuer observer enrollment requires its independently pinned genesis');
            freshness = parseAdmissionPolicyTrust({ context: observers, installed: observers.genesis, observed: observers.genesis }, policy);
          } else if (advance) throw new Error('Issuer transition requires independently pinned observers');
          if (state.communityPolicy && state.communityPolicy.version !== 3 && policy.version !== 3) assertAdmissionPolicySuccessor(state.communityPolicy, policy);
          if (policy.version !== 3 && !admissionPolicyKeys(policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Issuer is absent from the signed community policy');
          let proofFields = {};
          if (state.policyProof) {
            if (!advance || !freshness || !sameAdmissionPolicyHead(state.policyProof.head, state.freshness!.installed)) throw new Error('Finish exact installed proof backfill before advancing the issuer');
            const append = parseAdmissionPolicyProofAppend({ version: 1, kind: 'advance', advance,
              pages: (pins.pages ?? []).map(page => ({ digest: page.digest, data: Buffer.from(page.bytes).toString('base64url') })) });
            proofFields = { policyProof: admissionPolicyProofReference(freshness.context, freshness.installed, state.policyProof.limits), policyProofAppend: append };
          }
          budget.check();
          // The commit owns durable mutation; only its read-only validators race cancellation.
          await storage.commit({ ...state, communityPolicy: policy, ...(freshness ? { freshness } : {}), ...proofFields }, () => budget.check());
        } finally { busy = false; operationSignal = undefined; installProofOperation = undefined; }
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
      close() { observation = undefined; storage.close(); proofCache.clear(); key.fill(0); },
    };
    return api;
  } finally { options.protection.signingKey.secretKey.fill(0); }
}
export type ProtectedAdmissionIssuerLedger = Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
