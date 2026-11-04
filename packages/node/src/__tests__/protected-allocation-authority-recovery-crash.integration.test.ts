import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { admissionIssuanceAllocationDigest } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE } from '../../../relay/src/protected-allocation-authority-history.js';
import { HISTORY_WRITER_FILENAME } from '../../../relay/src/history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../../../relay/src/history-writer-archive.js';
import { canonicalHistorySetupPath } from '../../../relay/src/admission-history-setup.js';
import { PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FILENAME, openProtectedAllocationAuthorityRecovery, prepareProtectedAllocationAuthorityRecovery } from '../admission-allocation-authority-recovery.js';
import { deriveAdmissionAllocationAuthorityEncryptionKey } from '../admission-allocation-authority-state.js';
import { openProtectedAdmissionAllocationAuthority } from '../protected-admission-allocation-authority.js';
import { protectedAllocationAuthorityFixture } from './fixtures/protected-allocation-authority-fixture.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Boundary = { name: string; mode: 'start' | 'advance' | 'restore'; prefix: number; nth: number; before?: boolean; target: 'fence' | 'journal' | 'owner' | 'writer' | 'archive' };
const boundaries: Boundary[] = [
  ...['fence', 'workspace'].flatMap(target => [true, false].map(before => ({ name: `${before ? 'before' : 'after'}-${target}`,
    mode: 'start' as const, prefix: 0, nth: 1, before, target: target === 'fence' ? 'fence' as const : 'journal' as const }))),
  ...(['freeze', 'agreement', 'download', 'provision'] as const).flatMap((name, i) => ['intent', 'register'].flatMap(stage => [true, false].map(before => ({
    name: `${before ? 'before' : 'after'}-${name}-${stage}`, mode: 'advance' as const, prefix: [0, 1, 2, 4][i],
    nth: stage === 'intent' ? 1 : 2, before, target: 'journal' as const })))),
  ...(['frozen', 'selected', 'confirmed', 'provisioned'] as const).map((name, i) => ({ name: `after-${name}`,
    mode: 'advance' as const, prefix: [0, 1, 3, 4][i], nth: i === 2 ? 1 : 3, target: 'journal' as const })),
  ...(['owner', 'writer', 'archive'] as const).map(target => ({ name: `after-restored-${target}`, mode: 'restore' as const, prefix: 5, nth: 1, target })),
];

