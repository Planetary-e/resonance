/** Explicit scope expansion for later roles. Approval retains a scope in the
 * existing ledger; it does not create/initialize role history or free any bytes. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { canonicalHistorySetupPath, historySetupContains } from '@resonance/relay';
import { isAbsolute } from 'node:path';
import { openDesktopStorageMaintenanceReview } from './relay-storage-limit.js';
import type { RelayConfig } from './session.js';
export function openDesktopStorageScopeReview(options: { dataDirectory: string; config: RelayConfig; input: unknown; signal: AbortSignal }) {
  const input = options.input;
  if (!exactWitnessFields(input, ['kind', 'scope', 'path']) || !['existing', 'new'].includes(input.kind as string)
    || !['file', 'directory'].includes(input.scope as string) || typeof input.path !== 'string' || !isAbsolute(input.path)
    || input.path.length > 4096 || /[\x00-\x1f\x7f]/.test(input.path)) throw new Error('Select one existing or new absolute storage location');
  const kind = input.kind as 'existing' | 'new', targets = [{ path: input.path, scope: input.scope as 'file' | 'directory' }];
  const directory = canonicalHistorySetupPath(options.dataDirectory);
  if (targets[0].scope === 'directory' && historySetupContains(canonicalHistorySetupPath(targets[0].path), directory)) {
    throw new Error('Relay storage must not contain desktop account data; select a separate location');
  }
  return openDesktopStorageMaintenanceReview({ ...options, prepare(held) {
    const review = held.reviewScopeAdoption(kind, targets);
    if (review.targets.some(target => target.scope === 'directory' && historySetupContains(target.path, directory))) {
      throw new Error('Relay storage must not contain desktop account data; select a separate location');
    }
    const status = held.status();
    return {
      review() { return { kind: 'desktop-storage-scope-review' as const, mode: kind, targets: structuredClone(review.targets),
        observedBytes: 'observedBytes' in review ? review.observedBytes : 0, reservedBytes: review.reservedBytes, limitBytes: status.limitBytes,
        fits: review.reservedBytes <= status.limitBytes, createsFiles: false as const, approvalDigest: review.approvalDigest }; },
      apply(approvalDigest: string) {
        held.applyScopeAdoption(kind, targets, approvalDigest);
        return { result: 'desktop-storage-location-adopted' as const, ...held.status(), maintenanceActive: true as const, createsFiles: false as const };
      },
    };
  } });
}
