import { generateKeyPairSync } from 'node:crypto';
import { generateSigningKeyPair } from '../../crypto.js';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyKey } from '../../admission-policy.js';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '../../admission-policy-advance.js';
import { parseAdmissionPolicyObservers } from '../../admission-policy-freshness.js';

export async function policyTransferFixture(large = false) {
  const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url'), now = Date.now();
  const keys = Array.from({ length: 5 }, generateSigningKeyPair);
  const members = keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${36000 + i}/` }));
  const entries: AdmissionPolicyKey[] = Array.from({ length: large ? 32 : 1 }, (_, i) => {
    const issuerPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return { profile: { version: 1, scope: { issuer: 'transfer-fixture', community: 'public', epoch: `period-${i}` }, issuerPublicKey,
      relayUrls: Array.from({ length: large ? 8 : 1 }, (_, j) => `ws://127.0.0.1:${36100 + j}/${large ? 'a'.repeat(460) : ''}`) },
      notBefore: now - 10000, issueUntil: now + (i ? -3000 : 100000), spendUntil: now + (i ? -2000 : 200000), retryUntil: now + (i ? -1000 : 300000),
      ...(large ? { witnesses: { version: 1 as const, quorum: 4 as const, members: members.map(m => ({ ...m, endpoint: m.endpoint + 'b'.repeat(460) })), coordinators: [authority] } } : {}) };
  });
  const body = { version: 2 as const, kind: 'admission-policy' as const, revision: 1, issuedAt: now, expiresAt: now + 600000,
    activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: [entries[0]], archivedKeys: entries.slice(1) };
  const first = await signAdmissionPolicy(body, authority, key.secretKey);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(first), quorum: 4, members });
  const second = await signAdmissionPolicy({ ...body, revision: 2 }, authority, key.secretKey);
  const advance = await createAdmissionPolicyAdvance(first, second, context, key);
  return { first, second, advance, context, key, keys, close() { key.secretKey.fill(0); keys.forEach(k => k.secretKey.fill(0)); } };
}
