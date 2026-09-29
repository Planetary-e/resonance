/** Encrypted, crash-safe local reservations for manually issued admission tokens. */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  type AdmissionCapabilityV2, type BlindAdmissionScopeV2,
  type RelayAdmissionActionV2, assertSecureRelayTransportEndpoint,
  createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2,
} from '@resonance/core';
import type { AdmissionCapabilityRequestContextV2 } from './relay-client.js';

interface Reservation {
  relayUrl: string;
  action: RelayAdmissionActionV2;
  binding: string;
}
interface WalletEntry { token: string; reservation?: Reservation }
interface WalletState { version: 1; scope: BlindAdmissionScopeV2; entries: WalletEntry[] }
interface EncryptedWallet { version: 1; nonce: string; ciphertext: string; tag: string }

const MAX_TOKENS = 256;
const MAX_FILE_BYTES = 512 * 1024;
const AAD = Buffer.from('resonance:blind-admission-wallet:v1');

export interface BlindAdmissionWalletV2 {
  /** Import already issued tokens after checking their issuer signature and scope. */
  importTokens(tokens: readonly string[]): Promise<number>;
  /** Reserve before network I/O; exact retries reuse the same token. */
  capabilityFor(context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2;
  available(): number;
  close(): void;
}

/** One process owns this file at a time. A crash leaves a lock requiring recovery. */
export function openBlindAdmissionWalletV2(options: {
  path: string;
  encryptionKey: Uint8Array;
  issuerPublicKey: CryptoKey;
  scope: BlindAdmissionScopeV2;
}): BlindAdmissionWalletV2 {
  if (options.encryptionKey.length !== 32) throw new Error('Admission wallet key must be 32 bytes');
  const key = Buffer.from(options.encryptionKey);
  const directory = dirname(options.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${options.path}.lock`;
  const owner = randomBytes(16).toString('hex');
  let lockFd: number;
  try { lockFd = openSync(lockPath, 'wx', 0o600); }
  catch { key.fill(0); throw new Error('Admission wallet is already open or needs lock recovery'); }
  try {
    writeAll(lockFd, Buffer.from(`${owner}\n`));
    fsyncSync(lockFd);
    closeSync(lockFd);
    fsyncDirectory(directory);
  } catch (error) {
    try { closeSync(lockFd); } catch { /* it may already be closed */ }
    try { rmSync(lockPath); } catch { /* preserve the original error */ }
    key.fill(0);
    throw error;
  }
  let closed = false;
  let poisoned = false;
  let importing = false;
  let state: WalletState;
  try {
    state = existsSync(options.path)
      ? decryptWallet(readFileSync(options.path), key, options.scope)
      : { version: 1, scope: options.scope, entries: [] };
    if (!existsSync(options.path)) persistWallet(options.path, key, state);
  } catch (error) {
    removeOwnedLock();
    key.fill(0);
    throw error;
  }

  return {
    async importTokens(tokens) {
      ensureOpen();
      importing = true;
      try {
        const unique = [...new Set(tokens)].filter(token => !state.entries.some(entry => entry.token === token));
        if (tokens.length > MAX_TOKENS || state.entries.length + unique.length > MAX_TOKENS) {
          throw new Error('Admission wallet capacity exceeded');
        }
        const importBinding = createAdmissionRequestBindingV2('search', { kind: 'wallet-import' });
        for (const token of unique) {
          const proof = presentBlindAdmissionTokenV2(token, options.scope, 'search', importBinding);
          if (!await verifyBlindAdmissionTokenV2(
            proof, options.scope, 'search', importBinding, options.issuerPublicKey,
          )) throw new Error('Admission wallet token has an invalid issuer signature or scope');
        }
        if (unique.length === 0) return 0;
        const next = { ...state, entries: [...state.entries, ...unique.map(token => ({ token }))] };
        writeState(next);
        state = next;
        return unique.length;
      } finally { importing = false; }
    },
    capabilityFor(context) {
      ensureOpen();
      validateContext(context);
      const reservation: Reservation = {
        relayUrl: context.relayUrl, action: context.action, binding: context.requestBinding,
      };
      const previous = state.entries.find(entry => sameReservation(entry.reservation, reservation));
      if (previous) return presentBlindAdmissionTokenV2(
        previous.token, options.scope, context.action, context.requestBinding,
      );
      const freeIndex = state.entries.findIndex(entry => !entry.reservation);
      if (freeIndex < 0) throw new Error('Admission wallet has no unreserved tokens');
      const entries = state.entries.map((entry, index) =>
        index === freeIndex ? { ...entry, reservation } : entry);
      const next = { ...state, entries };
      writeState(next);
      state = next;
      return presentBlindAdmissionTokenV2(
        entries[freeIndex].token, options.scope, context.action, context.requestBinding,
      );
    },
    available() { ensureOpen(); return state.entries.filter(entry => !entry.reservation).length; },
    close() {
      if (closed) return;
      if (importing) throw new Error('Admission wallet import is in progress');
      closed = true;
      key.fill(0);
      removeOwnedLock();
    },
  };

  function ensureOpen(): void {
    if (closed) throw new Error('Admission wallet is closed');
    if (poisoned) throw new Error('Admission wallet write failed; close and reopen before reuse');
    if (importing) throw new Error('Admission wallet import is in progress');
  }
  function writeState(next: WalletState): void {
    try { persistWallet(options.path, key, next); }
    catch (error) { poisoned = true; throw error; }
  }
  function removeOwnedLock(): void {
    try {
      if (readFileSync(lockPath, 'utf8') === `${owner}\n`) {
        rmSync(lockPath);
        fsyncDirectory(directory);
      }
    } catch { /* a missing lock is already closed */ }
  }
}

function sameReservation(first: Reservation | undefined, second: Reservation): boolean {
  return first?.relayUrl === second.relayUrl
    && first.action === second.action && first.binding === second.binding;
}

function validateContext(context: AdmissionCapabilityRequestContextV2): void {
  assertSecureRelayTransportEndpoint(context.relayUrl);
  if (context.relayUrl.length > 512
    || !['publication-write', 'search', 'mailbox-fetch', 'mailbox-acknowledge', 'mailbox-deposit'].includes(context.action)
    || !/^admreq_[A-Za-z0-9_-]{86}$/.test(context.requestBinding)) {
    throw new Error('Invalid admission wallet reservation');
  }
}

function persistWallet(path: string, key: Buffer, state: WalletState): void {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(state));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  const record: EncryptedWallet = {
    version: 1, nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'),
  };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Admission wallet exceeds file capacity');
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function decryptWallet(bytes: Buffer, key: Buffer, expectedScope: BlindAdmissionScopeV2): WalletState {
  if (bytes.length > MAX_FILE_BYTES || bytes.length < 1) throw new Error('Admission wallet file is invalid');
  let record: EncryptedWallet;
  try { record = JSON.parse(bytes.toString('utf8')) as EncryptedWallet; }
  catch { throw new Error('Admission wallet file is corrupt'); }
  if (!record || record.version !== 1 || !exactKeys(record, ['ciphertext', 'nonce', 'tag', 'version'])
    || typeof record.nonce !== 'string' || typeof record.ciphertext !== 'string'
    || typeof record.tag !== 'string') throw new Error('Admission wallet file is corrupt');
  let state: unknown;
  try {
    const nonce = Buffer.from(record.nonce, 'base64url');
    const tag = Buffer.from(record.tag, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid nonce or tag');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final(),
    ]);
    state = JSON.parse(plaintext.toString('utf8'));
    plaintext.fill(0);
  } catch { throw new Error('Admission wallet cannot be decrypted'); }
  if (!validState(state, expectedScope)) throw new Error('Admission wallet state is invalid');
  return state;
}

function validState(value: unknown, scope: BlindAdmissionScopeV2): value is WalletState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!exactKeys(state, ['entries', 'scope', 'version']) || state.version !== 1
    || !state.scope || typeof state.scope !== 'object' || Array.isArray(state.scope)
    || !exactKeys(state.scope, ['community', 'epoch', 'issuer'])) return false;
  const stored = state.scope as Record<string, unknown>;
  if (stored.issuer !== scope.issuer || stored.community !== scope.community
    || stored.epoch !== scope.epoch || !Array.isArray(state.entries)
    || state.entries.length > MAX_TOKENS) return false;
  const seen = new Set<string>();
  for (const item of state.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    if (!exactKeys(entry, entry.reservation === undefined ? ['token'] : ['reservation', 'token'])
      || typeof entry.token !== 'string' || !/^[A-Za-z0-9_-]{472}$/.test(entry.token)
      || seen.has(entry.token)) return false;
    seen.add(entry.token);
    if (entry.reservation !== undefined) {
      if (!entry.reservation || typeof entry.reservation !== 'object'
        || Array.isArray(entry.reservation)
        || !exactKeys(entry.reservation, ['action', 'binding', 'relayUrl'])) return false;
      const reservation = entry.reservation as Record<string, unknown>;
      try {
        validateContext({
          relayUrl: reservation.relayUrl, action: reservation.action,
          requestBinding: reservation.binding,
        } as AdmissionCapabilityRequestContextV2);
      } catch { return false; }
    }
  }
  return true;
}

function exactKeys(value: object, wanted: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...wanted].sort().join(',');
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Admission wallet write failed');
    offset += written;
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
