/** Shared storage ownership for explicitly selected relay operations. Product
 * selection/persistence is separate; these APIs never discover or initialize it. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { isAbsolute, resolve } from 'node:path';
import { openStorageReservationAuthority, openReservedStorageControl, withStorageReservationAuthority, reviewAbsentStorageScopes,
  type StorageReservationRequest } from '@resonance/core/storage-reservations';
import { parseRelayStorageConfiguration, RELAY_STORAGE_SELECTION_MAX_BYTES } from './relay-storage-selection.js';
import { writeOperatorJsonNew } from './admission-operator-files.js';
import { acquireStoppedRelayMaintenance, assertRelayNotInMaintenance, relayMaintenanceStorageRequests } from './relay-maintenance.js';

export interface RelayStorageRuntimeBinding { runtimePort: number; runtimeHost: '127.0.0.1' | '0.0.0.0' }
export interface RelayStorageSelection { authorityDirectory: string; authorityId: string; runtimeDirectory: string }
const ownership = new AsyncLocalStorage<{ selection: RelayStorageSelection; purpose: 'runtime' | 'maintenance'; check(): void }>();
/** Selected native definitions must be charged by the same stopped owner that
 * their future process will open. Unmanaged or unrelated scopes cannot prepare them. */
export function assertStoppedRelayStorageOwner(input: RelayStorageSelection): void {
  const held = ownership.getStore();
  if (!held || held.purpose !== 'maintenance' || held.selection.authorityId !== input.authorityId
    || resolve(held.selection.authorityDirectory) !== resolve(input.authorityDirectory)
    || resolve(held.selection.runtimeDirectory) !== resolve(input.runtimeDirectory)) {
    throw new Error('Prepare the selected relay service under its stopped storage ownership');
  }
  held.check();
}

function selection(input: RelayStorageSelection): RelayStorageSelection {
  if (!input || typeof input !== 'object') throw new Error('Select the existing relay storage authority explicitly');
  const copy = { authorityDirectory: input.authorityDirectory, authorityId: input.authorityId, runtimeDirectory: input.runtimeDirectory };
  if (![copy.authorityDirectory, copy.runtimeDirectory].every(path => typeof path === 'string' && isAbsolute(path)
    && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path)) || typeof copy.authorityId !== 'string' || !/^[a-f0-9]{32}$/.test(copy.authorityId)) {
    throw new Error('Invalid relay storage selection');
  }
  return copy;
}
function controls(selected: RelayStorageSelection, extra: readonly StorageReservationRequest[]) {
  if (!Array.isArray(extra) || extra.length > 14) throw new Error('Select at most 14 additional relay controls');
  const copied = [...relayMaintenanceStorageRequests(selected.runtimeDirectory), ...extra.map(request => ({ ...request }))];
  const paths = new Set<string>();
  for (const request of copied) {
    if (!exactWitnessFields(request as unknown, ['path', 'scope', 'component', 'maximumBytes']) || typeof request.path !== 'string' || !isAbsolute(request.path)
    || request.path.length > 4096 || /[\x00-\x1f\x7f]/.test(request.path) || request.scope !== 'file'
    || !['local-state-lock', 'operator-output', 'operator-atomic-output'].includes(request.component)
    || !Number.isSafeInteger(request.maximumBytes) || request.maximumBytes < 1 || request.maximumBytes > 1024 * 1024) {
      throw new Error('Invalid prepaid relay control scope');
    }
    const path = resolve(request.path);
    if (paths.has(path)) throw new Error('Duplicate prepaid relay control scope');
    paths.add(path);
  }
  return copied;
}

/** Call before diagnostics/runtime import, or before a stopped operator workflow.
 * Runtime itself still acquires its normal claim; maintenance owns that claim here.
 * Close only after all created writers and any deferred service stop complete. */
