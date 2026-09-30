/** Offline-installed shared policy; persisted revision prevents ordinary rollback on restart. */
import { join } from 'node:path';
import { openAdmissionPolicyStore, assertAdmissionPolicyCurrent, parseAdmissionWalletProfile, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { createLocalBlindAdmissionVerifierV2 } from './blind-admission-verifier.js';

export async function createConfiguredAdmissionVerifier(options: {
  directory: string; authority: string; policy: unknown; encryptionKey: Uint8Array; initialize?: boolean;
  now?: () => number; maxSpends?: number;
}) {
  const now = options.now ?? Date.now;
  const store = await openAdmissionPolicyStore({ path: join(options.directory, 'admission-community-policy.json'),
    encryptionKey: options.encryptionKey, mode: options.initialize ? 'create-new' : 'open-existing', now });
  try {
    const policy = await store.install(options.policy, options.authority);
    const entries: Array<AdmissionPolicyKey & { issuerPublicKey: CryptoKey }> = [];
    for (const entry of policy.keys) entries.push({ ...entry, issuerPublicKey: (await parseAdmissionWalletProfile(entry.profile)).publicKey });
    const verifier = createLocalBlindAdmissionVerifierV2({ directory: options.directory, maxSpends: options.maxSpends,
      keyPolicies() {
        const time = now(); assertAdmissionPolicyCurrent(policy, time);
        return entries.map(entry => ({ scope: entry.profile.scope, issuerPublicKey: entry.issuerPublicKey,
          mode: time < entry.notBefore || time >= entry.retryUntil ? 'none' as const
            : time >= entry.spendUntil ? 'replay-only' as const : 'all' as const }));
      },
    });
    return { verifyAndSpend: verifier.verifyAndSpend, close() { verifier.close(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
