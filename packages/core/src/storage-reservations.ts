/** Monotone local byte reservations. No release, history reset or filesystem quota.
 * Writers must enforce the component peak they reserve. Production opt-in requires
 * the entire writer map, including existing files, to use the same authority. */
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, opendirSync, readSync, realpathSync, renameSync, writeSync, type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { acquireLocalStateLock } from './local-encrypted-state.js';
import { assertNoStorageReservationContext, type StorageReservationLease, type StorageReservationRequest } from './storage-reservation-context.js';

export const STORAGE_RESERVATION_MANIFEST_BYTES = 1024 * 1024;
export const STORAGE_RESERVATION_CONTROL_BYTES = 2 * STORAGE_RESERVATION_MANIFEST_BYTES + 8192;
export const STORAGE_RESERVATION_MAX_ENTRIES = 512;
interface Allocation { path: string; component: string; scope: 'file' | 'directory'; maximumBytes: number }
interface State { version: 1; authorityId: string; revision: number; limitBytes: number; allocations: Allocation[] }
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const inside = (parent: string, path: string) => { const suffix = relative(parent, path); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\')); };
function present(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function canonical(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Storage reservation needs a bounded absolute path');
  let ancestor = resolve(path); const missing: string[] = [];
  while (!present(ancestor)) {
    if (missing.length >= 64 || dirname(ancestor) === ancestor) throw new Error('Storage reservation path cannot be resolved');
    missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), ...missing);
}
function regular(stat: Stats, maximum: number) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Storage reservation metadata must be bounded ordinary files');
}
function signature(stat: Stats) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`; }
function readBytes(path: string) {
  const before = lstatSync(path); regular(before, STORAGE_RESERVATION_MANIFEST_BYTES);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = fstatSync(fd); regular(stat, STORAGE_RESERVATION_MANIFEST_BYTES);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Storage reservation metadata changed');
    const bytes = Buffer.alloc(STORAGE_RESERVATION_MANIFEST_BYTES + 1); let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd), named = lstatSync(path);
    if (used > STORAGE_RESERVATION_MANIFEST_BYTES || used !== stat.size || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('Storage reservation metadata changed');
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}
function flushDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function total(state: State) {
  let result = STORAGE_RESERVATION_CONTROL_BYTES;
  for (const entry of state.allocations) { result += entry.maximumBytes; if (!safe(result)) throw new Error('Storage reservations exceed safe counters'); }
  return result;
}
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function validate(value: unknown, directory: string): State {
  if (!fields(value, ['version', 'authorityId', 'revision', 'limitBytes', 'allocations']) || value.version !== 1
    || typeof value.authorityId !== 'string' || !/^[a-f0-9]{32}$/.test(value.authorityId) || !safe(value.revision)
    || !safe(value.limitBytes) || value.limitBytes < STORAGE_RESERVATION_CONTROL_BYTES
    || !Array.isArray(value.allocations) || value.allocations.length > STORAGE_RESERVATION_MAX_ENTRIES) throw new Error('Invalid storage reservation authority');
  let previous = '';
  for (const allocation of value.allocations) {
    if (!fields(allocation, ['path', 'component', 'scope', 'maximumBytes']) || typeof allocation.path !== 'string'
      || allocation.path <= previous || canonical(allocation.path) !== allocation.path || inside(directory, allocation.path)
      || !['file', 'directory'].includes(allocation.scope as string)
      || typeof allocation.component !== 'string' || !/^[A-Za-z0-9:._/-]{1,256}$/.test(allocation.component)
      || !safe(allocation.maximumBytes)) throw new Error('Invalid or redirected storage allocation');
    previous = allocation.path;
  }
  const state = value as unknown as State;
  if (total(state) > state.limitBytes) throw new Error('Storage authority limit is below retained reservations');
  return state;
}

/** One host process owns the ledger for the complete runtime/maintenance operation.
 * Explicit initialization never reuses an existing directory. Reopening never
 * repairs a missing primary from an uncommitted temporary or resets allocations. */
export function openStorageReservationAuthority(options: { directory: string; mode: 'create-new'; limitBytes: number } | { directory: string; mode: 'open-existing'; authorityId: string }) {
  assertNoStorageReservationContext();
  const directory = canonical(options.directory), path = join(directory, 'reservations.json'), temporary = `${path}.next`;
  if (options.mode !== 'create-new' && options.mode !== 'open-existing') throw new Error('Select explicit storage authority initialization or reopening');
  if (options.mode === 'create-new') {
    if (!safe(options.limitBytes) || options.limitBytes < STORAGE_RESERVATION_CONTROL_BYTES) throw new Error('Storage budget must include its control headroom');
    mkdirSync(directory, { mode: 0o700 }); flushDirectory(dirname(directory));
  }
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Storage authority requires a dedicated ordinary directory');
  const allowed = new Set(['reservations.json', 'reservations.json.next', 'writer.lock', 'writer.recovery']);
  const entries = opendirSync(directory);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (!allowed.has(entry.name)) throw new Error('Unexpected storage authority metadata; retain it for inspection');
      regular(lstatSync(join(directory, entry.name)), entry.name.startsWith('reservations.json') ? STORAGE_RESERVATION_MANIFEST_BYTES : 4096);
    }
  } finally { entries.closeSync(); }
  const release = acquireLocalStateLock(join(directory, 'writer'));
  let closed = false, failed = false, expected: Buffer | undefined, expectedSignature: string | undefined, state: State;
  function usable() {
    if (closed || failed) throw new Error('Storage authority is closed or uncertain; reopen before writing');
    try {
      const now = lstatSync(directory);
      if (canonical(options.directory) !== directory || now.isSymbolicLink() || now.dev !== root.dev || now.ino !== root.ino) throw new Error('Storage authority directory changed');
      if (expectedSignature && signature(lstatSync(path)) !== expectedSignature) throw new Error('Storage authority metadata changed; reopen without resetting reservations');
    } catch (error) { failed = true; throw error; }
  }
  function commit(next: State) {
    usable(); const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.length > STORAGE_RESERVATION_MANIFEST_BYTES) throw new Error('Storage reservation metadata capacity exhausted');
    let fd: number | undefined;
    try {
      if (expected ? !readBytes(path).equals(expected) : present(path)) throw new Error('Storage authority changed outside its writer');
      const pending = present(temporary); if (pending) regular(pending, STORAGE_RESERVATION_MANIFEST_BYTES);
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
      const opened = fstatSync(fd), named = lstatSync(temporary); regular(opened, STORAGE_RESERVATION_MANIFEST_BYTES); regular(named, STORAGE_RESERVATION_MANIFEST_BYTES);
      if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('Storage authority replacement changed');
      ftruncateSync(fd, 0);
      for (let offset = 0; offset < bytes.length;) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) throw new Error('Storage authority write stopped'); offset += count; }
      fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); flushDirectory(directory);
      if (!readBytes(path).equals(bytes)) throw new Error('Storage authority changed before confirmation');
      expected = bytes; expectedSignature = signature(lstatSync(path)); state = next;
    } catch (error) { failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function close() { if (!closed) { closed = true; release(); } }
  try {
    if (options.mode === 'create-new') commit({ version: 1, authorityId: randomBytes(16).toString('hex'), revision: 0, limitBytes: options.limitBytes, allocations: [] });
    else {
      const before = signature(lstatSync(path)); expected = readBytes(path); expectedSignature = signature(lstatSync(path));
      if (before !== expectedSignature) throw new Error('Storage authority metadata changed');
      let parsed: unknown;
      try { parsed = JSON.parse(expected.toString('utf8')); } catch { throw new Error('Storage authority metadata is invalid; retain it for inspection'); }
      state = validate(parsed, directory);
      if (state.authorityId !== options.authorityId) throw new Error('Storage authority does not match its independently retained selection');
      usable();
    }
  } catch (error) { close(); throw error; }
  function limitReview(limitBytes: number) {
    usable(); const reservedBytes = total(state);
    if (!safe(limitBytes) || limitBytes < reservedBytes) throw new Error('Storage limit cannot drop retained allocations or control headroom');
    const approvalDigest = createHash('sha256').update('resonance:storage-limit-review:v1\n').update(expected!).update(`\n${limitBytes}`).digest('hex');
    return { kind: 'storage-limit-review' as const, authorityId: state.authorityId, revision: state.revision,
      previousLimitBytes: state.limitBytes, limitBytes, reservedBytes, approvalDigest };
  }
  return {
    reviewLimit: limitReview,
    applyLimit(limitBytes: number, approvalDigest: string) {
      const review = limitReview(limitBytes);
      if (approvalDigest !== review.approvalDigest) throw new Error('Storage limit approval changed; review the current reservations again');
      if (limitBytes === state.limitBytes) return;
      if (!safe(state.revision + 1)) throw new Error('Storage reservation revision capacity exhausted');
      commit({ ...state, revision: state.revision + 1, limitBytes });
    },
    reserve(request: StorageReservationRequest): StorageReservationLease {
      // A caller may reuse its options object; an issued lease keeps its original target.
      request = { ...request };
      usable();
      const selected = canonical(request.path);
      if (inside(directory, selected) || !['file', 'directory'].includes(request.scope) || typeof request.component !== 'string' || !/^[A-Za-z0-9:._/-]{1,256}$/.test(request.component)
        || !safe(request.maximumBytes)) throw new Error('Invalid managed storage allocation');
      const safeTarget = () => {
        const stat = present(request.path);
        if (stat && (stat.isSymbolicLink() || (request.scope === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))) throw new Error('Reserved component path is not an ordinary unaliased target');
      };
      safeTarget();
      const previous = state.allocations.find(entry => entry.path === selected);
      if (previous && (previous.component !== request.component || previous.scope !== request.scope)) throw new Error('Storage path already belongs to another component');
      if (!previous || previous.maximumBytes < request.maximumBytes) {
        const allocations = state.allocations.filter(entry => entry.path !== selected);
        if (allocations.length >= STORAGE_RESERVATION_MAX_ENTRIES) throw new Error('Storage reservation entry capacity exhausted');
        allocations.push({ path: selected, component: request.component, scope: request.scope, maximumBytes: request.maximumBytes }); allocations.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const next = { ...state, revision: state.revision + 1, allocations };
        if (!safe(next.revision) || total(next) > state.limitBytes) throw new Error('Combined managed storage budget exhausted');
        commit(next);
      }
      return { assertWritable(output) {
        usable(); safeTarget(); if (canonical(request.path) !== selected) throw new Error('Reserved storage path changed');
        if (output) {
          const target = canonical(output.path), stat = present(output.path);
          if (!safe(output.maximumBytes) || output.maximumBytes > request.maximumBytes
            || (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1))) throw new Error('Output exceeds its reserved scope or capacity');
          if (output.replacement) {
            const prefix = `.${basename(selected)}.`, name = basename(target);
            if (request.scope !== 'file' || dirname(target) !== dirname(selected) || !name.startsWith(prefix)
              || !/^[a-f0-9]{16}\.tmp$/.test(name.slice(prefix.length)) || !safe(2 * output.maximumBytes)
              || 2 * output.maximumBytes > request.maximumBytes) throw new Error('Replacement exceeds its reserved scope or capacity');
          } else if (request.scope === 'file' ? target !== selected : !inside(selected, target) || target === selected) {
            throw new Error('Output is outside its reserved scope');
          }
        }
      } };
    },
    status() { usable(); const reservedBytes = total(state); return { authorityId: state.authorityId, revision: state.revision,
      limitBytes: state.limitBytes, reservedBytes, availableBytes: state.limitBytes - reservedBytes, components: state.allocations.length,
      controlBytes: STORAGE_RESERVATION_CONTROL_BYTES }; },
    /** Local review binding only; no independent anti-rollback or durability proof. */
    reviewDigest() { usable(); return createHash('sha256').update(expected!).digest('hex'); },
    close,
  };
}

export { withStorageReservationAuthority, reserveManagedStorage, captureStorageReservationOperation } from './storage-reservation-context.js';
export type { StorageReservationRequest, StorageReservationLease, StorageReservationAuthority, StorageReservationOutput } from './storage-reservation-context.js';
