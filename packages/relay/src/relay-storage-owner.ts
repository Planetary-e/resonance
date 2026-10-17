/** Shared storage ownership for explicitly selected relay operations. Product
 * selection/persistence is separate; these APIs never discover or initialize it. */
import { isAbsolute } from 'node:path';
import { openStorageReservationAuthority, openReservedStorageControl, withStorageReservationAuthority,
  type StorageReservationRequest } from '@resonance/core/storage-reservations';
import { acquireStoppedRelayMaintenance, assertRelayNotInMaintenance, relayMaintenanceStorageRequests } from './relay-maintenance.js';

export interface RelayStorageSelection { authorityDirectory: string; authorityId: string; runtimeDirectory: string }
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
  for (const request of copied) if (!request || typeof request.path !== 'string' || !isAbsolute(request.path)
    || request.path.length > 4096 || /[\x00-\x1f\x7f]/.test(request.path) || request.scope !== 'file'
    || !['local-state-lock', 'operator-output', 'operator-atomic-output'].includes(request.component)
    || !Number.isSafeInteger(request.maximumBytes) || request.maximumBytes < 1 || request.maximumBytes > 1024 * 1024) {
    throw new Error('Invalid prepaid relay control scope');
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
  return {
    run<T>(operation: () => T): T {
      if (closed) throw new Error('Relay storage ownership is closed');
      authority.status(); return withStorageReservationAuthority(authority, operation);
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
