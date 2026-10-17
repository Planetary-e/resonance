import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistorySetupReview } from './HistorySetup';
import type { RelayHistorySetupResult } from '../history-setup.types';
vi.mock('../api.client', () => ({}));
const render = (result: RelayHistorySetupResult, busy = false) => renderToStaticMarkup(<HistorySetupReview result={result} busy={busy} onApply={() => {}} />);
it('distinguishes offline enrollment from fresh-copy readiness and later activation', () => {
  const base = { approvalDigest: 'sha256:review', readiness: 'unverified', startsService: false } as const;
  const volunteer = render({ ...base, kind: 'history-volunteer-enrollment', owner: 'owner', member: 'member', contextId: 'context', genesisId: 'genesis',
    maximumGenerations: 65, generationByteLimit: 67108864, ancestryByteLimit: 268435456 });
  expect(volunteer).toContain('This review is offline'); expect(volunteer).toContain('does not establish four-copy readiness');
  expect(volunteer).toContain('filesystem overhead are additional');
  expect(render({ ...base, kind: 'admission-initial-readiness' })).toContain('requires four fresh copies before activation');
  expect(render({ ...base, kind: 'owner-history-setup' }, true)).toContain('disabled');
  const done = render({ result: 'history-ready', readiness: 'confirmed', startsService: false });
  expect(done).toContain('relay remains paused'); expect(done).not.toContain('Approve');
});

it('explains interrupted volunteer resumption without offering a missing-history reset', () => {
  const html = render({ kind: 'history-volunteer-resumption', phase: 'genesis-pending', approvalDigest: 'sha256:review', readiness: 'unverified', startsService: false });
  expect(html).toContain('finishes the original enrollment'); expect(html).toContain('missing or corrupt manifest cannot be recreated');
  expect(html).toContain('relay stays paused');
  expect(render({ result: 'enrollment-resumed', readiness: 'unverified', startsService: false })).toContain('Activate enrolled volunteer');
});