export function openRelayStorageOwner(input: RelayStorageSelection, purpose: 'runtime' | 'maintenance', extraControls: readonly StorageReservationRequest[] = []) {
  if (!['runtime', 'maintenance'].includes(purpose)) throw new Error('Select runtime or stopped maintenance storage ownership');
  const selected = selection(input), requests = controls(selected, extraControls);
  const authority = openStorageReservationAuthority({ directory: selected.authorityDirectory, authorityId: selected.authorityId,
    mode: 'open-existing', requireAdoptedScopes: true });
  let release: (() => void) | undefined, closed = false;
  try {
    withStorageReservationAuthority(authority, () => {
      if (purpose === 'runtime') assertRelayNotInMaintenance(selected.runtimeDirectory);
      else release = acquireStoppedRelayMaintenance(selected.runtimeDirectory);
      for (const request of requests) authority.reserve(request);
    });
    // Reuse the independent control validator too; it grants no writer ownership.
    const proof = openReservedStorageControl({ directory: selected.authorityDirectory, authorityId: selected.authorityId, controls: requests }); proof.close();
  } catch (error) { try { release?.(); } finally { authority.close(); } throw error; }
  function selectionReview(path: string, binding: RelayStorageRuntimeBinding) {
    if (closed || purpose !== 'maintenance') throw new Error('Storage selection export requires stopped maintenance ownership');
    const configuration = parseRelayStorageConfiguration({ version: 1, kind: 'relay-storage-selection', ...selected,
      runtimePort: binding?.runtimePort, runtimeHost: binding?.runtimeHost, controls: requests.slice(2) });
    const absent = reviewAbsentStorageScopes([{ path, scope: 'file' }], realpathSync(selected.authorityDirectory));
    const status = authority.status(), output = absent.targets[0].path;
    const reservation = authority.reviewReservation({ path: output, scope: 'file', component: 'operator-output', maximumBytes: RELAY_STORAGE_SELECTION_MAX_BYTES });
    if (!reservation.fits) throw new Error('Storage selection output does not fit its managed budget');
    const approvalDigest = createHash('sha256').update('resonance:relay-storage-selection:v1\n').update(authority.reviewDigest())
      .update(absent.metadataDigest).update(JSON.stringify(configuration)).digest('hex');
    return { kind: 'relay-storage-selection-export' as const, output, configuration: structuredClone(configuration),
      authorityId: status.authorityId, revision: status.revision, maximumBytes: RELAY_STORAGE_SELECTION_MAX_BYTES, approvalDigest };
  }
  return {
    run<T>(operation: () => T): T {
      if (closed) throw new Error('Relay storage ownership is closed');
      authority.status(); return withStorageReservationAuthority(authority, () => ownership.run({ selection: selected, purpose, check: () => {
        if (closed) throw new Error('Relay storage ownership is closed'); authority.status();
      } }, operation));
    },
    /** Preflight distinct writer peaks without funding them or exposing the ledger. */
    reviewWriteBudget(requests: readonly StorageReservationRequest[]) {
      if (closed || purpose !== 'maintenance' || !Array.isArray(requests) || !requests.length || requests.length > 64) throw new Error('Review bounded writer peaks under stopped ownership');
      const reviewed = requests.map(request => authority.reviewReservation(request));
      if (new Set(reviewed.map(request => request.path)).size !== reviewed.length) throw new Error('Review each storage output peak only once');
      const status = authority.status(), additionalBytes = reviewed.reduce((sum, request) => sum + request.additionalBytes, 0);
      if (!Number.isSafeInteger(additionalBytes) || !Number.isSafeInteger(status.reservedBytes + additionalBytes)) throw new Error('Storage output peaks exceed safe byte counters');
      return { requests: reviewed, authorityId: status.authorityId, revision: status.revision, additionalBytes,
        reservedBytes: status.reservedBytes + additionalBytes, limitBytes: status.limitBytes,
        fits: status.reservedBytes + additionalBytes <= status.limitBytes };
    },
    reviewSelectionOutput(path: string, binding: RelayStorageRuntimeBinding) { return selectionReview(path, binding); },
    reviewLimit(limitBytes: number) {
      if (closed || purpose !== 'maintenance') throw new Error('Review storage limits under stopped ownership');
      return authority.reviewLimit(limitBytes);
    },
    applyLimit(limitBytes: number, approvalDigest: string) {
      if (closed || purpose !== 'maintenance') throw new Error('Change storage limits under stopped ownership');
      authority.applyLimit(limitBytes, approvalDigest); return authority.status();
    },
    exportSelection(path: string, binding: RelayStorageRuntimeBinding, approvalDigest: string) {
      const review = selectionReview(path, binding);
      if (approvalDigest !== review.approvalDigest) throw new Error('Storage selection approval changed; review current paths and budget again');
      withStorageReservationAuthority(authority, () => writeOperatorJsonNew(review.output, review.configuration, RELAY_STORAGE_SELECTION_MAX_BYTES));
      return { result: 'relay-storage-selection-exported' as const, output: review.output };
    },
    status() { return authority.status(); },
    close() {
      if (closed) return; closed = true;
      try { release?.(); } finally { authority.close(); }
    },
  };
}

/** A synchronous control scope cannot outlive its read-only committed proof.
 * Use only for bounded marker/settings/lock writes, not an operator workflow. */
export function withRelayStorageControls<T>(input: RelayStorageSelection, extraControls: readonly StorageReservationRequest[], operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  const selected = selection(input), requests = controls(selected, extraControls);
  const view = openReservedStorageControl({ directory: selected.authorityDirectory, authorityId: selected.authorityId, controls: requests });
  try { return withStorageReservationAuthority(view, operation); } finally { view.close(); }
}

export type RelayStorageOwner = ReturnType<typeof openRelayStorageOwner>;
