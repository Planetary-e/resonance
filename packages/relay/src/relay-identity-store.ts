/** Durable storage for the relay's infrastructure identity.
 *
 * This store deliberately has no dependency on the personal node identity or
 * its encrypted store. A relay installation generates and owns this key.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  opendirSync,
  realpathSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
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
export const RELAY_IDENTITY_MAX_BYTES = 4096;

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

/** Load one stable relay identity under single-host process ownership. */
export function loadOrCreateRelayIdentity(directory: string, passphrase?: string): Identity {
  if (passphrase !== undefined && (typeof passphrase !== 'string' || passphrase.length < 16)) {
    throw new Error('Relay identity passphrase must contain at least 16 characters');
  }
  const reservation = reserveManagedStorage({ path: join(directory, RELAY_IDENTITY_FILENAME), component: 'relay-identity',
    scope: 'file', maximumBytes: 2 * RELAY_IDENTITY_MAX_BYTES + 8192 });
  reservation?.assertWritable();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  directory = realpathSync(directory);
  const path = join(directory, RELAY_IDENTITY_FILENAME), pending = pendingPath(directory);
  const unlock = acquireLocalStateLock(path, reservation);
  let retained: Identity | undefined;
  try {
    // Older versions used random temporary names. Never silently ignore a key
    // left there: selecting among those artifacts needs explicit inspection.
    const entries = opendirSync(directory);
    try {
      let count = 0;
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++count > 4096) throw new Error('Relay identity directory exceeds its inspection bound');
        if (entry.name.startsWith(`.${RELAY_IDENTITY_FILENAME}.`) && entry.name.endsWith('.tmp')) {
          throw new Error('Interrupted legacy relay identity write; preserve temporary keys for inspection');
        }
      }
    } finally { entries.closeSync(); }
    const existing = readIfPresent(path, passphrase); retained = existing?.identity;
    const candidate = readIfPresent(pending, passphrase);
    if (candidate) {
      try {
        if (existing && (!equalBytes(existing.identity.secretKey, candidate.identity.secretKey)
          || existing.identity.did !== candidate.identity.did)) throw invalidIdentity('pending key differs from retained identity');
        if ((existing?.encrypted || passphrase) && !candidate.encrypted) throw invalidIdentity('pending key would downgrade encryption');
        // A readable candidate may have survived an interrupted fsync. Flush it
        // and its name before atomic publication, then flush the new name.
        reservation?.assertWritable(); flushFile(pending); fsyncDirectory(directory);
        renameSync(pending, path); fsyncDirectory(directory);
        retained?.secretKey.fill(0); retained = candidate.identity;
      } catch (error) { candidate.identity.secretKey.fill(0); throw error; }
    } else if (existing) {
      if (existing.legacy || (passphrase && !existing.encrypted)) {
        writeTemporaryIdentity(directory, existing.identity, passphrase);
        reservation?.assertWritable(); renameSync(pending, path); fsyncDirectory(directory);
      }
    } else {
      retained = generateIdentity();
      writeTemporaryIdentity(directory, retained, passphrase);
      reservation?.assertWritable(); renameSync(pending, path); fsyncDirectory(directory);
    }
    unlock(); const result = retained!; retained = undefined; return result;
  } finally { retained?.secretKey.fill(0); unlock(); }
}

const pendingPath = (directory: string) => join(directory, `.${RELAY_IDENTITY_FILENAME}.pending`);
function readIfPresent(path: string, passphrase?: string): ReadIdentityResult | undefined {
  // lstat distinguishes absence from a dangling symlink; read/parse failures
  // never become permission to generate or replace an identity.
  try { lstatSync(path); } catch (error) { if (isMissing(error)) return; throw error; }
  return readIdentity(path, passphrase);
}
function flushFile(path: string) {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Read an independently retained encrypted identity. Never create, migrate or chmod it. */
export function loadExistingRelayIdentity(directory: string, passphrase: string): Identity {
  const existing = readIdentity(join(directory, RELAY_IDENTITY_FILENAME), passphrase, true);
  if (!existing.encrypted) {
    existing.identity.secretKey.fill(0);
    throw new Error('Operator infrastructure identity must already be encrypted');
  }
  return existing.identity;
}

function readIdentity(path: string, passphrase?: string, readonly = false): ReadIdentityResult {
  let descriptor: number;
  const observed = lstatSync(path);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1) throw invalidIdentity('expected a regular file with a single link');
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new Error('Relay infrastructure identity must be a regular file', { cause: error });
  }

  let source: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== observed.dev || stat.ino !== observed.ino || stat.size > RELAY_IDENTITY_MAX_BYTES) {
      throw new Error('Relay infrastructure identity must be a regular file');
    }
    if (!readonly) fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor);
    const bytes = Buffer.alloc(RELAY_IDENTITY_MAX_BYTES + 1);
    try {
      let used = 0;
      while (used < bytes.length) { const count = readSync(descriptor, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
      if (used > RELAY_IDENTITY_MAX_BYTES) throw new Error('Relay infrastructure identity exceeds its size limit');
      const after = fstatSync(descriptor), named = lstatSync(path);
      if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) throw invalidIdentity('file changed while reading');
      source = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, used));
    } finally { bytes.fill(0); }
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
      secretKey.fill(0); throw invalidIdentity('non-canonical base64 key material');
    }
    const identity = { publicKey, secretKey, did: parsed.did };
    try { validateIdentity(identity); return { identity, legacy: false, encrypted }; }
    catch (error) { identity.secretKey.fill(0); throw error; }
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
    try { validateIdentity(identity); return { identity, legacy: true, encrypted }; }
    catch (error) { identity.secretKey.fill(0); throw error; }
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

function writeTemporaryIdentity(directory: string, identity: Identity, passphrase?: string): void {
  const path = pendingPath(directory);
  const stored = passphrase
    ? encryptIdentity(serializeIdentity(identity), passphrase)
    : serializeIdentity(identity);
  const encoded = Buffer.from(`${JSON.stringify(stored)}\n`);
  if (encoded.length > RELAY_IDENTITY_MAX_BYTES) { encoded.fill(0); throw new Error('Relay infrastructure identity exceeds its size limit'); }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    let offset = 0;
    while (offset < encoded.length) {
      const written = writeSync(descriptor, encoded, offset, encoded.length - offset);
      if (written <= 0) throw new Error('Relay identity write made no progress'); offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    encoded.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(directory);
}

function encryptIdentity(identity: StoredRelayIdentityV1, passphrase: string): EncryptedRelayIdentityV2 {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(IDENTITY_AAD);
    const plaintext = Buffer.from(JSON.stringify(identity));
    let ciphertext: Buffer;
    try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); } finally { plaintext.fill(0); }
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
  let partial: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
    decipher.setAAD(IDENTITY_AAD);
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    partial = decipher.update(Buffer.from(value.ciphertext, 'base64'));
    plaintext = Buffer.concat([partial, decipher.final()]);
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext)) as unknown;
  } catch { throw invalidIdentity('wrong passphrase or corrupt encrypted keystore'); }
  finally { partial?.fill(0); plaintext?.fill(0); key.fill(0); }
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

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
