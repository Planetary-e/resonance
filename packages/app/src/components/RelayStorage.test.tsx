import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RelayStorageStatusView, RelayStorageReviewView } from './RelayStorage';
import type { RelayStorageReview } from '../relay-storage.types';
vi.mock('../api.client', () => ({}));
it('reports reserved capacity separately from filesystem use and reports unavailable accounting without inventing zero', () => {
  const summary = renderToStaticMarkup(<RelayStorageStatusView state={{ phase: 'selected', maintenanceActive: true,
    budget: { authorityId: 'f'.repeat(32), revision: 1, limitBytes: 10485760, reservedBytes: 8388608, availableBytes: 2097152,
      components: 2, controlBytes: 100, adoptedSelections: 1, adoptedBytes: 20 } }} />);
  expect(summary).toContain('Limit: 10.00 MiB'); expect(summary).toContain('Reserved: 8.00 MiB'); expect(summary).toContain('Available for new reservations: 2.00 MiB');
  expect(summary).toContain('not measured disk use or free filesystem space'); expect(summary).toContain('does not confirm network or admission readiness');
  expect(summary).not.toContain('f'.repeat(32));
  const unknown = renderToStaticMarkup(<RelayStorageStatusView state={{ phase: 'recovery-required', maintenanceActive: true, budget: null }} />);
  expect(unknown).toContain('could not be verified'); expect(unknown).not.toContain('0.00 MiB'); expect(unknown).not.toContain('Available for new');
});
it('blocks insufficient activation approval and makes the paused outcome explicit', () => {
  const plan: RelayStorageReview = { kind: 'desktop-storage-activation-review', fits: false, budget: { reservedBytes: 2097152, limitBytes: 1048576 }, approvalDigest: 'a'.repeat(64) };
  const html = renderToStaticMarkup(<RelayStorageReviewView plan={plan} busy={false} onApply={() => {}} onCancel={() => {}} />);
  expect(html).toContain('exceeds the proposed budget'); expect(html).toContain('The service stays stopped');
  expect(html.match(/disabled=""/g)).toHaveLength(1); expect(html).toContain('Cancel storage review'); expect(html).not.toContain(plan.approvalDigest);
});
it('shows retained and future locations as escaped text and preserves a limit change floor', () => {
  const plan: RelayStorageReview = { kind: 'desktop-storage-adoption-review', fits: true, approvalDigest: 'a'.repeat(64), existing: { observedBytes: 12,
    targets: [{ path: '/relay/<script>unsafe</script>', scope: 'directory' }] }, future: { targets: [{ path: '/relay/new-file', scope: 'file' }] }, reusable: null,
    reservedBytesAfterAdoption: 1024, limit: { limitBytes: 4096 } };
  const html = renderToStaticMarkup(<RelayStorageReviewView plan={plan} busy={false} onApply={() => {}} onCancel={() => {}} />);
  expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('(future output)');
  const limit: RelayStorageReview = { kind: 'desktop-storage-limit-review', approvalDigest: 'b'.repeat(64), limit: { previousLimitBytes: 10485760, limitBytes: 8388608, reservedBytes: 8388608 } };
  expect(renderToStaticMarkup(<RelayStorageReviewView plan={limit} busy={false} onApply={() => {}} onCancel={() => {}} />)).toContain('Preserve 8.00 MiB');
});
it('explains that adding a future location does not initialize history or grant more bytes', () => {
  const plan: RelayStorageReview = { kind: 'desktop-storage-scope-review', mode: 'new', targets: [{ path: '/later-role', scope: 'directory' }],
    observedBytes: 0, reservedBytes: 1048576, limitBytes: 2097152, fits: true, createsFiles: false, approvalDigest: 'a'.repeat(64) };
  const html = renderToStaticMarkup(<RelayStorageReviewView plan={plan} busy={false} onApply={() => {}} onCancel={() => {}} />);
  expect(html).toContain('creates no files and grants no extra bytes'); expect(html).toContain('Role setup and history validation remain separate'); expect(html).toContain('/later-role');
});
