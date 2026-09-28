/** Durable storage for the relay's infrastructure identity.
 *
 * This store deliberately has no dependency on the personal node identity or
 * its encrypted store. A relay installation generates and owns this key.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  decodeBase64,
  encodeBase64,
  generateIdentity,
  publicKeyToDid,
  sign,
  verify,
  type Identity,
} from '@resonance/core';

export const RELAY_IDENTITY_FILENAME = 'relay-identity.json';

interface StoredRelayIdentityV1 {
  version: 1;
  kind: 'relay-infrastructure-identity';
  algorithm: 'Ed25519';
  did: string;
  publicKey: string;
  secretKey: string;
}

interface ReadIdentityResult {
  identity: Identity;
  legacy: boolean;
  encrypted: boolean;
}

interface EncryptedRelayIdentityV2 {
  version: 2;
  kind: 'relay-infrastructure-identity-encrypted';
  algorithm: 'scrypt-aes-256-gcm';
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const PROOF = new TextEncoder().encode('resonance/relay-infrastructure-identity/v1');
const V1_FIELDS = ['algorithm', 'did', 'kind', 'publicKey', 'secretKey', 'version'];
const LEGACY_FIELDS = ['did', 'publicKey', 'secretKey'];
const ENCRYPTED_FIELDS = ['algorithm', 'ciphertext', 'kind', 'nonce', 'salt', 'tag', 'version'];
const IDENTITY_AAD = Buffer.from('resonance/relay-infrastructure-identity/encrypted/v2');

/** Load one stable relay identity, or create it once with mode 0600. */
export function loadOrCreateRelayIdentity(directory: string, passphrase?: string): Identity {
  if (passphrase !== undefined && (typeof passphrase !== 'string' || passphrase.length < 16)) {
    throw new Error('Relay identity passphrase must contain at least 16 characters');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, RELAY_IDENTITY_FILENAME);

  try {
    const existing = readIdentity(path, passphrase);
    if (existing.legacy || (passphrase && !existing.encrypted)) {
      replaceIdentityFile(directory, path, existing.identity, passphrase);
    }
    return existing.identity;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const generated = generateIdentity();
  const tempPath = writeTemporaryIdentity(directory, generated, passphrase);
  try {
    // A hard link publishes the complete fsynced file without overwriting an
    // identity concurrently created by another relay process.
    linkSync(tempPath, path);
    fsyncDirectory(directory);
    unlinkSync(tempPath);
    fsyncDirectory(directory);
    chmodSync(path, 0o600);
    return generated;
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best-effort temporary cleanup */ }
    if (isAlreadyExists(error)) return readIdentity(path, passphrase).identity;
    throw error;
  }
}

function readIdentity(path: string, passphrase?: string): ReadIdentityResult {
  let descriptor: number;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new Error('Relay infrastructure identity must be a regular file', { cause: error });
  }

  let source: string;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('Relay infrastructure identity must be a regular file');
    }
    fchmodSync(descriptor, 0o600);
    source = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }

  let parsed: unknown;
  let encrypted = false;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error('Corrupt relay infrastructure identity JSON; refusing to rotate it', { cause: error });
  }

  if (isRecord(parsed) && parsed.kind === 'relay-infrastructure-identity-encrypted') {
    if (!passphrase) throw invalidIdentity('passphrase required for encrypted keystore');
    parsed = decryptIdentity(parsed, passphrase);
    encrypted = true;
  }

  if (isRecord(parsed) && hasExactFields(parsed, V1_FIELDS)) {
    if (parsed.version !== 1
      || parsed.kind !== 'relay-infrastructure-identity'
      || parsed.algorithm !== 'Ed25519'
      || typeof parsed.did !== 'string'
      || typeof parsed.publicKey !== 'string'
      || typeof parsed.secretKey !== 'string') {
      throw invalidIdentity('unsupported schema');
    }
    let publicKey: Uint8Array;
    let secretKey: Uint8Array;
    try {
      publicKey = decodeBase64(parsed.publicKey);
      secretKey = decodeBase64(parsed.secretKey);
    } catch {
      throw invalidIdentity('invalid base64 key material');
    }
    if (encodeBase64(publicKey) !== parsed.publicKey || encodeBase64(secretKey) !== parsed.secretKey) {
      throw invalidIdentity('non-canonical base64 key material');
    }
    const identity = { publicKey, secretKey, did: parsed.did };
    validateIdentity(identity);
    return { identity, legacy: false, encrypted };
  }

  // The pre-v2 development build stored number arrays. Migrate only an exact,
  // cryptographically valid instance so corruption never causes key rotation.
  if (isRecord(parsed) && hasExactFields(parsed, LEGACY_FIELDS)
    && typeof parsed.did === 'string'
    && isByteArray(parsed.publicKey, 32)
    && isByteArray(parsed.secretKey, 64)) {
    const identity = {
      publicKey: Uint8Array.from(parsed.publicKey),
      secretKey: Uint8Array.from(parsed.secretKey),
      did: parsed.did,
    };
    validateIdentity(identity);
    return { identity, legacy: true, encrypted };
  }

  throw invalidIdentity('unexpected schema');
}

