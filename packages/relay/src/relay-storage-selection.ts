/** Bounded, explicit local storage pins. Reading never initializes an authority,
 * repairs a missing document, or treats a partial output as a new selection. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import type { StorageReservationRequest } from '@resonance/core/storage-reservations';
import type { RelayStorageSelection } from './relay-storage-owner.js';
export class UnparseableRelayStorageSelectionError extends Error {
  constructor() { super('Relay storage selection is invalid; retain it for inspection'); this.name = 'UnparseableRelayStorageSelectionError'; }
}
export const RELAY_STORAGE_SELECTION_MAX_BYTES = 128 * 1024;
export interface RelayStorageConfiguration extends RelayStorageSelection {
  version: 1; kind: 'relay-storage-selection'; runtimePort: number; runtimeHost: '127.0.0.1' | '0.0.0.0'; controls: StorageReservationRequest[];
}
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
export function parseRelayStorageConfiguration(value: unknown): RelayStorageConfiguration {
  if (!exactWitnessFields(value, ['version', 'kind', 'authorityDirectory', 'authorityId', 'runtimeDirectory', 'runtimePort', 'runtimeHost', 'controls'])
    || value.version !== 1 || value.kind !== 'relay-storage-selection' || !path(value.authorityDirectory) || !path(value.runtimeDirectory)
    || !Number.isSafeInteger(value.runtimePort) || (value.runtimePort as number) < 1024 || (value.runtimePort as number) > 65535
    || !['127.0.0.1', '0.0.0.0'].includes(value.runtimeHost as string)
    || typeof value.authorityId !== 'string' || !/^[a-f0-9]{32}$/.test(value.authorityId)
    || !Array.isArray(value.controls) || value.controls.length > 14) throw new Error('Invalid relay storage selection');
  const controls: StorageReservationRequest[] = [];
  for (const request of value.controls) {
    if (!exactWitnessFields(request, ['path', 'scope', 'component', 'maximumBytes']) || !path(request.path) || request.scope !== 'file'
      || !['local-state-lock', 'operator-output', 'operator-atomic-output'].includes(request.component as string)
      || !Number.isSafeInteger(request.maximumBytes) || (request.maximumBytes as number) < 1 || (request.maximumBytes as number) > 1024 * 1024
      || controls.some(entry => entry.path === request.path)) throw new Error('Invalid relay storage control selection');
    controls.push({ path: request.path, scope: 'file', component: request.component as string, maximumBytes: request.maximumBytes as number });
  }
  const result: RelayStorageConfiguration = { version: 1, kind: 'relay-storage-selection', authorityDirectory: value.authorityDirectory,
    authorityId: value.authorityId, runtimeDirectory: value.runtimeDirectory, runtimePort: value.runtimePort as number, runtimeHost: value.runtimeHost as '127.0.0.1' | '0.0.0.0', controls };
  if (Buffer.byteLength(JSON.stringify(result) + '\n') > RELAY_STORAGE_SELECTION_MAX_BYTES) throw new Error('Relay storage selection exceeds its encoded limit');
  return result;
}
const stamp = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`;
export function readRelayStorageConfiguration(file: string): RelayStorageConfiguration { return readRelayStorageSnapshot(file).configuration; }
export function readRelayStorageSnapshot(file: string) {
  if (!path(file)) throw new Error('Select one absolute relay storage configuration file');
  const ordinary = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= RELAY_STORAGE_SELECTION_MAX_BYTES;
  const before = lstatSync(file), resolved = realpathSync(file);
  if (!ordinary(before)) throw new Error('Relay storage selection must be a bounded ordinary file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  const bytes = Buffer.alloc(RELAY_STORAGE_SELECTION_MAX_BYTES + 1);
  try {
    const opened = fstatSync(fd);
    if (!ordinary(opened) || stamp(opened) !== stamp(before)) throw new Error('Relay storage selection changed while opening');
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd), named = lstatSync(file);
    if (!ordinary(named) || stamp(after) !== stamp(opened) || stamp(named) !== stamp(opened) || realpathSync(file) !== resolved || used !== opened.size) {
      throw new Error('Relay storage selection changed while reading');
    }
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, used).toString('utf8')); }
    catch { throw new UnparseableRelayStorageSelectionError(); }
    return { configuration: parseRelayStorageConfiguration(value), source: { path: resolved, identity: stamp(opened), digest: createHash('sha256').update(bytes.subarray(0, used)).digest('hex') } };
  } finally { bytes.fill(0); closeSync(fd); }
}
