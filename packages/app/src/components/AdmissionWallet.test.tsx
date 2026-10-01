import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviousWallets } from './AdmissionWallet.js';
import type { AdmissionWalletRetirementPlan, AdmissionWalletStatus } from '../api.client.js';
vi.mock('../api.client', () => ({}));
const scope = { issuer: 'Volunteer community', community: 'public', epoch: 'old period' };
const key = 'sha256:' + 'a'.repeat(64);
const prior: AdmissionWalletStatus['archived'][number] = { scope, keyFingerprint: key, available: 3, reserved: 1, canRetire: true, permanentlyRetired: false };
const plan: AdmissionWalletRetirementPlan = { kind: 'admission-wallet-retirement', issuerKey: key, scope, authorityFingerprint: key,
  policyRevision: 2, policyDigest: 'b'.repeat(64), retryUntil: 100000, tokensRemoved: 4, unusedTokensRemoved: 3, reservationsRemoved: 1, denialMarkersRetained: 1,
  approvalDigest: 'sha256:' + 'c'.repeat(64) };
function render(archived = [prior], reviewed: AdmissionWalletRetirementPlan | null = null, busy = false) {
  return renderToStaticMarkup(<PreviousWallets archived={archived} plan={reviewed} busy={busy} onReview={() => {}} onApply={() => {}} onCancel={() => {}} />);
}
it('requires explicit review before destructive cleanup and explains consequences without exposing internal approval data', () => {
  expect(render()).toContain('Review cleanup'); expect(render()).not.toContain('Permanently close old wallet');
  const html = render([prior], plan);
  for (const text of ['4 tokens', '3 unused tokens', '1 reservation', 'cannot be undone', 'cannot consume replacement tokens', 'does not free a setup slot', 'Cancel cleanup', 'automatic mailbox setting stay unchanged']) expect(html).toContain(text);
  expect(html).not.toContain(plan.approvalDigest); expect(html).not.toContain(plan.policyDigest);
  expect(render([prior], plan, true).match(/disabled=""/g)).toHaveLength(3);
});
it('offers no cleanup for ineligible or already closed wallets and shows retained prevention counts', () => {
  expect(render([{ ...prior, canRetire: false }])).not.toContain('Review cleanup');
  const html = render([{ ...prior, canRetire: false, permanentlyRetired: true, available: 0, reserved: 0, tokensRemoved: 4, reservationsRemoved: 1 }]);
  expect(html).toContain('Permanently closed'); expect(html).toContain('4 tokens removed'); expect(html).toContain('1 old reservation remains blocked');
  expect(html).not.toContain('Review cleanup'); expect(render([])).toBe('');
});