it.each(boundaries)('preserves allocation and claim reservations across SIGKILL at $name', async boundary => {
  const n = await protectedAllocationAuthorityFixture(close => cleanup.push(close)); await n.journal.ready();
  const body = n.plan(), reviewed = await n.journal.review(body), manifest = await n.journal.sign(body, reviewed.approvalDigest);
  const firstRequest = n.request(), firstReview = await n.journal.reviewAssignment(firstRequest), first = await n.journal.assignClaim(firstRequest, firstReview.approvalDigest);
  const pendingRequest = n.request(), pendingReview = await n.journal.reviewAssignment(pendingRequest);
  n.online(3); await expect(n.journal.assignClaim(pendingRequest, pendingReview.approvalDigest)).rejects.toThrow();
  expect(n.journal.status().protection.pending).toBe(true); n.online(5);
  const expectedPending = await signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority: n.authority,
    allocationDigest: admissionIssuanceAllocationDigest(manifest), ...pendingRequest }, manifest, n.authority, n.authorityKey.secretKey);
  const encryptionKey = deriveAdmissionAllocationAuthorityEncryptionKey(n.authorityKey.secretKey, n.authority); cleanup.push(() => { encryptionKey.fill(0); });
  const recoveryOptions = { directory: join(n.directory, 'recovery'), context: n.context, genesis: n.genesis,
    authority: n.authority, signingKey: n.options.protection.signingKey, encryptionKey, members: n.members, timeoutMs: 10000 };
  const destination = { path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored.json.history') };
  if (boundary.mode !== 'start') {
    const review = await prepareProtectedAllocationAuthorityRecovery({ ...recoveryOptions, source: await n.journal.reviewRecoverySource() });
    const recovery = await openProtectedAllocationAuthorityRecovery({ ...recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } });
    try { for (let step = 0; step < boundary.prefix; step++) await recovery.advance({ maxBlocks: 10001 }); } finally { recovery.close(); }
  }
  n.journal.close();
  const targets = { fence: join(n.options.protection.writerDirectory, PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE),
    journal: join(recoveryOptions.directory, PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FILENAME), owner: destination.path,
    writer: join(destination.writerDirectory, HISTORY_WRITER_FILENAME), archive: join(destination.writerDirectory, 'payloads', HISTORY_WRITER_ARCHIVE_FILENAME) };
  const child = fork(new URL('./fixtures/protected-allocation-authority-recovery-crash.ts', import.meta.url), [],
    { execArgv: ['--no-addons', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' });
  const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', message => messages.push(message));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
  const { now: _, ...authorityOptions } = n.options, marker = join(n.directory, 'crash-marker');
  child.send({ ...boundary, boundary: boundary.name, target: canonicalHistorySetupPath(targets[boundary.target]), marker, authorityOptions, recoveryOptions, destination, now: 150 }); await exited;
  expect(messages).toEqual(['ready']); expect(readFileSync(marker, 'utf8')).toBe(boundary.name);
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL'); else expect(child.exitCode).not.toBe(0);
  const source = await openProtectedAdmissionAllocationAuthority(n.options); cleanup.push(source.close);
  expect(source.current('public', 'period-one')).toEqual(manifest);
  expect(source.currentAssignment('public', 'period-one', firstRequest.claimHandle)).toEqual(first);
  expect(source.status().protection.fenced).toBe(boundary.name !== 'before-fence');
  const published = existsSync(targets.journal), leftovers = existsSync(recoveryOptions.directory) ? readdirSync(recoveryOptions.directory) : [];
  const options = !published && leftovers.length ? { ...recoveryOptions, directory: join(n.directory, 'separate-workspace') } : recoveryOptions;
  const review = published ? undefined : await prepareProtectedAllocationAuthorityRecovery({ ...options, source: await source.reviewRecoverySource() });
  const resumed = await openProtectedAllocationAuthorityRecovery({ ...options, ...(review ? { initialize: { review, approvedDigest: review.approvalDigest } } : {}) }); cleanup.push(resumed.close);
  for (let step = 0; step < 12 && !resumed.status().complete; step++) await resumed.advance({ maxBlocks: 10001 });
  expect(resumed.status().complete).toBe(true); expect(source.status().protection.fenced).toBe(true);
  if (boundary.mode === 'restore') {
    const resumption = await resumed.reviewResumption(destination, { secretKey: n.authorityKey.secretKey });
    try { expect((await resumption.apply(resumption.review().approvalDigest)).readiness).toBe('unverified'); } finally { resumption.close(); }
  } else {
    const { preparation } = await resumed.reviewRestore(destination);
    const created = await openProtectedAdmissionAllocationAuthority({ ...n.options, path: destination.path, mode: 'create-new',
      protection: { ...n.options.protection, writerDirectory: destination.writerDirectory }, restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); created.close();
  }
  const restored = await openProtectedAdmissionAllocationAuthority({ ...n.options, path: destination.path,
    protection: { ...n.options.protection, writerDirectory: destination.writerDirectory } }); cleanup.push(restored.close);
  expect(restored.status()).toMatchObject({ manifestCount: 1, assignmentCount: 2, protection: { ready: false } });
  expect(restored.current('public', 'period-one')).toEqual(manifest);
  expect(restored.currentAssignment('public', 'period-one', firstRequest.claimHandle)).toEqual(first);
  expect(restored.currentAssignment('public', 'period-one', pendingRequest.claimHandle)).toEqual(expectedPending);
  await restored.ready(); const third = n.request(), thirdReview = await restored.reviewAssignment(third); await restored.assignClaim(third, thirdReview.approvalDigest);
  const fourth = n.request(), fourthReview = await restored.reviewAssignment(fourth); await expect(restored.assignClaim(fourth, fourthReview.approvalDigest)).rejects.toThrow(/exhaust|quota|capacity/i);
  if (!published && leftovers.length) expect(readdirSync(recoveryOptions.directory)).toEqual(leftovers);
}, 60000);
