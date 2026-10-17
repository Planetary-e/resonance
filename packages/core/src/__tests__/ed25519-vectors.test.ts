import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { generateSigningKeyPair, sign, verify } from '../crypto.js';

interface Vector { tcId: number; msg: string; sig: string; result: 'valid' | 'invalid' }
const vectors = JSON.parse(readFileSync(new URL('./fixtures/wycheproof/ed25519_test.json', import.meta.url), 'utf8')) as {
  numberOfTests: number; testGroups: Array<{ publicKey: { pk: string }; tests: Vector[] }>;
};
const tests = vectors.testGroups.flatMap(group => group.tests.map(test => ({ ...test, publicKey: group.publicKey.pk })));
it.each(tests)('matches pinned Wycheproof Ed25519 case $tcId ($result)', vector => {
  expect(verify(Buffer.from(vector.msg, 'hex'), Buffer.from(vector.sig, 'hex'), Buffer.from(vector.publicKey, 'hex'))).toBe(vector.result === 'valid');
});
it('covers every pinned vector and preserves existing generated keys, signatures and message formats', () => {
  expect(tests).toHaveLength(vectors.numberOfTests); expect(tests).toHaveLength(151);
  for (const length of [0, 1, 32, 128, 4096, 65536]) {
    const key = generateSigningKeyPair(), message = new Uint8Array(length).fill(42), signature = sign(message, key.secretKey);
    expect(verify(message, signature, key.publicKey)).toBe(true); expect(nacl.sign.detached.verify(message, signature, key.publicKey)).toBe(true);
    const changed = Uint8Array.from(signature); changed[0] ^= 1; expect(verify(message, changed, key.publicKey)).toBe(false);
    expect(verify(message, signature, generateSigningKeyPair().publicKey)).toBe(false); key.secretKey.fill(0);
  }
});
it('checks every message and signature after caching a key, using its current bytes and exact view', () => {
  const key = generateSigningKeyPair(), other = generateSigningKeyPair();
  const message = Buffer.from('cached public keys confer no authority'), signature = sign(message, key.secretKey);
  const backing = Buffer.alloc(48, 11), publicKey = backing.subarray(8, 40); publicKey.set(key.publicKey);
  expect(verify(message, signature, publicKey)).toBe(true);
  publicKey.set(other.publicKey); expect(verify(message, signature, publicKey)).toBe(false);
  publicKey.set(key.publicKey); expect(verify(message, signature, publicKey)).toBe(true);
  message[0] ^= 1; expect(verify(message, signature, publicKey)).toBe(false);
  message[0] ^= 1; signature[0] ^= 1; expect(verify(message, signature, publicKey)).toBe(false);
  signature[0] ^= 1; expect(verify(message, signature, publicKey)).toBe(true);
  for (const size of [0, 31, 33, 64]) expect(verify(message, signature, new Uint8Array(size))).toBe(false);
  key.secretKey.fill(0); other.secretKey.fill(0);
});
