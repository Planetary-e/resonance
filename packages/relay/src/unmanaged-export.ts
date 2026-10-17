/** Legacy materialized-view exports have no bounded writer reservation. Keep
 * them unavailable to managed state, even after its construction scope exits.
 * Production relay durability uses the reserved operation journal instead. */
import { assertNoStorageReservationContext, captureStorageReservationOperation } from '@resonance/core/storage-reservations';
export function guardUnmanagedExport() {
  const retained = captureStorageReservationOperation();
  return () => retained(() => assertNoStorageReservationContext('Unreserved materialized-view exports are unavailable for managed relay state'));
}
