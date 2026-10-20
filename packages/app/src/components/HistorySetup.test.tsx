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

it('describes owner limits as ciphertext capacity and keeps activation separate', () => {
  const html = render({ kind: 'owner-history-limits', approvalDigest: 'sha256:review', readiness: 'unverified', startsService: false,
    retainedBlocks: 2, retainedCiphertextBytes: 1048576, archiveBytes: 2097152, archiveBlocks: 4, pending: true });
  expect(html).toContain('2 retained archive blocks'); expect(html).toContain('MiB ciphertext'); expect(html).toContain('Pending ciphertext is preserved');
  const done = render({ result: 'owner-limits-configured', output: '/new-config.json', readiness: 'unverified', startsService: false });
  expect(done).toContain('Review owner activation'); expect(done).toContain('/new-config.json');
});

it('shows role retention and headroom before approval and refuses an undersized archive', () => {
  const result: RelayHistorySetupResult = { kind: 'admission-local-role-capture', approvalDigest: 'sha256:review', readiness: 'unverified', startsService: false,
    localRoles: ['witness', 'coordinator'], witnessVotes: 8, coordinatorCertificates: 4, witnessDenials: 2, coordinatorDenials: 3,
    fencedRoles: 1, fits: false, requiredBlocks: 2, requiredCiphertextBytes: 1048576, availableBlocks: 1, availableCiphertextBytes: 2097152 };
  const html = render(result);
  expect(html).toContain('8 witness decisions'); expect(html).toContain('4 coordinator certificates'); expect(html).toContain('5 permanent denials');
  expect(html).toContain('blocks the original local roles before saving their decisions'); expect(html).toContain('insufficient archive space'); expect(html).toContain('disabled');
  expect(render({ ...result, fits: true })).not.toContain('disabled');
  const done = render({ result: 'admission-roles-protected', readiness: 'confirmed', startsService: false });
  expect(done).toContain('four fresh copies'); expect(done).toContain('relay remains paused'); expect(done).not.toContain('Enrollment exported');
});

it('separates fresh public-key preparation from protected private-key export', () => {
  const base = { approvalDigest: 'sha256:review', readiness: 'unverified', startsService: false, selection: 'witness' } as const;
  const html = render({ ...base, kind: 'fresh-admission-role-setup', phase: 'preparing', publicKey: 'new-public' });
  expect(html).toContain('exports only its public key'); expect(html).toContain('Missing prepared history cannot be reset');
  expect(html).not.toContain('existing blocks remain retained'); expect(html).not.toContain('History context:');
  expect(render({ ...base, kind: 'protected-admission-role-key-export', publicKey: 'new-public' })).toContain('requires four fresh copies');
  expect(render({ result: 'fresh-admission-role-prepared', readiness: 'unverified', startsService: false })).toContain('Only its public key was exported');
  expect(render({ result: 'protected-admission-role-key-exported', readiness: 'confirmed', startsService: false })).toContain('relay remains paused');
});
