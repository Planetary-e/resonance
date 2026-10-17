/** Shared bounded reviews for an already selected, stopped desktop authority. */
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { join } from 'node:path';
import { readDesktopRelayStorage } from './relay-storage.js';
import type { RelayStorageOwner } from '@resonance/relay';
import type { RelayConfig } from './session.js';

export async function openDesktopStorageMaintenanceReview<T extends { review(): unknown; apply(approvalDigest: string): unknown }>(options: {
  dataDirectory: string; config: RelayConfig; signal: AbortSignal; prepare(owner: RelayStorageOwner): T;
}) {
  options.signal.throwIfAborted();
  const selected = readDesktopRelayStorage(options.config);
  if (!selected) throw new Error('Select the desktop storage authority before changing its limit or locations');
  const releaseControl = selected.controls(() => acquireLocalStateLock(join(options.dataDirectory, 'relay-desktop-control')));
  const prepare = options.prepare, deadline = performance.now() + 60000;
  let owner: RelayStorageOwner | undefined, closed = false;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60000)]);
  function close() {
    if (closed) return; closed = true; signal.removeEventListener('abort', abandon);
    try { owner?.close(); } finally { releaseControl(); }
  }
  function abandon() { try { close(); } catch { /* Retain uncertain ownership. */ } }
  function check() {
    if (closed) throw new Error('Storage maintenance review is closed; review again');
    if (performance.now() >= deadline) { close(); throw new Error('Storage maintenance review expired; review again'); }
    signal.throwIfAborted(); selected!.assertCurrent(); owner?.status();
  }
  try {
    owner = await selected.stopped(signal); check(); signal.addEventListener('abort', abandon, { once: true });
    const handle = prepare(owner); check();
    return {
      review(): ReturnType<T['review']> { check(); return handle.review() as ReturnType<T['review']>; },
      apply(approvalDigest: string): ReturnType<T['apply']> {
        try { check(); const result = handle.apply(approvalDigest); check(); return result as ReturnType<T['apply']>; }
        finally { close(); }
      }, close,
    };
  } catch (error) { close(); throw error; }
}
export function openDesktopStorageLimitReview(options: { dataDirectory: string; config: RelayConfig; limitBytes: number; signal: AbortSignal }) {
  const limitBytes = options.limitBytes;
  return openDesktopStorageMaintenanceReview({ ...options, prepare(held) {
    const review = held.reviewLimit(limitBytes);
    return {
      review() { return { kind: 'desktop-storage-limit-review' as const, limit: structuredClone(review), approvalDigest: review.approvalDigest }; },
      apply(approvalDigest: string) { return { result: 'desktop-storage-limit-changed' as const, ...held.applyLimit(review.limitBytes, approvalDigest), maintenanceActive: true as const }; },
    };
  } });
}
