/** Offline-installed shared policy; persisted revision prevents ordinary rollback on restart. */
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { SigningKeyPair } from '@resonance/core';
import { openAdmissionPolicyStore, assertAdmissionPolicyCurrent, parseAdmissionWalletProfile, admissionKeyFingerprint, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { createLocalBlindAdmissionVerifierV2 } from './blind-admission-verifier.js';
import { openAdmissionSpendHistory } from './admission-spend-history.js';
import { createAdmissionWitness, createAdmissionQuorumGate, type AdmissionWitnessTransport } from './admission-witness.js';

export async function createConfiguredAdmissionVerifier(options: {
  directory: string; authority: string; policy: unknown; encryptionKey: Uint8Array; initialize?: boolean;
  now?: () => number; maxSpends?: number;
  witnessKey?: SigningKeyPair; coordinatorKey?: SigningKeyPair;
  initializeWitnessState?: boolean; witnessTransport?: AdmissionWitnessTransport; witnessTimeoutMs?: number;
  onWitnessSocket?: (socket: Socket) => void;
}) {
  const now = options.now ?? Date.now;
  const store = await openAdmissionPolicyStore({ path: join(options.directory, 'admission-community-policy.json'),
    encryptionKey: options.encryptionKey, mode: options.initialize ? 'create-new' : 'open-existing', now });
  let witness: ReturnType<typeof createAdmissionWitness> | undefined;
  let quorum: ReturnType<typeof createAdmissionQuorumGate> | undefined;
  let history: ReturnType<typeof openAdmissionSpendHistory> | undefined;
  try {
    const policy = await store.install(options.policy, options.authority);
    const shared = { directory: options.directory, encryptionKey: options.encryptionKey, policy, now, maxSpends: options.maxSpends,
      initialize: options.initializeWitnessState ?? options.initialize };
    if (options.witnessKey) witness = createAdmissionWitness({ ...shared, signingKey: options.witnessKey });
    if (options.coordinatorKey) quorum = createAdmissionQuorumGate({ ...shared, signingKey: options.coordinatorKey, transport: options.witnessTransport,
      timeoutMs: options.witnessTimeoutMs, onTransportSocket: options.onWitnessSocket });
    const entries: Array<AdmissionPolicyKey & { issuerPublicKey: CryptoKey }> = [];
    for (const entry of policy.keys) entries.push({ ...entry, issuerPublicKey: (await parseAdmissionWalletProfile(entry.profile)).publicKey });
    history = openAdmissionSpendHistory({ directory: options.directory, encryptionKey: options.encryptionKey, policy, now,
      initialize: options.initialize, maxSpends: options.maxSpends });
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
    return { verifyAndSpend: verifier.verifyAndSpend, witness, close() { quorum?.close(); witness?.close(); verifier.close(); store.close(); } };
  } catch (error) { history?.close(); quorum?.close(); witness?.close(); store.close(); throw error; }
}
