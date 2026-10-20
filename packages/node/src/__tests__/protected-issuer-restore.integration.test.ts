import { afterEach, expect, it, vi } from 'vitest';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateKeyPairSync } from 'node:crypto';
import { admissionKeyFingerprint, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { protectedIssuerRestoreFixture } from './fixtures/protected-issuer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

it('recovers exact issuer obligations through two real volunteer recoveries after owner/archive loss', async () => {
  const n = await protectedIssuerRestoreFixture(close => cleanup.push(close)); await n.ledger.ready();
  const completedAssignment = await n.assign(), completedPermit = await n.ledger.grantForAssignment(completedAssignment, n.proof());
  const completedBatch = await createAdmissionIssuanceBatch(n.profile, 1), completedResponse = await n.ledger.approve(completedPermit, completedBatch.request, n.proof());
  expect(await completedBatch.finalize(completedResponse)).toHaveLength(1);
  const preparedAssignment = await n.assign(), preparedPermit = await n.ledger.grantForAssignment(preparedAssignment, n.proof());
  const preparedBatch = await createAdmissionIssuanceBatch(n.profile, 1), original = publicVerif.Issuer.prototype.issue;
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockImplementation(async function (this: InstanceType<typeof publicVerif.Issuer>, ...args) {
    const result = await Reflect.apply(original, this, args); n.clock(n.now + 5000); return result;
  });
  await expect(n.ledger.approve(preparedPermit, preparedBatch.request, n.proof())).rejects.toThrow('observation expired');
  signing.mockImplementation(original);
  const unresolvedPermit = await n.ledger.grantForAssignment(await n.assign(), n.proof()), unresolvedBatch = await createAdmissionIssuanceBatch(n.profile, 1);
  const observation = n.proof(); n.online(3);
  await expect(n.ledger.approve(unresolvedPermit, unresolvedBatch.request, observation)).rejects.toThrow();
  n.online(5); await n.ledger.ready();
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 3, boundPermits: 3, preparedPermits: 1, completedPermits: 1 });
  // A newer signed observation is durable even though it denies this grant.
  await expect(n.ledger.grantForAssignment(completedAssignment, n.proof(n.advance.commitment.next))).rejects.toThrow('newer');
  const first = await n.recover();
  expect(first.receipts).toHaveLength(4); expect(first.downloadStatus.complete).toBe(true);
  await expect(n.ledger.ready()).rejects.toThrow(); // Frozen original writer cannot obtain a new serving quorum.
  n.loseOwner(); const review = await first.restore();
  expect(review.review).toMatchObject({ generations: 1, generation: 1, allocatedPermits: 3, preparedPermits: 1, completedPermits: 1, observedRevision: 2 });
  expect(n.ledger.status().protection.ready).toBe(false); expect(() => n.proof()).toThrow('readiness');
  n.online(3); await expect(n.ledger.ready()).rejects.toThrow();
  // Failed readiness persists the exact continuation; reopening is offline and cannot substitute a genesis.
  await n.reopen(); expect(n.ledger.status().protection.ready).toBe(false); n.online(5); await n.ledger.ready();
  expect(n.ledger.status().policyFreshness?.observedRevision).toBe(2);
  await n.ledger.installPolicy(n.second, n.authority, { advance: n.advance });
  const head = n.advance.commitment.next;
  expect(await n.ledger.grantForAssignment(completedAssignment, n.proof(head))).toEqual(completedPermit);
  expect(await n.ledger.approve(completedPermit, completedBatch.request, n.proof(head))).toEqual(completedResponse);
  const preparedResponse = await n.ledger.approve(preparedPermit, preparedBatch.request, n.proof(head));
  expect(await preparedBatch.finalize(preparedResponse)).toHaveLength(1);
  await expect(n.ledger.approve(unresolvedPermit, unresolvedBatch.request, n.proof(head))).rejects.toThrow('unresolved');
  n.ledger.cancelPolicyObservation();
  const fourthAssignment = await n.assign(), fourthPermit = await n.ledger.grantForAssignment(fourthAssignment, n.proof(head));
  const fourthBatch = await createAdmissionIssuanceBatch(n.profile, 1), fourthResponse = await n.ledger.approve(fourthPermit, fourthBatch.request, n.proof(head));
  expect(signing).toHaveBeenCalledTimes(2); // Only the original prepared response and the new fourth batch.
  n.loseOwner(); const second = await n.recover(); const secondReview = await second.restore();
  expect(secondReview.review).toMatchObject({ generation: 2, generations: 2, allocatedPermits: 4, boundPermits: 4, completedPermits: 3 });
  expect(second.blocks.some(block => block.kind === 'continuation')).toBe(true);
  expect(second.blocks.length).toBeGreaterThan(first.blocks.length);
  await n.ledger.ready();
  for (const [permit, batch, response] of [[completedPermit, completedBatch, completedResponse], [preparedPermit, preparedBatch, preparedResponse], [fourthPermit, fourthBatch, fourthResponse]] as const) {
    expect(await n.ledger.approve(permit, batch.request, n.proof(head))).toEqual(response);
  }
  await expect(n.ledger.approve(unresolvedPermit, unresolvedBatch.request, n.proof(head))).rejects.toThrow('unresolved'); n.ledger.cancelPolicyObservation();
  await expect(n.ledger.grantForAssignment(await n.assign(), n.proof(head))).rejects.toThrow('exhausted');
  expect(signing).toHaveBeenCalledTimes(2);
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 4, remainingPermits: 0, boundPermits: 4, preparedPermits: 0, completedPermits: 3 });
}, 120000);

it('restores permanent retirement and lifetime totals without reviving an expired issuer', async () => {
  const n = await protectedIssuerRestoreFixture(close => cleanup.push(close)); await n.ledger.ready();
  await n.ledger.grantForAssignment(await n.assign(), n.proof());
  const replacement = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nextProfile = { ...n.profile, scope: { ...n.profile.scope, issuer: 'replacement' },
    issuerPublicKey: replacement.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const nextPolicy = await signAdmissionPolicy({ ...n.body, revision: 2, activeKey: admissionKeyFingerprint(nextProfile.issuerPublicKey),
    keys: [...n.body.keys, { ...n.body.keys[0], profile: nextProfile }] }, n.authority, n.authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(n.first, nextPolicy, n.observerContext, n.authorityKey);
  await n.ledger.installPolicy(nextPolicy, n.authority, { advance }); n.clock(n.now + 300000);
  const retirement = n.ledger.planRetirement(n.authority); await n.ledger.retire(n.authority, retirement.approvalDigest);
  n.loseOwner(); const recovery = await n.recover(); n.clock(n.now + 700000);
  const review = await recovery.restore(); expect(review.review).toMatchObject({ permanentlyRetired: true, allocatedPermits: 1, preparedPermits: 0 });
  await n.ledger.ready(); expect(n.ledger.status()).toMatchObject({ permanentlyRetired: true, retainedEntries: 0, allocatedPermits: 1, remainingPermits: 0 });
  await expect(n.ledger.grantForAssignment(await n.assign())).rejects.toThrow('retired');
  await n.reopen(); expect(n.ledger.status().permanentlyRetired).toBe(true);
}, 60000);
