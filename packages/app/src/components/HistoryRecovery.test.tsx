import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryRecoveryProgress } from './HistoryRecovery';
import type { RelayHistoryRecoveryResult } from '../history-recovery.types';
vi.mock('../api.client', () => ({}));
const render = (result: RelayHistoryRecoveryResult, busy = false) => renderToStaticMarkup(<HistoryRecoveryProgress result={result} busy={busy} onAction={() => {}} />);
it('separates irreversible freeze approval, bounded steps, restoration review and later activation', () => {
  const freeze = render({ kind: 'admission-recovery-freeze', directory: '/recovery', generation: 0, nextGeneration: 1, view: 2, approvalDigest: 'private-review-digest' });
  for (const value of ['irreversible freeze', 'ordinary writes and exact retries will stop', 'each following phase requires an explicit step', 'Approve freeze']) expect(freeze).toContain(value);
  expect(freeze).not.toContain('private-review-digest');
  expect(render({ phase: 'download-and-confirm', complete: false })).toContain('Run next recovery step');
  expect(render({ phase: 'review', complete: true })).toContain('Review restoration');
  const restore = render({ kind: 'admission-history-restore', directory: '/restored', spends: 8, permanentDenials: 2, requestedPolicyRevision: 3,
    witnessVotes: 4, coordinatorCertificates: 3, rolePermanentDenials: 1 }, true);
  for (const value of ['/restored', '8 retained spends', '2 permanent denials', 'four fresh copies', 'does not start', 'disabled=""']) expect(restore).toContain(value);
  for (const value of ['4 witness decisions', '3 quorum certificates', '1 permanent role denials']) expect(restore).toContain(value);
  const ready = render({ result: 'history-restored', generation: 1 });
  expect(ready).toContain('remains paused'); expect(ready).toContain('Activate prepared owner history');
  const resumed = render({ phase: 'review', complete: true, destinationOccupied: true });
  expect(resumed).toContain('presence alone does not confirm'); expect(resumed).toContain('Do not restore over existing files');
  expect(resumed).not.toContain('>Review restoration<'); expect(resumed).toContain('Review retained restoration');
  const readiness = render({ kind: 'admission-restoration-readiness', appliedSpends: 2, pending: true, initializeWriter: true, requestedPolicyRevision: 3 });
  for (const text of ['2 locally applied spends', 'retained update still needs completion', 'does not replace the spend history', 'Missing committed state is refused', 'Approve readiness completion']) expect(readiness).toContain(text);
});
