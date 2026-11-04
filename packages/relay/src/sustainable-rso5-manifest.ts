import type { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { preflightSustainableRecoveryManifest, type RecoveryAllocationManifest } from './sustainable-recovery-manifest.js';

export interface Rso5PhysicalClosure { frames: number; archiveHeaders: number; delegations: number; total: number; headroom: number }
export function rso5PhysicalClosure(scopeCount = 10): Rso5PhysicalClosure {
  if (!Number.isSafeInteger(scopeCount) || scopeCount < 1 || scopeCount > 10) throw new Error('RSO5 scope inventory exceeds declared maximum');
  const frames = 215344 + 72 * 265, archiveHeaders = 72 * 256, delegations = 3 * (553 + 2 * 68 * scopeCount), total = frames + archiveHeaders + delegations;
  return { frames, archiveHeaders, delegations, total, headroom: 262144 - total };
}
export function preflightRso5Manifest(authority: ReturnType<typeof openStorageReservationAuthority>, manifest: RecoveryAllocationManifest, mode: 'new' | 'existing') {
  const compiled = preflightSustainableRecoveryManifest(authority, manifest, mode), closure = rso5PhysicalClosure();
  if (closure.total > 262144) throw new Error('RSO5 physical closure exceeds C');
  for (const owner of compiled.manifest.owners) if (owner.C < closure.total) throw new Error(`RSO5 owner C closure exceeds declared limit: ${owner.owner}`);
  if (184 + 72 * 101 > 65536 || 184 + 3 * 101 > 16384) throw new Error('RSO5 checkpoint exceeds L/D/P');
  return { ...compiled, rso5Closure: closure };
}
