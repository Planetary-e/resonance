/** A managed operation supplies one authority; opened components retain its lease.
 * Unconfigured callers do not acquire or imply a combined quota. */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface StorageReservationRequest { path: string; component: string; scope: 'file' | 'directory'; maximumBytes: number }
export interface StorageReservationOutput { path: string; maximumBytes: number; replacement?: boolean }
export interface StorageReservationLease { assertWritable(output?: StorageReservationOutput): void }
export interface StorageReservationAuthority {
  reserve(request: StorageReservationRequest): StorageReservationLease;
}
const authorities = new AsyncLocalStorage<StorageReservationAuthority>();
export function withStorageReservationAuthority<T>(authority: StorageReservationAuthority, operation: () => T): T {
  const inherited = authorities.getStore();
  if (inherited && inherited !== authority) throw new Error('A managed operation cannot switch its storage authority');
  return authorities.run(authority, operation);
}
export function reserveManagedStorage(request: StorageReservationRequest): StorageReservationLease | undefined {
  return authorities.getStore()?.reserve(request);
}
export function assertNoStorageReservationContext(): void {
  if (authorities.getStore()) throw new Error('Open the shared storage authority before entering a managed operation');
}
