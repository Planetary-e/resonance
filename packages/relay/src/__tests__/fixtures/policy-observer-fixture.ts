import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyBody } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance, admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';

export async function policyObserverFixture(options: { policyLifetimeMs?: number; keyLifetimeMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'policy-observer-')), key = generateSigningKeyPair();
  const authority = Buffer.from(key.publicKey).toString('base64url'), keys = Array.from({ length: 5 }, generateSigningKeyPair);
  const issuerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuerPublicKey = issuerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyLifetime = options.keyLifetimeMs ?? 30000;
  const now = Date.now(), body: AdmissionPolicyBody = { version: 1, kind: 'admission-policy', revision: 1,
    issuedAt: now - 1000, expiresAt: now + (options.policyLifetimeMs ?? 60000), activeKey: admissionKeyFingerprint(issuerPublicKey),
    keys: [{ profile: { version: 1, scope: { issuer: 'observer-fixture', community: 'public', epoch: 'one' }, issuerPublicKey,
      relayUrls: ['ws://127.0.0.1:33000/'] }, notBefore: now - 1000, issueUntil: now + keyLifetime / 3, spendUntil: now + keyLifetime * 2 / 3, retryUntil: now + keyLifetime }] };
  const first = await signAdmissionPolicy(body, authority, key.secretKey);
  const second = await signAdmissionPolicy({ ...body, revision: 2 }, authority, key.secretKey);
  const fork = await signAdmissionPolicy({ ...body, revision: 2, expiresAt: body.expiresAt + 1 }, authority, key.secretKey);
  const third = await signAdmissionPolicy({ ...body, revision: 3 }, authority, key.secretKey);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(first), quorum: 4,
    members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${33001 + i}/` })) });
  const advance = await createAdmissionPolicyAdvance(first, second, context, key), conflict = await createAdmissionPolicyAdvance(first, fork, context, key);
  const later = await createAdmissionPolicyAdvance(second, third, context, key, advance.commitment.next);
  const observerOptions = { path: join(directory, 'observer.json'), encryptionKey: randomBytes(32), context, signingKey: keys[0], initialPolicy: first, now: () => now };
  return { directory, key, keys, issuerPrivateKey: issuerKeys.privateKey, authority, body, now, first, second, fork, third, advance, conflict, later, context, options: observerOptions,
    close() { key.secretKey.fill(0); keys.forEach(key => key.secretKey.fill(0)); observerOptions.encryptionKey.fill(0); rmSync(directory, { recursive: true, force: true }); } };
}
