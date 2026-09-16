import { describe, expect, it } from 'vitest';
import {
  createAdmissionRequestBindingV2,
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
} from '../index.js';

function capability(): AdmissionCapabilityV2 {
  return {
    version: 2,
    kind: 'admission-capability',
    scheme: 'test-blind-token-v1',
    issuer: 'community:barcelona:2026-09',
    token: 'A'.repeat(43),
    requestProof: 'B'.repeat(43),
  };
}

describe('anonymous admission capability interface', () => {
  it('accepts a bounded opaque presentation with no user identifier', () => {
    const value = capability();

    expect(verifyAdmissionCapabilityV2(value)).toBe(true);
    expect(JSON.stringify(value)).not.toContain('did:key:');
    expect(value).not.toHaveProperty('user');
    expect(value).not.toHaveProperty('subject');
  });

  it('rejects unknown fields and malformed opaque values', () => {
    expect(verifyAdmissionCapabilityV2({ ...capability(), ownerDid: 'did:key:tracking' })).toBe(false);
    expect(verifyAdmissionCapabilityV2({ ...capability(), token: 'not base64url!' })).toBe(false);
    expect(verifyAdmissionCapabilityV2({ ...capability(), scheme: 'UPPERCASE' })).toBe(false);
  });

  it('binds canonical request content and action without depending on key order', () => {
    const first = createAdmissionRequestBindingV2('search', { b: [2, 3], a: 1 });
    const reordered = createAdmissionRequestBindingV2('search', { a: 1, b: [2, 3] });
    const modified = createAdmissionRequestBindingV2('search', { a: 1, b: [2, 4] });
    const anotherAction = createAdmissionRequestBindingV2('mailbox-fetch', { a: 1, b: [2, 3] });

    expect(first).toMatch(/^admreq_[A-Za-z0-9_-]{86}$/);
    expect(reordered).toBe(first);
    expect(modified).not.toBe(first);
    expect(anotherAction).not.toBe(first);
  });
});
