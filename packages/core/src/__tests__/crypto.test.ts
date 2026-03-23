import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  publicKeyToDid,
  didToPublicKey,
  sign,
  verify,
  boxEncrypt,
  boxDecrypt,
  generateEphemeralKeyPair,
  deriveSharedSecret,
  secretboxEncrypt,
  secretboxDecrypt,
  exportIdentity,
  importIdentity,
  decodeUTF8,
  encodeUTF8,
} from '../crypto.js';

describe('Identity', () => {
  it('generates valid keypair and DID', () => {
    const id = generateIdentity();
    expect(id.publicKey).toBeInstanceOf(Uint8Array);
    expect(id.publicKey.length).toBe(32);
    expect(id.secretKey).toBeInstanceOf(Uint8Array);
    expect(id.secretKey.length).toBe(64);
    expect(id.did).toMatch(/^did:key:z6Mk/);
  });

  it('generates unique identities', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.did).not.toBe(b.did);
  });

  it('DID round-trips through publicKeyToDid/didToPublicKey', () => {
    const id = generateIdentity();
    const extracted = didToPublicKey(id.did);
    expect(extracted).toEqual(id.publicKey);
    expect(publicKeyToDid(extracted)).toBe(id.did);
  });

  it('rejects invalid DID format', () => {
    expect(() => didToPublicKey('not-a-did')).toThrow('Invalid did:key');
  });
});

describe('Signing', () => {
  it('sign + verify round-trip', () => {
    const id = generateIdentity();
    const message = decodeUTF8('hello world');
    const sig = sign(message, id.secretKey);
    expect(sig.length).toBe(64);
    expect(verify(message, sig, id.publicKey)).toBe(true);
  });

  it('rejects tampered message', () => {
    const id = generateIdentity();
    const message = decodeUTF8('hello world');
    const sig = sign(message, id.secretKey);
    const tampered = decodeUTF8('hello worl!');
    expect(verify(tampered, sig, id.publicKey)).toBe(false);
  });

  it('rejects wrong public key', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const message = decodeUTF8('test');
    const sig = sign(message, a.secretKey);
    expect(verify(message, sig, b.publicKey)).toBe(false);
  });
});

describe('Box Encryption', () => {
  it('encrypt + decrypt round-trip', () => {
    const sender = generateEphemeralKeyPair();
    const recipient = generateEphemeralKeyPair();

    const plaintext = decodeUTF8('secret message');
    const { nonce, ciphertext } = boxEncrypt(plaintext, recipient.publicKey, sender.secretKey);

    const decrypted = boxDecrypt(ciphertext, nonce, sender.publicKey, recipient.secretKey);
    expect(decrypted).not.toBeNull();
    expect(encodeUTF8(decrypted!)).toBe('secret message');
  });

  it('fails with wrong recipient key', () => {
    const sender = generateEphemeralKeyPair();
    const recipient = generateEphemeralKeyPair();
    const wrong = generateEphemeralKeyPair();

    const plaintext = decodeUTF8('secret');
    const { nonce, ciphertext } = boxEncrypt(plaintext, recipient.publicKey, sender.secretKey);

    const decrypted = boxDecrypt(ciphertext, nonce, sender.publicKey, wrong.secretKey);
    expect(decrypted).toBeNull();
  });

  it('ciphertext differs from plaintext', () => {
    const sender = generateEphemeralKeyPair();
    const recipient = generateEphemeralKeyPair();
    const plaintext = decodeUTF8('secret');
    const { ciphertext } = boxEncrypt(plaintext, recipient.publicKey, sender.secretKey);
    expect(ciphertext).not.toEqual(plaintext);
  });
});

describe('Key Exchange', () => {
  it('both parties derive the same shared secret', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();

    const secretAlice = deriveSharedSecret(alice.secretKey, bob.publicKey);
    const secretBob = deriveSharedSecret(bob.secretKey, alice.publicKey);

    expect(secretAlice).toEqual(secretBob);
    expect(secretAlice.length).toBe(32);
  });

  it('different pairs produce different secrets', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const c = generateEphemeralKeyPair();

    const ab = deriveSharedSecret(a.secretKey, b.publicKey);
    const ac = deriveSharedSecret(a.secretKey, c.publicKey);

    expect(ab).not.toEqual(ac);
  });
});

describe('SecretBox Encryption', () => {
  it('encrypt + decrypt round-trip', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const key = deriveSharedSecret(alice.secretKey, bob.publicKey);

    const plaintext = decodeUTF8('channel message');
    const { nonce, ciphertext } = secretboxEncrypt(plaintext, key);

    const decrypted = secretboxDecrypt(ciphertext, nonce, key);
    expect(decrypted).not.toBeNull();
    expect(encodeUTF8(decrypted!)).toBe('channel message');
  });

  it('fails with wrong key', () => {
    const key = deriveSharedSecret(
      generateEphemeralKeyPair().secretKey,
      generateEphemeralKeyPair().publicKey,
    );
    const wrongKey = deriveSharedSecret(
      generateEphemeralKeyPair().secretKey,
      generateEphemeralKeyPair().publicKey,
    );

    const { nonce, ciphertext } = secretboxEncrypt(decodeUTF8('test'), key);
    expect(secretboxDecrypt(ciphertext, nonce, wrongKey)).toBeNull();
  });
});

describe('Identity Export/Import', () => {
  it('round-trips with correct password', () => {
    const original = generateIdentity();
    const exported = exportIdentity(original, 'mypassword123');
    const imported = importIdentity(exported, 'mypassword123');

    expect(imported.did).toBe(original.did);
    expect(imported.publicKey).toEqual(original.publicKey);
    expect(imported.secretKey).toEqual(original.secretKey);
  });

  it('fails with wrong password', () => {
    const original = generateIdentity();
    const exported = exportIdentity(original, 'correct');
    expect(() => importIdentity(exported, 'wrong')).toThrow();
  });

  it('exported data is not plaintext', () => {
    const original = generateIdentity();
    const exported = exportIdentity(original, 'pass');
    expect(exported).not.toContain(original.did);
  });
});
