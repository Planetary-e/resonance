import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from '../crypto.js';
import { createHistorySignatureVerifier } from '../history-signature.js';

afterEach(() => vi.restoreAllMocks());

describe('bounded history signature verification', () => {
  it('reuses exact authenticated bytes without retaining mutable input references', () => {
    const key = crypto.generateSigningKeyPair(), original = Buffer.from('history proof'), message = Buffer.from(original);
    const signature = crypto.sign(message, key.secretKey), check = createHistorySignatureVerifier();
    const verifier = vi.spyOn(crypto, 'verify');
    expect(check(message, signature, key.publicKey)).toBe(true);
    expect(check(Buffer.from(message), Uint8Array.from(signature), Uint8Array.from(key.publicKey))).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
    message[0] ^= 1; expect(check(message, signature, key.publicKey)).toBe(false);
    message[0] ^= 1; signature[0] ^= 1; expect(check(message, signature, key.publicKey)).toBe(false);
    signature[0] ^= 1; key.publicKey[0] ^= 1; expect(check(message, signature, key.publicKey)).toBe(false);
    key.publicKey[0] ^= 1; expect(check(original, signature, key.publicKey)).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(4);
  });

  it('never caches failures, rejects malformed lengths, and evicts least-recent successes', () => {
    const key = crypto.generateSigningKeyPair(), check = createHistorySignatureVerifier(2);
    const messages = ['one', 'two', 'three'].map(s => Buffer.from(s)), signatures = messages.map(m => crypto.sign(m, key.secretKey));
    const verifier = vi.spyOn(crypto, 'verify');
    expect(check(messages[0], signatures[1], key.publicKey)).toBe(false);
    expect(check(messages[0], signatures[1], key.publicKey)).toBe(false);
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(check(messages[0], signatures[0].subarray(1), key.publicKey)).toBe(false);
    expect(check(messages[0], signatures[0], key.publicKey.subarray(1))).toBe(false);
    const run = (i: number) => expect(check(messages[i], signatures[i], key.publicKey)).toBe(true);
    run(0); run(1); run(0); run(2); run(0);
    expect(verifier).toHaveBeenCalledTimes(5);
    run(1); expect(verifier).toHaveBeenCalledTimes(6);
    expect(() => createHistorySignatureVerifier(0)).toThrow();
    expect(() => createHistorySignatureVerifier(1025)).toThrow();
  });
});
