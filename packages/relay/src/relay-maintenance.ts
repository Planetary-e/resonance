/** Coordination of one managed relay runtime and explicitly reviewed maintenance.
 * Persistent maintenance survives GUI/process failure; it never clears history. */
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { readOperatorJson, writeOperatorJsonNew } from './admission-operator-files.js';

export const RELAY_MAINTENANCE_FILENAME = 'relay-maintenance.json';
export const RELAY_RUNTIME_RESOURCE = 'relay-runtime';
export interface RelayMaintenanceState { version: 1; kind: 'relay-maintenance'; createdAt: number }
function present(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function reserveControl(directory: string) {
  const claim = reserveManagedStorage({ path: join(directory, `${RELAY_RUNTIME_RESOURCE}.lock`), component: 'local-state-lock', scope: 'file', maximumBytes: 8192 });
  // Reserve pausing before accepting runtime work, so reaching capacity cannot
  // consume the marker's headroom. Removing a marker never releases its peak.
  reserveManagedStorage({ path: join(directory, RELAY_MAINTENANCE_FILENAME), component: 'operator-output', scope: 'file', maximumBytes: 1024 });
  return claim;
}
function runtimeClaim(directory: string) {
  const reservation = reserveControl(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return acquireLocalStateLock(join(directory, RELAY_RUNTIME_RESOURCE), reservation);
}
export function readRelayMaintenance(directory: string): RelayMaintenanceState | null {
  const path = join(directory, RELAY_MAINTENANCE_FILENAME);
  if (!present(path)) return null;
  const value = readOperatorJson(path, 1024);
  if (!exactWitnessFields(value, ['version', 'kind', 'createdAt']) || value.version !== 1 || value.kind !== 'relay-maintenance'
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) throw new Error('Relay maintenance marker is invalid; retain it for inspection');
  return value as unknown as RelayMaintenanceState;
}
export function assertRelayNotInMaintenance(directory: string) {
  if (present(join(directory, RELAY_MAINTENANCE_FILENAME))) throw new Error('Relay maintenance is active; finish it explicitly before starting the service');
}
/** Held by main.ts until the process exits, including unresponsive startup/shutdown. */
export function acquireRelayRuntime(directory: string): () => void {
  const release = runtimeClaim(directory);
  try { assertRelayNotInMaintenance(directory); return release; }
  catch (error) { release(); throw error; }
}
/** Caller holds its desktop control lock. Publish before asking the supervisor to stop. */
export function beginRelayMaintenance(directory: string): RelayMaintenanceState {
  reserveControl(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retained = readRelayMaintenance(directory); if (retained) return retained;
  const state: RelayMaintenanceState = { version: 1, kind: 'relay-maintenance', createdAt: Date.now() };
  writeOperatorJsonNew(join(directory, RELAY_MAINTENANCE_FILENAME), state, 1024); return state;
}
/** Holds runtime exclusion through an entire operator operation; no network status
 * response is treated as proof of process death. The maintenance marker stays. */
export function acquireStoppedRelayMaintenance(directory: string): () => void {
  if (!readRelayMaintenance(directory)) throw new Error('Start relay maintenance before running history operations');
  return runtimeClaim(directory);
}
export function finishRelayMaintenance(directory: string): void {
  const release = acquireStoppedRelayMaintenance(directory);
  try {
    unlinkSync(join(directory, RELAY_MAINTENANCE_FILENAME));
    if (process.platform !== 'win32') { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  } finally { release(); }
}
