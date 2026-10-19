/** A managed operation supplies one authority; opened components retain its lease.
 * Unconfigured callers do not acquire or imply a combined quota. */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface StorageReservationRequest { path: string; component: string; scope: 'file' | 'directory'; maximumBytes: number }
export interface StorageReservationOutput { path: string; maximumBytes: number; replacement?: boolean }
export interface StorageReservationLease { assertWritable(output?: StorageReservationOutput): void }
export interface StorageReservationAuthority {
  reserve(request: StorageReservationRequest): StorageReservationLease;
  status?(): { authorityId: string };
  reviewReservation?(request: StorageReservationRequest): { additionalBytes: number; fits: boolean };
}
const authorities = new AsyncLocalStorage<StorageReservationAuthority>();
export function withStorageReservationAuthority<T>(authority: StorageReservationAuthority, operation: () => T): T {
  const inherited = authorities.getStore();
  if (inherited && inherited !== authority) throw new Error('A managed operation cannot switch its storage authority');
  return authorities.run(authority, operation);
}
/** Factories may open further writers long after construction. Keep the original
 * ownership scope without adopting an unmanaged handle or switching authorities. */
export function captureStorageReservationOperation() {
  const retained = authorities.getStore();
  return <T>(operation: () => T): T => {
    const current = authorities.getStore();
    if (current && current !== retained) throw new Error('A retained operation cannot switch its storage authority');
    return retained ? withStorageReservationAuthority(retained, operation) : operation();
  };
}
export function reserveManagedStorage(request: StorageReservationRequest): StorageReservationLease | undefined {
  return authorities.getStore()?.reserve(request);
}
export function assertNoStorageReservationContext(message = 'Open the shared storage authority before entering a managed operation'): void {
  if (authorities.getStore()) throw new Error(message);
}

/** Reopening retained proof may only consume already committed component peaks. */
export function assertExistingStorageReservation(request: StorageReservationRequest, authorityId?: string, options: { allowUnmanaged?: boolean } = {}): string | undefined {
  const authority = authorities.getStore();
  if (!authority && options.allowUnmanaged && authorityId === undefined) return undefined;
  if (!authority?.reviewReservation) throw new Error('Retained ancestry requires an explicitly selected existing storage authority');
  if (authorityId !== undefined && authority.status?.().authorityId !== authorityId) throw new Error('Retained ancestry funding differs from its independently selected authority');
  const review = authority.reviewReservation({ ...request });
  if (review.additionalBytes !== 0 || !review.fits) throw new Error('Retained ancestry requires its complete existing storage reservation');
  const selectedId = authority.status?.().authorityId;
  if (!selectedId) throw new Error('Retained ancestry funding requires its selected authority identity');
  return selectedId;
}
