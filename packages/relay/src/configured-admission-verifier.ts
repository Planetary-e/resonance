import { assertArchivedAdmissionPolicyCurrent, type ArchivedAdmissionPolicy, type AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
/** Offline-installed shared policy; persisted revision prevents ordinary rollback on restart. */
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { SigningKeyPair } from '@resonance/core';
import { openAdmissionPolicyStore, parseAdmissionWalletProfile, admissionKeyFingerprint, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { createLocalBlindAdmissionVerifierV2 } from './blind-admission-verifier.js';
import { openAdmissionSpendHistory } from './admission-spend-history.js';
import { openProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from './protected-admission-history.js';
import { createAdmissionWitness, createAdmissionQuorumGate, type AdmissionWitnessTransport } from './admission-witness.js';
import { historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { createProtectedAdmissionRoles } from './protected-admission-roles.js';
import { verifyAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import type { AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { createAdmissionPolicyFreshnessGate } from './admission-policy-freshness-gate.js';
import type { AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';
import type { OwnedPolicyObservationTransport } from './admission-policy-observation-pool.js';
import { createAdmissionDecisionQueue } from './admission-decision-queue.js';

export async function createConfiguredAdmissionVerifier(options: {
  directory: string; authority: string; policy: unknown; encryptionKey: Uint8Array; initialize?: boolean;
  now?: () => number; maxSpends?: number;
  witnessKey?: SigningKeyPair; coordinatorKey?: SigningKeyPair;
  initializeWitnessState?: boolean; witnessTransport?: AdmissionWitnessTransport; witnessTimeoutMs?: number;
  onWitnessSocket?: (socket: Socket) => void;
  policyObservers?: AdmissionPolicyObservers; policyAdvance?: unknown;
  policyObservationTransport?: AdmissionPolicyObservationTransport; policyObservationTimeoutMs?: number;
  /** Trusted owner-scoped adapter, recreated and closed with this verifier. */
  policyObservationTransportFactory?: (context: AdmissionPolicyObservers) => OwnedPolicyObservationTransport;
  onPolicySocket?: (socket: Socket) => void;
  historyProtection?: AdmissionHistoryProtection;
  /** One bounded original proof backfill step, retained by the protected history before local activation. */
  policyProofAppend?: unknown; policyProofLimits?: AdmissionPolicyArchiveLimits;
  policyPages?: Array<{ digest: string; bytes: Uint8Array }>;
  /** Explicit protected spend/writer location; policy and witness state stay in directory. */
  historyDirectory?: string;
  /** An explicitly prepared protected spend history can precede policy/witness initialization. */
  initializeSpendHistory?: boolean;
}) {
  if (options.historyDirectory !== undefined && (!options.historyProtection || !options.historyDirectory.trim())) {
    throw new Error('A separate admission history directory requires protected history');
  }
  const now = options.now ?? Date.now;
  const store = await openAdmissionPolicyStore({ path: join(options.directory, 'admission-community-policy.json'),
    encryptionKey: options.encryptionKey, mode: options.initialize ? 'create-new' : 'open-existing', now });
  let witness: ReturnType<typeof createAdmissionWitness> | ReturnType<typeof createProtectedAdmissionRoles>['witness'];
  let quorum: ReturnType<typeof createAdmissionQuorumGate> | ReturnType<typeof createProtectedAdmissionRoles>['quorum'];
  let protectedRoles: ReturnType<typeof createProtectedAdmissionRoles> | undefined;
  let freshness: ReturnType<typeof createAdmissionPolicyFreshnessGate> | undefined;
  let decisions: ReturnType<typeof createAdmissionDecisionQueue> | undefined;
  let history: ReturnType<typeof openAdmissionSpendHistory> | Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined;
  try {
    const pinnedContext = store.protectedHistoryContext();
    const contextId = options.historyProtection ? historyCheckpointContextId(options.historyProtection.context) : undefined;
    if (pinnedContext && pinnedContext !== contextId) throw new Error('Retained policy requires its original protected history context; local fallback is forbidden');
    if (options.historyDirectory && !pinnedContext) throw new Error('A separate history location requires a reviewed policy/history binding before startup');
    let policy: ArchivedAdmissionPolicy;
    const historyOptions = { directory: options.directory, encryptionKey: options.encryptionKey, now,
      initialize: options.initializeSpendHistory ?? options.initialize, maxSpends: options.maxSpends };
    if (options.historyProtection) {
      const protectedHistory = await openProtectedAdmissionSpendHistory({ ...historyOptions, policy: options.policy,
        directory: options.historyDirectory ?? options.directory, authority: options.authority, protection: options.historyProtection,
        policyAdvance: options.policyAdvance, policyPages: options.policyPages, policyTrust: store.freshness() });
      history = protectedHistory;
      await protectedHistory.ready();
      if (options.policyProofAppend !== undefined) {
        const trust = store.freshness();
        if (!trust) throw new Error('Protected relay backfill requires independently pinned original observers');
        await protectedHistory.backfillPolicyProof(options.policyProofAppend, trust, options.policyProofLimits);
      }
      policy = protectedHistory.policy();
      const image = protectedHistory.read().image;
      if (image.policyProof && image.policyTrust && image.policyProof.head.revision === image.policyTrust.installed.revision) {
        const resolved = await protectedHistory.resolvedPolicy();
        policy = store.mirrorResolved(resolved.capability, resolved.reference, resolved.freshness, contextId!);
      } else {
        if (policy.version === 3) throw new Error('Protected relay policy proof is incomplete');
        await store.install(policy, options.authority, { observers: options.policyObservers, advance: options.policyAdvance });
        store.bindProtectedHistory(contextId!);
      }
    } else {
      if (options.policyProofAppend !== undefined || options.policyProofLimits !== undefined || options.policyPages !== undefined) throw new Error('Policy proof migration requires protected role history');
      policy = await store.install(options.policy, options.authority, { observers: options.policyObservers, advance: options.policyAdvance });
      history = openAdmissionSpendHistory({ ...historyOptions, policy });
    }
    if (store.freshness()) freshness = createAdmissionPolicyFreshnessGate({ store, now, timeoutMs: options.policyObservationTimeoutMs,
      transport: options.policyObservationTransport, transportFactory: options.policyObservationTransportFactory, onSocket: options.onPolicySocket,
      ...('observePolicy' in history && history.read().image.policyTrust ? { async observe(observation) {
        try { await (history as Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>).observePolicy(observation); }
        finally { store.observe(observation); }
      } } : {}) });
    const shared = { directory: options.directory, encryptionKey: options.encryptionKey, policy, now, maxSpends: options.maxSpends,
      initialize: options.initializeWitnessState ?? options.initialize };
    if ('roleState' in history) {
      protectedRoles = createProtectedAdmissionRoles({ history, witnessKey: options.witnessKey, coordinatorKey: options.coordinatorKey,
        now, transport: options.witnessTransport, timeoutMs: options.witnessTimeoutMs, onTransportSocket: options.onWitnessSocket });
      witness = protectedRoles.witness; quorum = protectedRoles.quorum;
    } else {
      if (policy.version === 3) throw new Error('Local witness entrypoints refuse v3');
      const legacyShared = { ...shared, policy };
      if (options.witnessKey) witness = createAdmissionWitness({ ...legacyShared, signingKey: options.witnessKey });
      if (options.coordinatorKey) quorum = createAdmissionQuorumGate({ ...legacyShared, signingKey: options.coordinatorKey, transport: options.witnessTransport,
        timeoutMs: options.witnessTimeoutMs, onTransportSocket: options.onWitnessSocket });
    }
    const entries: Array<AdmissionPolicyKey & { issuerPublicKey: CryptoKey }> = [];
    for (const entry of policy.keys) entries.push({ ...entry, issuerPublicKey: (await parseAdmissionWalletProfile(entry.profile)).publicKey });
    if (options.historyProtection) decisions = createAdmissionDecisionQueue({
      timeoutMs: options.policyObservationTimeoutMs ?? options.witnessTimeoutMs ?? 3000 });
    const protectedHistory = 'roleState' in history ? history : undefined;
    const spendHooks: Pick<Parameters<typeof createLocalBlindAdmissionVerifierV2>[0], 'beforeSpend' | 'withSpendCommit'> = protectedHistory ? {
      async withSpendCommit(spend, context, publicKey, finish) {
        const entry = entries.find(entry => entry.issuerPublicKey === publicKey)!;
        if (!entry.witnesses) return finish();
        const coordinator = protectedRoles?.quorum;
        if (!coordinator) throw new Error('Signed policy requires four witness votes; no coordinator is configured');
        return coordinator.withCertificate(admissionKeyFingerprint(entry.profile.issuerPublicKey), spend, context,
          certificate => finish(row => protectedHistory.writeAuthorizedSpend(row, certificate)));
      },
    } : {
      async beforeSpend(spend, context, publicKey) {
        const entry = entries.find(entry => entry.issuerPublicKey === publicKey)!;
        if (!entry.witnesses) return;
        if (!quorum) throw new Error('Signed policy requires four witness votes; no coordinator is configured');
        await quorum.authorize(admissionKeyFingerprint(entry.profile.issuerPublicKey), spend, context);
      },
    };
    const verifier = createLocalBlindAdmissionVerifierV2({ directory: options.directory, maxSpends: options.maxSpends, history,
      withCurrentPolicy: freshness?.run,
      withDecision: decisions && freshness ? operation => decisions!.runPrepared(
        (_assertLive, signal) => freshness!.prepare(signal),
        (prepared, assertLive, signal) => operation(assertLive, signal, prepared)) : decisions?.run,
      ...spendHooks,
      keyPolicies() {
        const time = now(); assertArchivedAdmissionPolicyCurrent(policy, time);
        return entries.map(entry => ({ scope: entry.profile.scope, issuerPublicKey: entry.issuerPublicKey,
          mode: time < entry.notBefore || time >= entry.retryUntil ? 'none' as const
            : time >= entry.spendUntil ? 'replay-only' as const : 'all' as const }));
      },
    });
    const guardedWitness = witness && freshness ? { close: witness.close, async vote(value: unknown, acceptNew?: () => boolean) {
      const issuerKey = (value as { issuerKey?: unknown } | null)?.issuerKey;
      const entry = entries.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
      if (!entry?.witnesses || !verifyAdmissionWitnessRequest(value, entry.witnesses)) throw new Error('Unauthenticated admission vote request');
      const request = structuredClone(value);
      return freshness!.run(async assertCurrent => {
        assertCurrent(); const result = await witness!.vote(request, () => { assertCurrent(); return acceptNew?.() ?? true; });
        assertCurrent(); return result;
      });
    } } : witness;
    return { verifyAndSpend: verifier.verifyAndSpend, witness: guardedWitness,
      policyFreshnessHealth: freshness?.health,
      admissionDecisionHealth: decisions?.health,
      historyHealth: history && 'health' in history ? history.health : undefined,
      drainPolicyObservations: () => Promise.all([decisions?.close(), freshness?.close()]).then(() => {}),
      close() { void decisions?.close(); void freshness?.close(); protectedRoles?.close(); quorum?.close(); witness?.close(); verifier.close(); store.close(); } };
  } catch (error) { void decisions?.close(); void freshness?.close(); history?.close(); protectedRoles?.close(); quorum?.close(); witness?.close(); store.close(); throw error; }
}
