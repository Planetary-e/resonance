/** Production composition of known desktop scopes under one bounded approval.
 * Partial commits only add retained floors/scopes; retries re-review them. No
 * service starts here and no accepted history is classified as a new output. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { openStorageReservationAuthority, reviewAbsentStorageScopes, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { acquireStoppedRelayMaintenance } from '@resonance/relay';
import { relayPortClosed } from '../../../relay/src/relay-listener.js';
import { readDesktopStorageBootstrapIntent, desktopStorageBootstrapRequests } from './relay-storage-bootstrap.js';
import { collectDesktopRelayStorageScopes } from './relay-storage-scopes.js';
import { relayStorageRegistryPath } from './history-storage-registry.js';
import type { RelayConfig } from './session.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function openDesktopStorageAdoptionReview(options: {
  dataDirectory: string; config: RelayConfig; limitBytes?: number; signal?: AbortSignal; approvalTimeoutMs?: number;
}) {
  const config = structuredClone(options.config), directory = options.dataDirectory, limitBytes = options.limitBytes;
  const timeout = options.approvalTimeoutMs ?? 60000, signal = options.signal;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000 || !config || config.runtime?.storageSelectionFile
    || !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535
    || limitBytes !== undefined && (!Number.isSafeInteger(limitBytes) || limitBytes < 1)) throw new Error('Invalid stopped desktop storage adoption options');
  const pins = readDesktopStorageBootstrapIntent(directory, config.port);
  const releaseControl = acquireLocalStateLock(join(pins.dataDirectory, 'relay-desktop-control'));
  let authority: ReturnType<typeof openStorageReservationAuthority> | undefined, releaseRuntime: (() => void) | undefined;
  let closed = false, cleanupFailed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = performance.now() + timeout;
  function close() {
    if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abandon);
    try { try { try { releaseRuntime?.(); } finally { authority?.close(); } } finally { releaseControl(); } }
    catch (error) { cleanupFailed = true; throw error; }
  }
  function abandon() { try { close(); } catch { /* Preserve uncertain ownership, surface it on the next call. */ } }
  function check() {
    if (closed) throw new Error(cleanupFailed ? 'Storage adoption cleanup failed; inspect retained ownership' : 'Storage adoption review is closed; review again');
    if (signal?.aborted || performance.now() >= deadline) { close(); throw new Error('Storage adoption review expired or cancelled'); }
    if (JSON.stringify(readDesktopStorageBootstrapIntent(directory, config.port)) !== JSON.stringify(pins)) throw new Error('Storage bootstrap pins changed during adoption');
    authority?.status();
  }
  try {
    authority = openStorageReservationAuthority({ directory: pins.authorityDirectory, authorityId: pins.intent.authorityId, mode: 'open-existing' });
    const owned = authority;
    for (const request of desktopStorageBootstrapRequests(pins.dataDirectory)) {
      if (owned.reviewReservation(request).additionalBytes !== 0) throw new Error('Finish interrupted bootstrap control funding before adoption');
    }
    releaseRuntime = withStorageReservationAuthority(owned, () => acquireStoppedRelayMaintenance(pins.runtimeDirectory));
    signal?.addEventListener('abort', abandon, { once: true }); timer = setTimeout(abandon, timeout); timer.unref();
    if (!await relayPortClosed(config.port)) throw new Error('Configured relay listener is not closed; stop it before storage adoption');
    check();
    const collect = () => collectDesktopRelayStorageScopes(config, pins.dataDirectory);
    const registry = relayStorageRegistryPath(pins.runtimeDirectory);
    try { lstatSync(registry); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Check even if a broad retained root would cover this missing child.
      if (owned.reviewScope({ path: registry, scope: 'directory' }).reserved) throw new Error('The reserved storage registry is missing; restore it before adoption');
    }
    const plan = collect(), scopeStates = plan.new.map(target => owned.reviewScope(target));
    const fresh = scopeStates.filter(target => !target.reviewed).map(({ path, scope }) => ({ path, scope }));
    const reused = scopeStates.filter(target => target.reviewed).map(({ path, scope }) => ({ path, scope }));
    const inspect = () => {
      check();
      if (JSON.stringify(collect()) !== JSON.stringify(plan)) throw new Error('Desktop storage locations changed; review again');
      const existing = owned.reviewExisting(plan.existing), future = fresh.length ? owned.reviewNewScopes(fresh) : null;
      const reusable = reused.length ? reviewAbsentStorageScopes(reused, pins.authorityDirectory) : null;
      const limit = owned.reviewLimit(limitBytes ?? owned.status().limitBytes);
      return { kind: 'desktop-storage-adoption-review' as const, authorityId: pins.intent.authorityId, selectionFile: plan.selectionFile,
        existing, future, reusable, limit, reservedBytesAfterAdoption: existing.reservedBytes,
        fits: existing.reservedBytes <= limit.limitBytes, activationReady: false as const };
    };
    const details = inspect(); check();
    const review = { ...details, approvalDigest: digest(['resonance:desktop-storage-adoption:v1', details, pins.source]) };
    return {
      review() { check(); return structuredClone(review); },
      apply(approved: string) {
        try {
          check();
          if (approved !== review.approvalDigest || digest(['resonance:desktop-storage-adoption:v1', inspect(), pins.source]) !== approved) throw new Error('Desktop storage adoption approval changed; review again');
          if (!review.fits) throw new Error('Retained files exceed the proposed budget; review a sufficient limit');
          owned.applyLimit(review.limit.limitBytes, review.limit.approvalDigest);
          check();
          const current = owned.reviewExisting(plan.existing);
          if (current.metadataDigest !== review.existing.metadataDigest) throw new Error('Existing storage changed after the limit commit; review again');
          owned.adoptExisting(plan.existing, current.approvalDigest);
          check();
          if (fresh.length) {
            const future = owned.reviewNewScopes(fresh);
            if (future.metadataDigest !== review.future!.metadataDigest) throw new Error('New storage parents changed after adoption; review again');
            owned.approveNewScopes(fresh, future.approvalDigest);
          }
          if (reused.length && reviewAbsentStorageScopes(reused, pins.authorityDirectory).metadataDigest !== review.reusable!.metadataDigest) throw new Error('Previously reviewed output parents changed; review again');
          return { result: 'desktop-storage-scopes-adopted' as const, ...owned.status(), selectionFile: plan.selectionFile,
            activationReady: false as const, maintenanceActive: true as const };
        } finally { close(); }
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
