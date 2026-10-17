/** Bounded stopped review of an independently pinned existing authority. This
 * never initializes an authority, activates a service or grants general writer access. */
import { isAbsolute } from 'node:path';
import { openStorageReservationAuthority, withStorageReservationAuthority, type StorageAdoptionTarget } from '@resonance/core/storage-reservations';
import { acquireStoppedRelayMaintenance } from './relay-maintenance.js';
import { relayPortClosed } from './relay-listener.js';
import { parseRelayStorageConfiguration } from './relay-storage-selection.js';
import type { RelayStorageSelection, RelayStorageRuntimeBinding } from './relay-storage-owner.js';

export async function openRelayStorageAdoptionReview(options: RelayStorageSelection & RelayStorageRuntimeBinding & {
  kind: 'existing' | 'new'; targets: readonly StorageAdoptionTarget[]; signal?: AbortSignal; approvalTimeoutMs?: number;
}) {
  options.signal?.throwIfAborted();
  const selected = parseRelayStorageConfiguration({ version: 1, kind: 'relay-storage-selection', authorityDirectory: options.authorityDirectory,
    authorityId: options.authorityId, runtimeDirectory: options.runtimeDirectory, runtimePort: options.runtimePort, runtimeHost: options.runtimeHost, controls: [] });
  const kind = options.kind, signal = options.signal, timeout = options.approvalTimeoutMs ?? 60000;
  if (!['existing', 'new'].includes(kind) || !Array.isArray(options.targets) || !options.targets.length || options.targets.length > 256
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) throw new Error('Invalid stopped storage review options');
  const targets = options.targets.map(target => {
    if (!target || typeof target.path !== 'string' || !isAbsolute(target.path) || target.path.length > 4096
      || /[\x00-\x1f\x7f]/.test(target.path) || !['file', 'directory'].includes(target.scope)) throw new Error('Invalid stopped storage target');
    return { path: target.path, scope: target.scope };
  });
  const authority = openStorageReservationAuthority({ directory: selected.authorityDirectory, authorityId: selected.authorityId, mode: 'open-existing' });
  let release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false, cleanupFailed = false;
  const deadline = performance.now() + timeout;
  function close() {
    if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abandon);
    try { try { release?.(); } finally { authority.close(); } }
    catch (error) { cleanupFailed = true; throw error; }
  }
  // Event callbacks must not turn damaged retained ownership into an uncaught
  // exception. Keep the evidence and surface failed cleanup on the next access.
  function abandon() { try { close(); } catch { /* Both release attempts already ran; retain uncertain locks. */ } }
  function check() {
    if (closed) throw new Error(cleanupFailed ? 'Stopped storage review cleanup failed; inspect retained ownership files' : 'Stopped storage review is closed; review again');
    if (signal?.aborted || performance.now() >= deadline) { close(); throw new Error('Stopped storage review expired or was cancelled; review again'); }
    authority.status();
  }
  try {
    // Bootstrap review is deliberately narrower than a normal owner: it may
    // reserve the claim/marker before scopes are adopted, but exposes no run().
    release = withStorageReservationAuthority(authority, () => acquireStoppedRelayMaintenance(selected.runtimeDirectory));
    signal?.addEventListener('abort', abandon, { once: true }); timer = setTimeout(abandon, timeout); timer.unref();
    if (!await relayPortClosed(selected.runtimePort)) throw new Error('Configured relay listener is not closed; stop it before storage adoption');
    check();
    const review = kind === 'existing' ? authority.reviewExisting(targets) : authority.reviewNewScopes(targets);
    check();
    return {
      review() { check(); return structuredClone(review); },
      apply(approvalDigest: string) {
        try {
          check();
          if (approvalDigest !== review.approvalDigest) throw new Error('Stopped storage approval differs; review again');
          // Core re-inventories metadata/absence and the ledger before its commit.
          return kind === 'existing' ? authority.adoptExisting(targets, approvalDigest) : authority.approveNewScopes(targets, approvalDigest);
        } finally { close(); }
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
