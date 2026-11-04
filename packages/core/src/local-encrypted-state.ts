/** Bounded encrypted snapshots with one writer and atomic, flushed replacement. */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeSync, realpathSync, lstatSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { reserveManagedStorage, assertExistingStorageReservation, currentStorageReservationAuthorityId, captureStorageReservationOperation, type StorageReservationLease } from './storage-reservation-context.js';
import { acquireLocalDirectoryOwnership } from './local-state-owner.js';
export { inspectLocalStateOwnership, isLocalStateOwnershipName } from './local-state-owner.js';

/** Bind aliases of existing parents to the same actual local resource. */
export function canonicalLocalStatePath(path: string): string {
  let current = resolve(path); const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Local state path has no existing parent');
    missing.unshift(basename(current)); current = parent;
  }
  return join(realpathSync(current), ...missing);
}
/** Conservative ciphertext-wrapper bound, including authenticated funding metadata. */
export function encryptedLocalStateByteBound(value: unknown, additionalPlaintextBytes = 0): number {
  return Math.ceil((Buffer.byteLength(JSON.stringify(value)) + additionalPlaintextBytes) * 4 / 3) + 8192;
}
export function openEncryptedLocalState<T>(options: {
  path: string; key: Uint8Array; domain: string; maxBytes: number;
  initial: T; validate(value: unknown): value is T;
  mode?: 'create-new' | 'open-existing';
  funding?: 'monotone-v1';
  /** Explicit, strict legacy decoder. Reading does not migrate; the next write atomically replaces the same file. */
  decodeLegacy?: (bytes: Buffer) => T | undefined;
}) {
  if (options.funding !== undefined && options.funding !== 'monotone-v1') throw new Error('Invalid encrypted funding mode');
  if (options.key.length !== 32) throw new Error('Encrypted local state requires a 32-byte key');
  const statePath = options.path, maximumBytes = options.maxBytes;
  const runFunded = captureStorageReservationOperation();
  const request = (highWater: number) => ({ path: statePath, component: 'encrypted-local-state', scope: 'file' as const, maximumBytes: 2 * highWater + 8192 });
  const binding = options.funding ? { mode: options.funding, ceiling: maximumBytes, path: canonicalLocalStatePath(statePath), component: 'encrypted-local-state', authorityId: currentStorageReservationAuthorityId() } : undefined;
  if (binding && Buffer.byteLength(JSON.stringify({ ...binding, highWater: maximumBytes })) > 7000) throw new Error('Encrypted funding metadata exceeds its bound');
  if (!binding && existsSync(statePath) && statSync(statePath).size <= maximumBytes) {
    let outer: { version?: number; funding?: unknown } | undefined;
    try { outer = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* Existing strict decoder reports malformed legacy data. */ }
    if (outer?.version === 2 && outer.funding) throw new Error('Encrypted local state funding mode changed');
  }
  let highWater = maximumBytes;
  if (binding) {
    if (existsSync(statePath)) {
      if (statSync(statePath).size > maximumBytes) throw new Error('Encrypted local state exceeds its funding ceiling');
      const record = JSON.parse(readFileSync(statePath, 'utf8'));
      if (record.version !== 2 || !record.funding || Object.keys(record.funding).sort().join(',') !== [...Object.keys(binding), 'highWater'].sort().join(',')
        || Object.entries(binding).some(([k,v]) => record.funding[k] !== v)
        || !Number.isSafeInteger(record.funding.highWater) || record.funding.highWater < 1 || record.funding.highWater > maximumBytes
        || statSync(statePath).size > record.funding.highWater) throw new Error('Encrypted local state funding contract changed');
      highWater = record.funding.highWater;
      assertExistingStorageReservation(request(highWater), binding.authorityId);
    } else {
      if (options.mode !== 'create-new') throw new Error('Monotone funding requires explicit new state');
      highWater = encryptedLocalStateByteBound(options.initial);
      if (highWater > maximumBytes) throw new Error('Encrypted outbox byte capacity exceeded');
    }
  }
  let reservation = reserveManagedStorage(request(highWater));
  const directory = dirname(statePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unlock = acquireLocalStateLock(statePath, reservation);
  const key = Buffer.from(options.key);
  const aad = Buffer.from(options.domain);
  let closed = false;
  let poisoned = false;
  let state: T;

  function encode(value: T): Buffer {
    const plaintext = Buffer.from(JSON.stringify(value));
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(binding ? Buffer.from(JSON.stringify([options.domain, { ...binding, highWater }])) : aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const bytes = Buffer.from(JSON.stringify({ version: binding ? 2 : 1, ...(binding ? { funding: { ...binding, highWater } } : {}), nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }));
      if (bytes.length > maximumBytes || binding && bytes.length > highWater) throw new Error('Encrypted outbox byte capacity exceeded');
      return bytes;
    } finally { plaintext.fill(0); }
  }

  function write(value: T): void {
    ensureOpen();
    preflight(value);
    const bytes = encode(value); // Capacity refusal does not poison the previous snapshot.
    const temporary = join(directory, `.${basename(statePath)}.${randomBytes(8).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeAll(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, statePath);
      fsyncDirectory(directory);
      state = value;
    } catch (error) {
      poisoned = true; // A failed flush may have committed; never send based on guessed durability.
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  const retainedTemporary: string[] = [];
  try {
    if (options.mode === 'create-new' && existsSync(statePath)) throw new Error('Encrypted local state already exists');
    if (options.mode === 'open-existing' && !existsSync(statePath)) throw new Error('Encrypted local state is missing; restore its history');
    // An interrupted replacement can leave encrypted temporary snapshots. Only the lock owner cleans them.
    const prefix = `.${basename(statePath)}.`;
    for (const file of readdirSync(directory)) {
      if (file.startsWith(prefix) && /^[a-f0-9]{16}\.tmp$/.test(file.slice(prefix.length))) {
        if (binding) retainedTemporary.push(join(directory, file));
        else rmSync(join(directory, file));
      }
    }
    if (!existsSync(statePath)) write(options.initial);
    else {
      const size = statSync(statePath).size;
      if ((!size && !options.decodeLegacy) || size > maximumBytes) throw new Error('Encrypted outbox file exceeds capacity or is empty');
      const bytes = readFileSync(statePath);
      if (bytes.length > maximumBytes) throw new Error('Encrypted outbox file exceeds capacity');
      let legacy: T | undefined;
      let encoded: string | undefined;
      try {
        legacy = options.decodeLegacy?.(bytes);
        if (legacy === undefined) {
          try { encoded = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { throw new Error('Encrypted outbox file is invalid'); }
        }
      }
      finally { bytes.fill(0); }
      if (legacy !== undefined) {
        if (!options.validate(legacy)) throw new Error('Encrypted outbox legacy state is invalid');
        state = legacy;
      } else {
        let record;
        try { record = JSON.parse(encoded!); }
        catch { throw new Error('Encrypted outbox file is invalid'); } // Never echo legacy plaintext in parser errors.
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).sort().join(',') !== (binding ? 'ciphertext,funding,nonce,tag,version' : 'ciphertext,nonce,tag,version')
          || record.version !== (binding ? 2 : 1) || ![record.nonce, record.tag, record.ciphertext].every(value =>
            typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value))) {
          throw new Error('Encrypted outbox file is invalid');
        }
        const nonce = Buffer.from(record.nonce, 'base64url');
        const tag = Buffer.from(record.tag, 'base64url');
        const ciphertext = Buffer.from(record.ciphertext, 'base64url');
        if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64url') !== record.nonce
          || tag.toString('base64url') !== record.tag || ciphertext.toString('base64url') !== record.ciphertext) throw new Error('Encrypted outbox file is invalid');
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(binding ? Buffer.from(JSON.stringify([options.domain, record.funding])) : aad); decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        try {
          let value: unknown;
          try { value = JSON.parse(new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(plaintext)); }
          catch { throw new Error('Encrypted outbox state is invalid'); }
          if (!options.validate(value)) throw new Error('Encrypted outbox state is invalid');
          state = value;
        } finally { plaintext.fill(0); }
      }
    }
    if (binding) {
      const temporaryBytes = retainedTemporary.reduce((sum, file) => {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid encrypted temporary snapshot');
        return sum + stat.size;
      }, 0);
      if (temporaryBytes > highWater) throw new Error('Unfunded encrypted temporary snapshot');
      for (const file of retainedTemporary) rmSync(file);
    }
  } catch (error) { key.fill(0); unlock(); throw error; }

  function preflightBytes(bound: number): void {
    ensureOpen();
    if (!Number.isSafeInteger(bound) || bound < 0 || bound > maximumBytes) throw new Error('Encrypted outbox byte capacity exceeded');
    if (!binding || bound <= highWater) return;
    runFunded(() => { reservation = reserveManagedStorage(request(bound)); });
    highWater = bound; // Growth is charged even if the following snapshot fails.
  }
  function preflight(...values: unknown[]): void {
    if (binding) for (const value of values) preflightBytes(encryptedLocalStateByteBound(value));
  }
  function assertFunding(): void {
    runFunded(() => assertExistingStorageReservation(request(highWater), binding?.authorityId));
  }
  function ensureOpen(): void {
    if (closed) throw new Error('Encrypted outbox is closed');
    if (poisoned) throw new Error('Encrypted outbox write failed; close and reopen before reuse');
    reservation?.assertWritable();
  }

  return {
    read(): T { ensureOpen(); return state; },
    write, preflight, preflightBytes, assertFunding,
    fundedBytes(): number { return highWater; },
    close(): void { if (!closed) { closed = true; key.fill(0); unlock(); } },
  };
}

/** Single-host process ownership for a local resource. New claims publish their
 * complete owner atomically. Old incomplete file claims still require inspection.
 * The caller creates the parent directory and holds this claim across all writes. */
export function acquireLocalStateLock(path: string, includedReservation?: StorageReservationLease): () => void {
  // Snapshot/diagnostic callers already include this peak. Standalone owners
  // reserve it separately, before opening either ownership file.
  const reservation = includedReservation ?? reserveManagedStorage({ path: `${path}.lock`, component: 'local-state-lock', scope: 'file', maximumBytes: 8192 });
  reservation?.assertWritable();
  return acquireLocalDirectoryOwnership(path);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Encrypted outbox write failed');
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  // Windows cannot flush directory handles; the replacement file is still fsynced.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
