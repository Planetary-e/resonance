/** Offline-installed shared policy; persisted revision prevents ordinary rollback on restart. */
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { SigningKeyPair } from '@resonance/core';
import { openAdmissionPolicyStore, assertAdmissionPolicyCurrent, parseAdmissionWalletProfile, admissionKeyFingerprint, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { createLocalBlindAdmissionVerifierV2 } from './blind-admission-verifier.js';
import { openAdmissionSpendHistory } from './admission-spend-history.js';
import { openProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from './protected-admission-history.js';
import { createAdmissionWitness, createAdmissionQuorumGate, type AdmissionWitnessTransport } from './admission-witness.js';
import { historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { createProtectedAdmissionRoles } from './protected-admission-roles.js';

export async function createConfiguredAdmissionVerifier(options: {
  directory: string; authority: string; policy: unknown; encryptionKey: Uint8Array; initialize?: boolean;
  now?: () => number; maxSpends?: number;
  witnessKey?: SigningKeyPair; coordinatorKey?: SigningKeyPair;
  initializeWitnessState?: boolean; witnessTransport?: AdmissionWitnessTransport; witnessTimeoutMs?: number;
  onWitnessSocket?: (socket: Socket) => void;
  historyProtection?: AdmissionHistoryProtection;
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
  let history: ReturnType<typeof openAdmissionSpendHistory> | Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined;
  try {
    const pinnedContext = store.protectedHistoryContext();
    const contextId = options.historyProtection ? historyCheckpointContextId(options.historyProtection.context) : undefined;
    if (pinnedContext && pinnedContext !== contextId) throw new Error('Retained policy requires its original protected history context; local fallback is forbidden');
    if (options.historyDirectory && !pinnedContext) throw new Error('A separate history location requires a reviewed policy/history binding before startup');
    const policy = await store.install(options.policy, options.authority);
    const historyOptions = { directory: options.directory, encryptionKey: options.encryptionKey, policy, now,
      initialize: options.initializeSpendHistory ?? options.initialize, maxSpends: options.maxSpends };
    if (options.historyProtection) {
      const protectedHistory = await openProtectedAdmissionSpendHistory({ ...historyOptions,
        directory: options.historyDirectory ?? options.directory, authority: options.authority, protection: options.historyProtection });
      history = protectedHistory;
      await protectedHistory.ready();
      store.bindProtectedHistory(contextId!); // Durable before any admission can be returned to the caller.
    } else history = openAdmissionSpendHistory(historyOptions);
    const shared = { directory: options.directory, encryptionKey: options.encryptionKey, policy, now, maxSpends: options.maxSpends,
      initialize: options.initializeWitnessState ?? options.initialize };
    if ('roleState' in history) {
      protectedRoles = createProtectedAdmissionRoles({ history, witnessKey: options.witnessKey, coordinatorKey: options.coordinatorKey,
        now, transport: options.witnessTransport, timeoutMs: options.witnessTimeoutMs, onTransportSocket: options.onWitnessSocket });
      witness = protectedRoles.witness; quorum = protectedRoles.quorum;
    } else {
      if (options.witnessKey) witness = createAdmissionWitness({ ...shared, signingKey: options.witnessKey });
      if (options.coordinatorKey) quorum = createAdmissionQuorumGate({ ...shared, signingKey: options.coordinatorKey, transport: options.witnessTransport,
        timeoutMs: options.witnessTimeoutMs, onTransportSocket: options.onWitnessSocket });
    }
    const entries: Array<AdmissionPolicyKey & { issuerPublicKey: CryptoKey }> = [];
    for (const entry of policy.keys) entries.push({ ...entry, issuerPublicKey: (await parseAdmissionWalletProfile(entry.profile)).publicKey });
    const verifier = createLocalBlindAdmissionVerifierV2({ directory: options.directory, maxSpends: options.maxSpends, history,
      async beforeSpend(spend, context, publicKey) {
        const entry = entries.find(entry => entry.issuerPublicKey === publicKey)!;
        if (!entry.witnesses) return;
        if (!quorum) throw new Error('Signed policy requires four witness votes; no coordinator is configured');
        await quorum.authorize(admissionKeyFingerprint(entry.profile.issuerPublicKey), spend, context);
      },
      keyPolicies() {
        const time = now(); assertAdmissionPolicyCurrent(policy, time);
        return entries.map(entry => ({ scope: entry.profile.scope, issuerPublicKey: entry.issuerPublicKey,
          mode: time < entry.notBefore || time >= entry.retryUntil ? 'none' as const
            : time >= entry.spendUntil ? 'replay-only' as const : 'all' as const }));
      },
    });
    return { verifyAndSpend: verifier.verifyAndSpend, witness,
      historyHealth: history && 'health' in history ? history.health : undefined,
      close() { protectedRoles?.close(); quorum?.close(); witness?.close(); verifier.close(); store.close(); } };
  } catch (error) { history?.close(); protectedRoles?.close(); quorum?.close(); witness?.close(); store.close(); throw error; }
}
