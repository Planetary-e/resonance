/** Bounded encrypted snapshots with one writer and atomic, flushed replacement. */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function openEncryptedLocalState<T>(options: {
  path: string; key: Uint8Array; domain: string; maxBytes: number;
  initial: T; validate(value: unknown): value is T;
  mode?: 'create-new' | 'open-existing';
  /** Explicit, strict legacy decoder. Reading does not migrate; the next write atomically replaces the same file. */
  decodeLegacy?: (bytes: Buffer) => T | undefined;
}) {
  if (options.key.length !== 32) throw new Error('Encrypted local state requires a 32-byte key');
  const directory = dirname(options.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(options.path);
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
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const bytes = Buffer.from(JSON.stringify({ version: 1, nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }));
      if (bytes.length > options.maxBytes) throw new Error('Encrypted outbox byte capacity exceeded');
      return bytes;
    } finally { plaintext.fill(0); }
  }

  function write(value: T): void {
    ensureOpen();
    const bytes = encode(value); // Capacity refusal does not poison the previous snapshot.
    const temporary = join(directory, `.${basename(options.path)}.${randomBytes(8).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeAll(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, options.path);
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

  try {
    if (options.mode === 'create-new' && existsSync(options.path)) throw new Error('Encrypted local state already exists');
    if (options.mode === 'open-existing' && !existsSync(options.path)) throw new Error('Encrypted local state is missing; restore its history');
    // An interrupted replacement can leave encrypted temporary snapshots. Only the lock owner cleans them.
    const prefix = `.${basename(options.path)}.`;
    for (const file of readdirSync(directory)) {
      if (file.startsWith(prefix) && /^[a-f0-9]{16}\.tmp$/.test(file.slice(prefix.length))) {
        rmSync(join(directory, file));
      }
    }
    if (!existsSync(options.path)) write(options.initial);
    else {
      const size = statSync(options.path).size;
      if ((!size && !options.decodeLegacy) || size > options.maxBytes) throw new Error('Encrypted outbox file exceeds capacity or is empty');
      const bytes = readFileSync(options.path);
      if (bytes.length > options.maxBytes) throw new Error('Encrypted outbox file exceeds capacity');
      let legacy: T | undefined;
      let encoded: string | undefined;
      try { legacy = options.decodeLegacy?.(bytes); if (legacy === undefined) encoded = bytes.toString('utf8'); }
      finally { bytes.fill(0); }
      if (legacy !== undefined) {
        if (!options.validate(legacy)) throw new Error('Encrypted outbox legacy state is invalid');
        state = legacy;
      } else {
        let record;
        try { record = JSON.parse(encoded!); }
        catch { throw new Error('Encrypted outbox file is invalid'); } // Never echo legacy plaintext in parser errors.
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).sort().join(',') !== 'ciphertext,nonce,tag,version'
          || record.version !== 1 || ![record.nonce, record.tag, record.ciphertext].every(value =>
            typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value))) {
          throw new Error('Encrypted outbox file is invalid');
        }
        const nonce = Buffer.from(record.nonce, 'base64url');
        const tag = Buffer.from(record.tag, 'base64url');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error('Encrypted outbox file is invalid');
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad); decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]);
        try {
          const value: unknown = JSON.parse(plaintext.toString('utf8'));
          if (!options.validate(value)) throw new Error('Encrypted outbox state is invalid');
          state = value;
        } finally { plaintext.fill(0); }
      }
    }
  } catch (error) { key.fill(0); unlock(); throw error; }

  function ensureOpen(): void {
    if (closed) throw new Error('Encrypted outbox is closed');
    if (poisoned) throw new Error('Encrypted outbox write failed; close and reopen before reuse');
  }

  return {
    read(): T { ensureOpen(); return state; },
    write,
    close(): void { if (!closed) { closed = true; key.fill(0); unlock(); } },
  };
}

function acquireLock(path: string): () => void {
  const lock = `${path}.lock`;
  const recovery = `${path}.recovery`;
  const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });
  const claim = () => {
    const fd = openSync(lock, 'wx', 0o600);
    try { writeAll(fd, Buffer.from(owner)); fsyncSync(fd); }
    catch (error) { rmSync(lock, { force: true }); throw error; }
    finally { closeSync(fd); }
  };
  if (existsSync(recovery)) throw new Error('Outbox lock recovery is active or was interrupted; inspect the recovery file before reopening');
  try { claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Serialize stale-lock recovery. An interrupted recovery fails closed instead of racing a live writer.
    let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); }
    catch { throw new Error('Outbox lock recovery is already active or needs inspection'); }
    try {
      if (existsSync(lock)) {
        const previous = JSON.parse(readFileSync(lock, 'utf8'));
        if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid outbox owner lock');
        let dead = false;
        try { process.kill(previous.pid, 0); }
        catch (cause) { dead = (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new Error('Encrypted outbox is already open');
        rmSync(lock);
      }
      claim();
    } finally { closeSync(guard); rmSync(recovery, { force: true }); }
  }
  return () => {
    if (existsSync(lock) && readFileSync(lock, 'utf8') === owner) rmSync(lock);
  };
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
