import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateSigningKeyPair, createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2 } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyBody } from '@resonance/core/admission-policy';

export async function witnessFixture(endpoints = Array.from({ length: 5 }, (_, i) => `ws://127.0.0.1:${45630 + i}/`)) {
  const authorityKey = generateSigningKeyPair(), witnesses = Array.from({ length: 5 }, generateSigningKeyPair), coordinators = Array.from({ length: 2 }, generateSigningKeyPair);
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]) });
  const scope = { issuer: 'witness-community', community: 'public', epoch: 'witness-period-one' };
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----\n`;
  const time = Date.now();
  const body: AdmissionPolicyBody = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: time - 1000, expiresAt: time + 86400000,
    activeKey: admissionKeyFingerprint(pem), keys: [{ profile: { version: 1, scope, issuerPublicKey: pem, relayUrls: ['ws://127.0.0.1:45640/','ws://127.0.0.1:45641/'] },
      notBefore: time - 1000, issueUntil: time + 3600000, spendUntil: time + 7200000, retryUntil: time + 10800000,
      witnesses: { version: 1, quorum: 4, members: witnesses.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: endpoints[i] })),
        coordinators: coordinators.map(key => Buffer.from(key.publicKey).toString('base64url')) } }] };
  const policy = await signAdmissionPolicy(body, authority, authorityKey.secretKey);
  return { authority, authorityKey, witnesses, coordinators, keys, scope, body, policy, time,
    async token() { const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey); return blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request)); } };
}