function validateIdentity(identity: Identity): void {
  if (identity.publicKey.length !== 32 || identity.secretKey.length !== 64) {
    throw invalidIdentity('invalid Ed25519 key length');
  }
  if (!equalBytes(identity.secretKey.subarray(32), identity.publicKey)) {
    throw invalidIdentity('public and secret key mismatch');
  }
  if (publicKeyToDid(identity.publicKey) !== identity.did) {
    throw invalidIdentity('DID does not match public key');
  }
  if (!verify(PROOF, sign(PROOF, identity.secretKey), identity.publicKey)) {
    throw invalidIdentity('keypair verification failed');
  }
}

function replaceIdentityFile(directory: string, path: string, identity: Identity, passphrase?: string): void {
  const tempPath = writeTemporaryIdentity(directory, identity, passphrase);
  try {
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best-effort temporary cleanup */ }
    throw error;
  }
}

function writeTemporaryIdentity(directory: string, identity: Identity, passphrase?: string): string {
  const suffix = randomBytes(12).toString('hex');
  const path = join(directory, `.${RELAY_IDENTITY_FILENAME}.${process.pid}.${suffix}.tmp`);
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    const stored = passphrase
      ? encryptIdentity(serializeIdentity(identity), passphrase)
      : serializeIdentity(identity);
    writeFileSync(descriptor, `${JSON.stringify(stored)}\n`, 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    try { unlinkSync(path); } catch { /* best-effort temporary cleanup */ }
    throw error;
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function encryptIdentity(identity: StoredRelayIdentityV1, passphrase: string): EncryptedRelayIdentityV2 {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(IDENTITY_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(identity), 'utf8'), cipher.final()]);
    return {
      version: 2, kind: 'relay-infrastructure-identity-encrypted',
      algorithm: 'scrypt-aes-256-gcm', salt: salt.toString('base64'), nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    };
  } finally { key.fill(0); }
}

function decryptIdentity(value: Record<string, unknown>, passphrase: string): unknown {
  if (!hasExactFields(value, ENCRYPTED_FIELDS)
    || value.version !== 2 || value.algorithm !== 'scrypt-aes-256-gcm'
    || !canonicalBytes(value.salt, 16) || !canonicalBytes(value.nonce, 12)
    || !canonicalBytes(value.tag, 16) || !canonicalBytes(value.ciphertext)
    || value.ciphertext.length > 4096) throw invalidIdentity('invalid encrypted keystore schema');
  const key = scryptSync(passphrase, Buffer.from(value.salt, 'base64'), 32,
    { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
    decipher.setAAD(IDENTITY_AAD);
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch { throw invalidIdentity('wrong passphrase or corrupt encrypted keystore'); }
  finally { key.fill(0); }
}

function canonicalBytes(value: unknown, length?: number): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const bytes = Buffer.from(value, 'base64');
  return (length === undefined || bytes.length === length)
    && bytes.toString('base64') === value;
}

function serializeIdentity(identity: Identity): StoredRelayIdentityV1 {
  return {
    version: 1,
    kind: 'relay-infrastructure-identity',
    algorithm: 'Ed25519',
    did: identity.did,
    publicKey: encodeBase64(identity.publicKey),
    secretKey: encodeBase64(identity.secretKey),
  };
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function invalidIdentity(reason: string): Error {
  return new Error(`Invalid relay infrastructure identity (${reason}); refusing to rotate it`);
}

function hasExactFields(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isByteArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

function isMissing(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, 'EEXIST');
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
