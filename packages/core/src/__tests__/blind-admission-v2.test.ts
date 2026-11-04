import { describe, expect, it } from 'vitest';
import { publicVerif } from '@cloudflare/privacypass-ts';
import {
  createAdmissionRequestBindingV2,
  createBlindAdmissionRequestV2,
  issueBlindAdmissionRequestV2,
  presentBlindAdmissionTokenV2,
  verifyBlindAdmissionTokenV2,
} from '../index.js';

describe('publicly verifiable blind admission', () => {
  it('issues a blinded token and accepts only its scope and bound presentation', async () => {
    const mode = publicVerif.BlindRSAMode.PSS;
    const keys = await publicVerif.Issuer.generateKey(mode, {
      modulusLength: 2048,
      publicExponent: Uint8Array.from([1, 0, 1]),
    });
    const issuer = new publicVerif.Issuer(mode, 'community-barcelona', keys.privateKey, keys.publicKey);
    const scope = { issuer: 'community-barcelona', community: 'barcelona', epoch: '2026-09' };
    const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey);
    const response = await issueBlindAdmissionRequestV2(issuer, blinded.request);
    const token = await blinded.finalize(response);
    const binding = createAdmissionRequestBindingV2('search', { query: 'one' });
    const capability = await presentBlindAdmissionTokenV2(token, scope, 'search', binding);
    const spend = await verifyBlindAdmissionTokenV2(capability, scope, 'search', binding, keys.publicKey);
    const exportedKey = await crypto.subtle.exportKey('spki', keys.publicKey);
    const importedKey = await crypto.subtle.importKey(
      'spki', exportedKey, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify'],
    );

    expect(spend).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyBlindAdmissionTokenV2(capability, scope, 'search', binding, importedKey)).toBe(spend);
    expect(JSON.stringify(capability)).not.toContain('did:key:');
    expect(await verifyBlindAdmissionTokenV2(capability, scope, 'search', 'other', keys.publicKey)).toBeNull();
    expect(await verifyBlindAdmissionTokenV2(capability, { ...scope, epoch: '2026-10' }, 'search', binding, keys.publicKey)).toBeNull();
    expect(await verifyBlindAdmissionTokenV2({ ...capability, token: `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}` }, scope, 'search', binding, keys.publicKey)).toBeNull();
    expect(await verifyBlindAdmissionTokenV2({ ...capability, issuer: 'other' }, scope, 'search', binding, keys.publicKey)).toBeNull();
  });
});
