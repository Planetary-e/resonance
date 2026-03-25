/**
 * Cryptographic primitives for Resonance identity and encryption.
 *
 * - Ed25519 keypairs for DID identity and message signing
 * - X25519 Diffie-Hellman for ephemeral key exchange
 * - XSalsa20-Poly1305 (box/secretbox) for encryption
 * - did:key method for decentralized identifiers
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

// --- Base58 encoding (for did:key) ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zeros
  let output = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    output += BASE58_ALPHABET[digits[i]];
  }
  return output;
}

function decodeBase58(str: string): Uint8Array {
  const bytes = [0];
  for (const char of str) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading ones = leading zeros
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// --- DID:key multicodec prefix for ed25519-pub ---
// 0xed01 = ed25519 public key multicodec
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

// --- Identity ---

export interface Identity {
  /** Ed25519 public key (32 bytes) */
  publicKey: Uint8Array;
  /** Ed25519 secret key (64 bytes — includes public key) */
  secretKey: Uint8Array;
  /** DID string: did:key:z6Mk... */
  did: string;
}

/** Generate a new ed25519 identity (keypair + DID). */
export function generateIdentity(): Identity {
  const keyPair = nacl.sign.keyPair();
  const did = publicKeyToDid(keyPair.publicKey);
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    did,
  };
}

/** Convert an ed25519 public key to a did:key string. */
export function publicKeyToDid(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${encodeBase58(prefixed)}`;
}

/** Extract the ed25519 public key from a did:key string. */
export function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error(`Invalid did:key format: ${did}`);
  }
  const decoded = decodeBase58(did.slice('did:key:z'.length));
  // Verify multicodec prefix
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error('Invalid multicodec prefix for ed25519');
  }
  return decoded.slice(2);
}

// --- Signing ---

/** Sign a message with an ed25519 secret key. Returns the 64-byte signature. */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

/** Verify an ed25519 signature. */
export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// --- Box Encryption (asymmetric, for consent messages) ---

export interface BoxResult {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Encrypt a message for a recipient using public-key authenticated encryption.
 * Uses X25519 + XSalsa20-Poly1305 (nacl.box).
 *
 * Note: tweetnacl.box expects X25519 keys, but ed25519 sign keys can be
 * converted. We use nacl.box.keyPair() for encryption keys separately.
 */
export function boxEncrypt(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): BoxResult {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(message, nonce, recipientPublicKey, senderSecretKey);
  if (!ciphertext) throw new Error('Encryption failed');
  return { nonce, ciphertext };
}

/** Decrypt a box-encrypted message. Returns null if decryption fails. */
export function boxDecrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  return nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
}

// --- Key Exchange (for direct channels) ---

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generate an ephemeral X25519 keypair for Diffie-Hellman key exchange. */
export function generateEphemeralKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

/** Derive a shared secret from X25519 DH. Both parties get the same key. */
export function deriveSharedSecret(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(theirPublicKey, mySecretKey);
}

// --- Symmetric Encryption (for direct channel stream) ---

export interface SecretBoxResult {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** Encrypt with a shared symmetric key (XSalsa20-Poly1305). */
export function secretboxEncrypt(message: Uint8Array, key: Uint8Array): SecretBoxResult {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(message, nonce, key);
  if (!ciphertext) throw new Error('Encryption failed');
  return { nonce, ciphertext };
}

/** Decrypt with a shared symmetric key. Returns null if decryption fails. */
export function secretboxDecrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array | null {
  return nacl.secretbox.open(ciphertext, nonce, key);
}

// --- Key Export/Import ---

/** Export an identity encrypted with a password. */
export function exportIdentity(identity: Identity, password: string): string {
  const passwordBytes = decodeUTF8(password);
  // Derive a key from the password using a simple hash (for pilot; use scrypt/argon2 in production)
  const key = nacl.hash(passwordBytes).slice(0, nacl.secretbox.keyLength);
  const data = decodeUTF8(JSON.stringify({
    publicKey: encodeBase64(identity.publicKey),
    secretKey: encodeBase64(identity.secretKey),
    did: identity.did,
  }));
  const { nonce, ciphertext } = secretboxEncrypt(data, key);
  return JSON.stringify({
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  });
}

/** Import an identity from an encrypted export. */
export function importIdentity(encrypted: string, password: string): Identity {
  const passwordBytes = decodeUTF8(password);
  const key = nacl.hash(passwordBytes).slice(0, nacl.secretbox.keyLength);
  const { nonce, ciphertext } = JSON.parse(encrypted);
  const decrypted = secretboxDecrypt(decodeBase64(ciphertext), decodeBase64(nonce), key);
  if (!decrypted) throw new Error('Decryption failed — wrong password?');
  const data = JSON.parse(encodeUTF8(decrypted));
  return {
    publicKey: decodeBase64(data.publicKey),
    secretKey: decodeBase64(data.secretKey),
    did: data.did,
  };
}

// --- Encoding helpers (re-exported for protocol use) ---

export { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };
