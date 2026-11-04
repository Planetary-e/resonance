import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PolicyObserverRecoveryProgress } from './PolicyObserverRecovery';
import type { RelayPolicyObserverRecoveryResult } from '../policy-observer-recovery.types';
vi.mock('../api.client', () => ({}));
const render = (result: Partial<RelayPolicyObserverRecoveryResult>, busy = false) => renderToStaticMarkup(<PolicyObserverRecoveryProgress
  result={{ readiness: 'unverified', startsService: false, ...result }} busy={busy} onAction={() => {}} />);
it('explains irreversible fencing, explicit source loss and conflict-preserving restoration before approval', () => {
  const freeze = { kind: 'policy-observer-recovery-freeze', localStateDigest: 'sha256:evidence', generation: 0, nextGeneration: 1, view: 1 };
  expect(render(freeze)).toContain('permanently retired'); expect(render(freeze)).toContain('irreversible freeze');
  expect(render({ ...freeze, localStateDigest: null })).toContain('declared the local source unavailable');
  const conflict = render({ kind: 'policy-observer-restore', blocked: true, policyRevision: 2, generation: 1, blocks: 3 }, true);
  expect(conflict).toContain('Conflicting signed policies will remain preserved'); expect(conflict).toContain('does not make this observer able to certify'); expect(conflict).toContain('disabled');
});
it('offers inspection for an occupied destination and keeps export separate from activation', () => {
  const occupied = render({ complete: true, destinationOccupied: true, phase: 'review' });
  expect(occupied).toContain('Keep those files'); expect(occupied).toContain('Review retained restoration'); expect(occupied).not.toContain('Approve observer restoration');
  expect(render({ kind: 'policy-restoration-resumption' })).toContain('Missing accepted history cannot be recreated');
  const exported = render({ result: 'policy-restoration-configuration-exported', output: '/retained/config.json' });
  expect(exported).toContain('relay stays paused'); expect(exported).toContain('separate activation review'); expect(exported).not.toContain('Approve');
});
