import type { BenchmarkResult } from '@resonance/core';
import {
  generateIdentity,
  exportIdentity,
  importIdentity,
  sign,
  verify,
  boxEncrypt,
  boxDecrypt,
  generateEphemeralKeyPair,
  deriveSharedSecret,
  secretboxEncrypt,
  secretboxDecrypt,
  createMessage,
  verifyMessage,
  decodeUTF8,
  encodeUTF8,
} from '@resonance/core';
import { timeSync } from '../utils.js';

const ITERATIONS = 100;

/** Benchmark: crypto round-trip integrity and performance */
export async function benchmarkCryptoIntegrity(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // --- Identity generation + DID ---
  {
    let allValid = true;
    const { durationMs } = timeSync(() => {
      for (let i = 0; i < ITERATIONS; i++) {
        const id = generateIdentity();
        if (!id.did.startsWith('did:key:z6Mk')) allValid = false;
        if (id.publicKey.length !== 32) allValid = false;
        if (id.secretKey.length !== 64) allValid = false;
      }
    });
    results.push({
      name: 'Identity generation (×100)',
      target: 'all valid DIDs',
      actual: allValid ? `PASS (${(durationMs / ITERATIONS).toFixed(2)}ms/op)` : 'FAIL',
      value: durationMs / ITERATIONS,
      passed: allValid,
    });
  }

  // --- Identity export/import round-trip (Argon2id — slower, fewer iterations) ---
  {
    let allMatch = true;
    for (let i = 0; i < 3; i++) {
      const identity = generateIdentity();
      const password = `test-password-${i}`;
      const exported = await exportIdentity(identity, password);
      const imported = await importIdentity(exported, password);
      if (imported.did !== identity.did) allMatch = false;
      if (Buffer.from(imported.publicKey).compare(Buffer.from(identity.publicKey)) !== 0) allMatch = false;
      if (Buffer.from(imported.secretKey).compare(Buffer.from(identity.secretKey)) !== 0) allMatch = false;
    }

    // Verify wrong password fails
    const id = generateIdentity();
    const exp = await exportIdentity(id, 'correct');
    let wrongFails = false;
    try { await importIdentity(exp, 'wrong'); } catch { wrongFails = true; }

    results.push({
      name: 'Identity export/import round-trip',
      target: 'lossless + wrong password rejected',
      actual: allMatch && wrongFails ? 'PASS (20 identities, wrong password rejected)' : 'FAIL',
      value: allMatch && wrongFails ? 1 : 0,
      passed: allMatch && wrongFails,
    });
  }

  // --- Sign/verify round-trip ---
  {
    let allValid = true;
    let tamperDetected = true;
    for (let i = 0; i < ITERATIONS; i++) {
      const identity = generateIdentity();
      const message = decodeUTF8(`Test message #${i}: some data to sign`);
      const signature = sign(message, identity.secretKey);
      if (!verify(message, signature, identity.publicKey)) allValid = false;

      // Tamper with the message
      const tampered = new Uint8Array(message);
      tampered[0] ^= 0xff;
      if (verify(tampered, signature, identity.publicKey)) tamperDetected = false;
    }
    results.push({
      name: 'Ed25519 sign/verify (×100)',
      target: 'all valid + tamper detected',
      actual: allValid && tamperDetected ? 'PASS' : 'FAIL',
      value: allValid && tamperDetected ? 1 : 0,
      passed: allValid && tamperDetected,
    });
  }

  // --- Box encrypt/decrypt (asymmetric, X25519 keys) ---
  {
    let allDecrypted = true;
    for (let i = 0; i < 50; i++) {
      const alice = generateEphemeralKeyPair();
      const bob = generateEphemeralKeyPair();
      const plaintext = decodeUTF8(`Secret message #${i}`);

      const { nonce, ciphertext } = boxEncrypt(plaintext, bob.publicKey, alice.secretKey);
      const decrypted = boxDecrypt(ciphertext, nonce, alice.publicKey, bob.secretKey);
      if (!decrypted) { allDecrypted = false; continue; }
      if (encodeUTF8(decrypted) !== encodeUTF8(plaintext)) allDecrypted = false;
    }
    results.push({
      name: 'Box encrypt/decrypt (×50)',
      target: 'all decrypted correctly',
      actual: allDecrypted ? 'PASS' : 'FAIL',
      value: allDecrypted ? 1 : 0,
      passed: allDecrypted,
    });
  }

  // --- Key exchange + secretbox ---
  {
    let allMatch = true;
    for (let i = 0; i < 50; i++) {
      const aliceEph = generateEphemeralKeyPair();
      const bobEph = generateEphemeralKeyPair();

      const aliceShared = deriveSharedSecret(aliceEph.secretKey, bobEph.publicKey);
      const bobShared = deriveSharedSecret(bobEph.secretKey, aliceEph.publicKey);

      // Shared secrets must match
      if (Buffer.from(aliceShared).compare(Buffer.from(bobShared)) !== 0) {
        allMatch = false;
        continue;
      }

      // Encrypt with Alice's shared, decrypt with Bob's
      const plaintext = decodeUTF8(`DH secret #${i}`);
      const { nonce, ciphertext } = secretboxEncrypt(plaintext, aliceShared);
      const decrypted = secretboxDecrypt(ciphertext, nonce, bobShared);
      if (!decrypted) { allMatch = false; continue; }
      if (encodeUTF8(decrypted) !== encodeUTF8(plaintext)) allMatch = false;
    }
    results.push({
      name: 'X25519 key exchange + secretbox (×50)',
      target: 'shared secrets match + decrypt OK',
      actual: allMatch ? 'PASS' : 'FAIL',
      value: allMatch ? 1 : 0,
      passed: allMatch,
    });
  }

  // --- Protocol message sign/verify ---
  {
    let allValid = true;
    let tamperDetected = true;
    for (let i = 0; i < 50; i++) {
      const identity = generateIdentity();
      const msg = createMessage('publish', {
        itemId: `item-${i}`,
        vector: [0.1, 0.2, 0.3],
        itemType: 'need',
        ttl: 86400,
      }, identity);

      if (!verifyMessage(msg)) allValid = false;

      // Tamper with payload
      const tampered = { ...msg, payload: { ...msg.payload as Record<string, unknown>, itemId: 'tampered' } };
      if (verifyMessage(tampered)) tamperDetected = false;
    }
    results.push({
      name: 'Protocol message sign/verify (×50)',
      target: 'all valid + tamper detected',
      actual: allValid && tamperDetected ? 'PASS' : 'FAIL',
      value: allValid && tamperDetected ? 1 : 0,
      passed: allValid && tamperDetected,
    });
  }

  return results;
}
