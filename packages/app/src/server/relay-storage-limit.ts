/** Bounded limit changes for an already selected, stopped desktop authority. */
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { join } from 'node:path';
import { readDesktopRelayStorage } from './relay-storage.js';
import type { RelayStorageOwner } from '@resonance/relay';
import type { RelayConfig } from './session.js';

export async function openDesktopStorageLimitReview(options: { dataDirectory: string; config: RelayConfig; limitBytes: number; signal: AbortSignal }) {
  options.signal.throwIfAborted();
  const selected = readDesktopRelayStorage(options.config);
  if (!selected) throw new Error('Select the desktop storage authority before changing its active limit');
  const releaseControl = selected.controls(() => acquireLocalStateLock(join(options.dataDirectory, 'relay-desktop-control')));
  let owner: RelayStorageOwner | undefined, closed = false;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60000)]);
  function close() {
    if (closed) return; closed = true; signal.removeEventListener('abort', abandon);
    try { owner?.close(); } finally { releaseControl(); }
  }
  function abandon() { try { close(); } catch { /* Retain uncertain ownership. */ } }
  function check() {
    if (closed) throw new Error('Storage limit review is closed; review again');
    signal.throwIfAborted(); selected!.assertCurrent(); owner?.status();
  }
  try {
    owner = await selected.stopped(signal); check(); signal.addEventListener('abort', abandon, { once: true });
    const held = owner, review = held.reviewLimit(options.limitBytes);
    return {
      review() { check(); return { kind: 'desktop-storage-limit-review' as const, limit: structuredClone(review), approvalDigest: review.approvalDigest }; },
      apply(approvalDigest: string) {
        try { check(); return { result: 'desktop-storage-limit-changed' as const, ...held.applyLimit(review.limitBytes, approvalDigest), maintenanceActive: true as const }; }
        finally { close(); }
      }, close,
    };
  } catch (error) { close(); throw error; }
}
