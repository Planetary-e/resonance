import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { admissionIssuanceAllocationDigest } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { protectedAllocationAuthorityRestoreFixture } from './fixtures/protected-allocation-authority-restore-fixture.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('preserves plans, pending claims and capacity through two authenticated recoveries including complete local loss and expiry', async () => {
  const n = await protectedAllocationAuthorityRestoreFixture(close => cleanup.push(close)); await n.journal.ready();
  const plan = n.plan(), review = await n.journal.review(plan), manifest = await n.journal.sign(plan, review.approvalDigest);
  const first = n.request(), firstReview = await n.journal.reviewAssignment(first), assigned = await n.journal.assignClaim(first, firstReview.approvalDigest);
  const second = n.request(), secondReview = await n.journal.reviewAssignment(second);
  const pending = await signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority: n.authority,
    allocationDigest: admissionIssuanceAllocationDigest(manifest), ...second }, manifest, n.authority, n.authorityKey.secretKey);
  n.online(3); await expect(n.journal.assignClaim(second, secondReview.approvalDigest)).rejects.toThrow('Four');
  expect(n.journal.currentAssignment('public', 'period-one', second.claimHandle)).toBeUndefined(); n.online(4);
  const recovered = await n.recover(true);
  expect(recovered.minimumEvidence).toHaveLength(2); expect(recovered.preparation.review).toMatchObject({ generation: 1, manifests: 1, assignments: 2 });
  expect(n.journal.status()).toMatchObject({ manifestCount: 1, assignmentCount: 2, protection: { ready: false } });
  n.online(3); await expect(n.journal.ready()).rejects.toThrow('Four'); n.online(5); await n.journal.ready();
  expect(n.journal.current('public', 'period-one')).toEqual(manifest);
  expect(await n.journal.assignClaim(first, firstReview.approvalDigest)).toEqual(assigned);
  expect(await n.journal.assignClaim(second, secondReview.approvalDigest)).toEqual(pending);
  const third = n.request(), thirdReview = await n.journal.reviewAssignment(third), finalAssignment = await n.journal.assignClaim(third, thirdReview.approvalDigest);
  const overQuota = n.request(), overReview = await n.journal.reviewAssignment(overQuota);
  await expect(n.journal.assignClaim(overQuota, overReview.approvalDigest)).rejects.toThrow('exhausted');
  const lost = n.currentOptions; n.loseOwner(); expect(existsSync(lost.path)).toBe(false); expect(existsSync(lost.protection.writerDirectory)).toBe(false); n.clock(300);
  const again = await n.recover(false); expect(again.replay.generations).toBe(2);
  expect(again.preparation.review).toMatchObject({ generation: 2, manifests: 1, assignments: 3 });
  expect(n.journal.status().protection.ready).toBe(false); await n.journal.ready(); await n.reopen();
  expect(n.journal.status().protection.ready).toBe(false); expect(await n.journal.sign(plan, review.approvalDigest)).toEqual(manifest);
  for (const [request, approved, expected] of [[first, firstReview, assigned], [second, secondReview, pending], [third, thirdReview, finalAssignment]] as const) {
    expect(n.journal.currentAssignment('public', 'period-one', request.claimHandle)).toEqual(expected);
    expect(await n.journal.assignClaim(request, approved.approvalDigest)).toEqual(expected);
  }
  await n.journal.ready(); await expect(n.journal.assignClaim(overQuota, overReview.approvalDigest)).rejects.toThrow('exhausted');
  const conflict = n.request(first.claimHandle, 1), conflictReview = await n.journal.reviewAssignment(conflict);
  await expect(n.journal.assignClaim(conflict, conflictReview.approvalDigest)).rejects.toThrow('different issuer');
  const replacement = { ...plan, totalTokenBudget: 5 }, replaceReview = await n.journal.review(replacement);
  await expect(n.journal.sign(replacement, replaceReview.approvalDigest)).rejects.toThrow('Conflicting');
  const fresh = n.plan('later'), freshReview = await n.journal.review(fresh);
  await expect(n.journal.sign(fresh, freshReview.approvalDigest)).rejects.toThrow('not current');
}, 60000);
