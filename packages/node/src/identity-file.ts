/** Atomic encrypted account identity publication on a local filesystem. */
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { exportIdentity, importIdentity, MAX_ENCRYPTED_IDENTITY_BYTES, type Identity } from '@resonance/core';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';

const MAX_INTENT = 8192;
interface Snapshot { bytes: Buffer; stat: Stats }
interface Intent { version: 1; kind: 'identity-write'; previous: string | null; encrypted: string }
function present(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export function identityFileExists(path: string): boolean {
  return [path, `${path}.pending`, `${path}.next`].some(path => !!present(path));
}
function digest(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }
function read(path: string, maximum: number): Snapshot | undefined {
  const observed = present(path); if (!observed) return;
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size > maximum || observed.nlink > 2) throw new Error('Unsafe or oversized identity file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== observed.dev || stat.ino !== observed.ino || stat.size > maximum) throw new Error('Identity file changed while opening');
    const bytes = Buffer.alloc(maximum + 1); let size = 0, count: number;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    const after = fstatSync(fd);
    if (size > maximum || size !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('Identity file changed while reading');
    return { bytes: bytes.subarray(0, size), stat };
  } finally { closeSync(fd); }
}
function flushDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function flushFile(path: string) {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAll(fd: number, bytes: Buffer, offset = 0) {
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error('Identity write made no progress'); offset += written;
  }
}
function writeNew(path: string, bytes: Buffer) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

export function openIdentityFile(path: string, createParent: boolean) {
  const absolute = resolve(path), parent = dirname(absolute);
  // Outside a managed context this is an ordinary personal-account writer. An
  // explicit managed caller funds both snapshots, intent and ownership peak
  // through the single-link intent path. First publication briefly gives the
  // primary/candidate two links, which ordinary reserved file targets forbid.
  const reservation = reserveManagedStorage({ path: `${absolute}.pending`, component: 'personal-identity', scope: 'file',
    maximumBytes: 2 * MAX_ENCRYPTED_IDENTITY_BYTES + MAX_INTENT + 8192 });
  reservation?.assertWritable();
  if (createParent) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = realpathSync(parent), file = join(directory, basename(absolute));
  const pendingPath = `${file}.pending`, candidatePath = `${file}.next`;
  const unlock = acquireLocalStateLock(file, reservation);
  let closed = false;
  const writable = () => { if (closed) throw new Error('Identity file handle is closed'); reservation?.assertWritable(); };
  function inspect() {
    writable();
    const primary = read(file, MAX_ENCRYPTED_IDENTITY_BYTES), pending = read(pendingPath, MAX_INTENT), candidate = read(candidatePath, MAX_ENCRYPTED_IDENTITY_BYTES);
    const linked = primary && candidate && primary.stat.dev === candidate.stat.dev && primary.stat.ino === candidate.stat.ino;
    for (const entry of [primary, candidate]) if (entry && entry.stat.nlink !== 1 && !(linked && entry.stat.nlink === 2)) throw new Error('Unexpected identity hard link');
    if (!pending) {
      if (candidate) throw new Error('Identity candidate is missing its publication intent');
      return { primary, intent: undefined, candidate };
    }
    if (pending.stat.nlink !== 1) throw new Error('Unexpected identity intent hard link');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'encrypted,kind,previous,version') throw new Error('Invalid identity publication intent');
    const intent = value as Intent;
    if (intent.version !== 1 || intent.kind !== 'identity-write'
      || (intent.previous !== null && (typeof intent.previous !== 'string' || !/^[a-f0-9]{64}$/.test(intent.previous)))
      || typeof intent.encrypted !== 'string' || Buffer.byteLength(intent.encrypted) > MAX_ENCRYPTED_IDENTITY_BYTES) throw new Error('Invalid identity publication intent');
    const current = primary ? digest(primary.bytes) : null;
    if (current !== intent.previous && current !== digest(intent.encrypted)) throw new Error('Identity publication no longer matches the retained original');
    const expected = Buffer.from(intent.encrypted);
    if (candidate && (candidate.bytes.length > expected.length || !candidate.bytes.equals(expected.subarray(0, candidate.bytes.length)))) throw new Error('Identity candidate differs from its publication intent');
    return { primary, intent, candidate };
  }
  function complete(intent: Intent) {
    writable();
    const current = inspect();
    if (!current.intent || JSON.stringify(current.intent) !== JSON.stringify(intent)) throw new Error('Identity publication intent changed');
    const bytes = Buffer.from(intent.encrypted), committed = current.primary && digest(current.primary.bytes) === digest(bytes);
    // A readable intent from a previous failed flush is made durable before use.
    flushFile(pendingPath); flushDirectory(directory);
    if (!committed) {
      if (!current.candidate) writeNew(candidatePath, bytes);
      else {
        if (current.candidate.stat.nlink !== 1) throw new Error('Unexpected identity candidate link');
        const fd = openSync(candidatePath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
        try { writeAll(fd, bytes, current.candidate.bytes.length); fsyncSync(fd); } finally { closeSync(fd); }
      }
      writable();
      const before = inspect();
      if ((before.primary ? digest(before.primary.bytes) : null) !== intent.previous) throw new Error('Identity changed before publication');
      if (intent.previous === null) linkSync(candidatePath, file); // Never overwrite a first identity.
      else renameSync(candidatePath, file);
      flushDirectory(directory);
    }
    // The current file is durable before removing either recovery artifact.
    writable(); flushFile(file); flushDirectory(directory);
    if (present(candidatePath)) unlinkSync(candidatePath);
    flushDirectory(directory); unlinkSync(pendingPath); flushDirectory(directory);
  }
  return {
    exists() { const state = inspect(); return !!state.primary || !!state.intent; },
    async load(password: string): Promise<Identity> {
      const state = inspect();
      if (!state.primary && (!state.intent || state.intent.previous !== null)) throw new Error('Identity file is missing');
      const identity = await importIdentity(state.primary?.bytes.toString('utf8') ?? state.intent!.encrypted, password);
      try {
        writable();
        if (state.intent && (!state.primary || digest(state.primary.bytes) === digest(state.intent.encrypted))) complete(state.intent);
        return identity;
      } catch (error) { identity.secretKey.fill(0); throw error; }
    },
    async save(identity: Identity, password: string, createOnly = false) {
      const state = inspect();
      if (createOnly && (state.primary || state.intent)) throw new Error('Identity already exists or its creation was interrupted; load it instead');
      if (!(identity?.secretKey instanceof Uint8Array) || identity.secretKey.length !== 64) throw new Error('Invalid identity secret key');
      const expectedSecret = identity.secretKey.slice();
      try {
        const encrypted = await exportIdentity(identity, password); writable();
        let intent = state.intent;
        if (intent) {
          const retained = await importIdentity(intent.encrypted, password);
          try {
            if (!expectedSecret || !Buffer.from(retained.secretKey).equals(Buffer.from(expectedSecret))) throw new Error('Another identity publication is pending');
          } finally { retained.secretKey.fill(0); }
        } else {
          intent = { version: 1, kind: 'identity-write', previous: state.primary ? digest(state.primary.bytes) : null, encrypted };
          const bytes = Buffer.from(JSON.stringify(intent));
          if (bytes.length > MAX_INTENT) throw new Error('Identity publication intent exceeds its bound');
          writable(); writeNew(pendingPath, bytes); flushDirectory(directory);
        }
        complete(intent);
      } finally { expectedSecret?.fill(0); }
    },
    close() { if (!closed) { closed = true; unlock(); } },
  };
}
