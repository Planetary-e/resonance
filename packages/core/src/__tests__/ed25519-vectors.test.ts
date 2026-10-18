import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { generateSigningKeyPair, sign, verify } from '../crypto.js';

interface Vector { tcId: number; msg: string; sig: string; result: 'valid' | 'invalid' }
const vectors = JSON.parse(readFileSync(new URL('./fixtures/wycheproof/ed25519_test.json', import.meta.url), 'utf8')) as {
  numberOfTests: number; testGroups: Array<{ publicKey: { pk: string }; tests: Vector[] }>;
};
const tests = vectors.testGroups.flatMap(group => group.tests.map(test => ({ ...test, publicKey: group.publicKey.pk })));
// RFC 8032 section 7.1, tests 1–3: https://www.rfc-editor.org/rfc/rfc8032#section-7.1
it.each([
  ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
  ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
  ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82',
    '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
])('matches the RFC 8032 signing vector for seed %s', (seed, publicKey, message, signature) => {
  expect(Buffer.from(sign(Buffer.from(message, 'hex'), Buffer.from(seed + publicKey, 'hex'))).toString('hex')).toBe(signature);
});
it.each(tests)('matches pinned Wycheproof Ed25519 case $tcId ($result)', vector => {
  expect(verify(Buffer.from(vector.msg, 'hex'), Buffer.from(vector.sig, 'hex'), Buffer.from(vector.publicKey, 'hex'))).toBe(vector.result === 'valid');
});
it('covers every pinned vector and preserves existing generated keys, signatures and message formats', () => {
  expect(tests).toHaveLength(vectors.numberOfTests); expect(tests).toHaveLength(151);
  for (const length of [0, 1, 32, 128, 4096, 65536]) {
    const key = generateSigningKeyPair(), message = new Uint8Array(length).fill(42), signature = sign(message, key.secretKey);
    expect(signature).toEqual(nacl.sign.detached(message, key.secretKey));
    expect(verify(message, signature, key.publicKey)).toBe(true); expect(nacl.sign.detached.verify(message, signature, key.publicKey)).toBe(true);
    const changed = Uint8Array.from(signature); changed[0] ^= 1; expect(verify(message, changed, key.publicKey)).toBe(false);
    expect(verify(message, signature, generateSigningKeyPair().publicKey)).toBe(false); key.secretKey.fill(0);
  }
});
it('preserves exact signing views and rejects mutated or truncated keys instead of caching private authority', () => {
  const key = generateSigningKeyPair(), other = generateSigningKeyPair();
  const backing = Buffer.alloc(80, 23), secret = backing.subarray(8, 72); secret.set(key.secretKey);
  const message = Buffer.from('prefix message suffix').subarray(7, 14);
  expect(sign(message, secret)).toEqual(nacl.sign.detached(message, key.secretKey));
  secret[63] ^= 1; expect(() => sign(message, secret)).toThrow('Invalid Ed25519 secret key');
  secret.set(other.secretKey); expect(sign(message, secret)).toEqual(nacl.sign.detached(message, other.secretKey));
  secret.fill(0); expect(() => sign(message, secret)).toThrow('Invalid Ed25519 secret key');
  for (const size of [0, 32, 63, 65]) expect(() => sign(message, new Uint8Array(size))).toThrow('Invalid Ed25519 signing input');
  key.secretKey.fill(0); other.secretKey.fill(0);
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
