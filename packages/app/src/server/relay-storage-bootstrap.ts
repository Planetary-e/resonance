/** Durable first-use intent. A retained intent is independent of the ledger it
 * identifies. An attempted initialization may only reopen its primary ledger;
 * neither missing metadata nor a pending replacement is promoted or reset. */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES, type StorageReservationRequest } from '@resonance/core/storage-reservations';
import { writeOperatorJsonNew } from '@resonance/relay';
import { acquireStoppedRelayMaintenance, relayMaintenanceStorageRequests } from '../../../relay/src/relay-maintenance.js';
import { desktopRelayStorageControls } from './relay-storage.js';
import { relayPortClosed } from '../../../relay/src/relay-listener.js';

export const DESKTOP_STORAGE_BOOTSTRAP_DIRECTORY = 'relay-storage-bootstrap';
export const DESKTOP_STORAGE_AUTHORITY_DIRECTORY = 'relay-storage-budget';
const INTENT_BYTES = 16384, ATTEMPT_BYTES = 4096;
export const DESKTOP_STORAGE_BOOTSTRAP_BYTES = INTENT_BYTES + ATTEMPT_BYTES;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = (stat: Stats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
function present(path: string) { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
function flush(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function layout(directory: string) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f\x7f]/.test(directory)) throw new Error('Select an absolute desktop data directory');
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Storage bootstrap needs an ordinary existing desktop directory');
  const dataDirectory = realpathSync(directory), bootstrapDirectory = join(dataDirectory, DESKTOP_STORAGE_BOOTSTRAP_DIRECTORY);
  return { dataDirectory, bootstrapDirectory, authorityDirectory: join(dataDirectory, DESKTOP_STORAGE_AUTHORITY_DIRECTORY),
    runtimeDirectory: join(dataDirectory, 'relay-data'), rootIdentity: `${root.dev}:${root.ino}` };
}
export interface DesktopStorageBootstrapIntent {
  version: 1; kind: 'desktop-storage-bootstrap'; authorityId: string; dataDirectory: string; rootIdentity: string;
  runtimePort: number; runtimeHost: '127.0.0.1'; limitBytes: number;
}
function controls(directory: string): StorageReservationRequest[] {
  return [
    ...relayMaintenanceStorageRequests(join(directory, 'relay-data')),
    ...desktopRelayStorageControls(directory),
    { path: join(directory, DESKTOP_STORAGE_BOOTSTRAP_DIRECTORY), scope: 'directory', component: 'desktop-storage-bootstrap', maximumBytes: DESKTOP_STORAGE_BOOTSTRAP_BYTES },
  ];
}
export const DESKTOP_STORAGE_BOOTSTRAP_MINIMUM_BYTES = STORAGE_RESERVATION_CONTROL_BYTES + controls('/').reduce((sum, request) => sum + request.maximumBytes, 0);
function parseIntent(value: unknown, paths: ReturnType<typeof layout>, port: number): DesktopStorageBootstrapIntent {
  if (!exactWitnessFields(value, ['version', 'kind', 'authorityId', 'dataDirectory', 'rootIdentity', 'runtimePort', 'runtimeHost', 'limitBytes'])
    || value.version !== 1 || value.kind !== 'desktop-storage-bootstrap' || value.dataDirectory !== paths.dataDirectory || value.rootIdentity !== paths.rootIdentity
    || value.runtimeHost !== '127.0.0.1' || value.runtimePort !== port || typeof value.authorityId !== 'string' || !/^[a-f0-9]{32}$/.test(value.authorityId)
    || !Number.isSafeInteger(value.limitBytes) || (value.limitBytes as number) < DESKTOP_STORAGE_BOOTSTRAP_MINIMUM_BYTES) throw new Error('Storage bootstrap intent is invalid or belongs to different settings; preserve it for recovery');
  return value as unknown as DesktopStorageBootstrapIntent;
}
/** Bounded no-follow read with identity checks; failures never echo file contents. */
function read(path: string, maximum: number) {
  const ordinary = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum;
  const before = lstatSync(path); if (!ordinary(before)) throw new Error('Storage bootstrap metadata must be bounded ordinary files');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  const bytes = Buffer.alloc(maximum + 1);
  try {
    const opened = fstatSync(fd); if (!ordinary(opened) || stamp(before) !== stamp(opened)) throw new Error('Storage bootstrap metadata changed');
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    if (used !== opened.size || stamp(fstatSync(fd)) !== stamp(opened) || stamp(lstatSync(path)) !== stamp(opened)) throw new Error('Storage bootstrap metadata changed');
    try { return JSON.parse(bytes.subarray(0, used).toString('utf8')) as unknown; }
    catch { throw new Error('Storage bootstrap metadata is invalid; preserve it for recovery'); }
  } finally { bytes.fill(0); closeSync(fd); }
}
function retained(paths: ReturnType<typeof layout>, port: number) {
  const root = lstatSync(paths.bootstrapDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Storage bootstrap requires its original ordinary directory');
  const entries = opendirSync(paths.bootstrapDirectory);
  try { for (let entry = entries.readSync(); entry; entry = entries.readSync()) if (!['intent.json', 'attempt.json'].includes(entry.name)) throw new Error('Unexpected storage bootstrap files; preserve them for recovery'); }
  finally { entries.closeSync(); }
  const intent = parseIntent(read(join(paths.bootstrapDirectory, 'intent.json'), INTENT_BYTES), paths, port);
  const attempt = present(join(paths.bootstrapDirectory, 'attempt.json'));
  if (attempt) {
    const value = read(join(paths.bootstrapDirectory, 'attempt.json'), ATTEMPT_BYTES);
    if (!exactWitnessFields(value, ['version', 'kind', 'intentDigest']) || value.version !== 1 || value.kind !== 'desktop-storage-bootstrap-attempt' || value.intentDigest !== digest(intent)) {
      throw new Error('Storage bootstrap attempt differs from its retained intent');
    }
  } else if (present(paths.authorityDirectory)) throw new Error('Storage authority exists without its creation attempt; preserve both for recovery');
  return { intent, attempted: !!attempt, source: `${stamp(root)}:${stamp(lstatSync(join(paths.bootstrapDirectory, 'intent.json')))}:${attempt ? stamp(attempt) : 'absent'}` };
}

/** Local presence only, without opening or trusting a possibly partial ledger. */
export function desktopStorageBootstrapPending(directory: string): boolean {
  return !!present(join(directory, DESKTOP_STORAGE_BOOTSTRAP_DIRECTORY)) || !!present(join(directory, DESKTOP_STORAGE_AUTHORITY_DIRECTORY));
}

/** Holds desktop and stopped-runtime exclusion until one apply, cancellation or
 * expiry. This creates only a budget, never adopts files or enables a service. */
export async function openDesktopStorageBootstrapReview(options: {
  dataDirectory: string; runtimePort: number; limitBytes?: number; mode: 'new' | 'recover'; signal?: AbortSignal; approvalTimeoutMs?: number;
}) {
  const suppliedDirectory = options.dataDirectory, port = options.runtimePort, mode = options.mode, limit = options.limitBytes;
  const signal = options.signal, timeout = options.approvalTimeoutMs ?? 60000;
  signal?.throwIfAborted();
  if (!['new', 'recover'].includes(mode) || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000
    || (mode === 'new' ? !Number.isSafeInteger(limit) || limit! < DESKTOP_STORAGE_BOOTSTRAP_MINIMUM_BYTES : limit !== undefined)) throw new Error('Invalid storage bootstrap review options');
  const paths = layout(suppliedDirectory);
  const releaseControl = acquireLocalStateLock(join(paths.dataDirectory, 'relay-desktop-control'));
  let releaseRuntime: (() => void) | undefined, closed = false, failedCleanup = false, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = performance.now() + timeout;
  function close() {
    if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abandon);
    try { try { releaseRuntime?.(); } finally { releaseControl(); } } catch (error) { failedCleanup = true; throw error; }
  }
  function abandon() { try { close(); } catch { /* Keep uncertain files and report on next access. */ } }
  function check() {
    if (closed) throw new Error(failedCleanup ? 'Storage bootstrap cleanup failed; inspect retained ownership' : 'Storage bootstrap review is closed; review again');
    if (signal?.aborted || performance.now() >= deadline) { close(); throw new Error('Storage bootstrap review expired or cancelled'); }
    if (JSON.stringify(layout(suppliedDirectory)) !== JSON.stringify(paths)) throw new Error('Desktop storage directory changed');
  }
  try {
    releaseRuntime = acquireStoppedRelayMaintenance(paths.runtimeDirectory);
    signal?.addEventListener('abort', abandon, { once: true }); timer = setTimeout(abandon, timeout); timer.unref();
    if (!await relayPortClosed(port)) throw new Error('Configured relay listener is not closed; stop it before storage bootstrap');
    check();
    let intent: DesktopStorageBootstrapIntent, source: string, attempted: boolean;
    if (mode === 'new') {
      if (present(paths.bootstrapDirectory) || present(paths.authorityDirectory)) throw new Error('Storage initialization already exists; review recovery instead');
      intent = { version: 1, kind: 'desktop-storage-bootstrap', authorityId: randomBytes(16).toString('hex'), dataDirectory: paths.dataDirectory,
        rootIdentity: paths.rootIdentity, runtimePort: port, runtimeHost: '127.0.0.1', limitBytes: limit! };
      source = stamp(lstatSync(paths.dataDirectory)); attempted = false;
    } else { ({ intent, source, attempted } = retained(paths, port)); }
    const review = { kind: 'desktop-storage-bootstrap-review' as const, mode, intent: structuredClone(intent), attempted,
      authorityDirectory: paths.authorityDirectory, bootstrapDirectory: paths.bootstrapDirectory,
      controlReservationBytes: DESKTOP_STORAGE_BOOTSTRAP_MINIMUM_BYTES, activationReady: false as const,
      approvalDigest: digest(['resonance:desktop-storage-bootstrap:v1', intent, source, mode, attempted]) };
    return {
      review() { check(); return structuredClone(review); },
      apply(approvalDigest: string) {
        let authority: ReturnType<typeof openStorageReservationAuthority> | undefined;
        try {
          check(); if (approvalDigest !== review.approvalDigest) throw new Error('Storage bootstrap approval differs; review again');
          if (mode === 'new') {
            if (present(paths.bootstrapDirectory) || present(paths.authorityDirectory) || stamp(lstatSync(paths.dataDirectory)) !== source) throw new Error('Storage bootstrap selection changed; review again');
            mkdirSync(paths.bootstrapDirectory, { mode: 0o700 }); flush(paths.dataDirectory);
            writeOperatorJsonNew(join(paths.bootstrapDirectory, 'intent.json'), intent, INTENT_BYTES);
          } else {
            const current = retained(paths, port);
            if (current.source !== source || digest(current.intent) !== digest(intent) || current.attempted !== attempted) throw new Error('Storage bootstrap intent changed; review again');
          }
          // A prior durable attempt, including one with no primary, MUST reopen.
          // Before the attempt, a reviewed intact intent can still initialize once.
          if (!attempted) {
            if (present(paths.authorityDirectory)) throw new Error('Storage authority appeared before initialization; retain it');
            // Re-flush an intact retained intent before its first attempt, even
            // if a prior call failed during the intent's file flush.
            const fd = openSync(join(paths.bootstrapDirectory, 'intent.json'), 'r');
            try { fsyncSync(fd); } finally { closeSync(fd); }
            flush(paths.bootstrapDirectory);
            writeOperatorJsonNew(join(paths.bootstrapDirectory, 'attempt.json'), { version: 1, kind: 'desktop-storage-bootstrap-attempt', intentDigest: digest(intent) }, ATTEMPT_BYTES);
            authority = openStorageReservationAuthority({ directory: paths.authorityDirectory, authorityId: intent.authorityId, mode: 'create-new', limitBytes: intent.limitBytes });
          } else authority = openStorageReservationAuthority({ directory: paths.authorityDirectory, authorityId: intent.authorityId, mode: 'open-existing' });
          // Recovery can finish interrupted control funding, never reduce the
          // current limit or reset reservations after adoption has begun.
          for (const request of controls(paths.dataDirectory)) authority.reserve(request);
          return { result: 'storage-budget-retained' as const, authorityDirectory: paths.authorityDirectory, runtimeDirectory: paths.runtimeDirectory,
            ...authority.status(), activationReady: false as const, maintenanceActive: true as const };
        } finally { try { authority?.close(); } finally { close(); } }
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
