import { afterEach, expect, it } from 'vitest';
import { signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAdmissionPolicy, prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3, createResolvedAdmissionPolicyAdvance, type AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { captureHistoryAncestrySource } from '../../../relay/src/history-ancestry-source.js';
import { HISTORY_DOWNLOAD_FILENAME } from '../../../relay/src/history-ancestry-download.js';
import { openProtectedIssuerRecovery, prepareProtectedIssuerRecovery } from '../admission-issuer-recovery.js';
import { takePreparedProtectedIssuerAncestry } from '../admission-issuer-history-restore.js';
import { openProtectedAdmissionIssuerLedger } from '../protected-admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { protectedIssuerRestoreFixture } from './fixtures/protected-issuer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const limits: AdmissionPolicyArchiveLimits = { maxPages: 200, maxEntries: 1000, maxArchiveBytes: 64 * 1024 * 1024,
  maxHistoryBytes: 256 * 1024 * 1024, maxTransitions: 100, maxPageReads: 1000, timeoutMs: 3000 };

it('restores minimal real v3 through the CLI, then reopens funded original ancestry in fresh ordinary processes', async () => {
  const n = await protectedIssuerRestoreFixture(close => cleanup.push(close), { writerSibling: true }); await n.ledger.ready();
  const assignment = await n.assign(), permit = await n.ledger.grantForAssignment(assignment, n.proof()), batch = await createAdmissionIssuanceBatch(n.profile, 1);
  const response = await n.ledger.approve(permit, batch.request, n.proof());
  const second = await signAdmissionPolicy({ ...n.body, version: 2, revision: 2, archivedKeys: [] }, n.authority, n.authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(n.first, second, n.observerContext, n.authorityKey);
  await n.ledger.installPolicy(second, n.authority, { advance });
  await n.ledger.backfillPolicyProof({ version: 1, kind: 'genesis', policy: n.first }, limits);
  await n.ledger.backfillPolicyProof({ version: 1, kind: 'advance', advance, pages: [] });
  const reader = async () => { throw new Error('No earlier v3 pages'); };
  const previous = await resolveAdmissionPolicy({ context: n.observerContext, genesis: n.first, advances: [advance], selectedHead: advance.commitment.next, reader, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 3, issuedAt: second.issuedAt + 1, expiresAt: second.expiresAt,
    activeKey: second.activeKey, keys: second.keys }, reader, limits });
  const next = await createResolvedAdmissionPolicyAdvance({ previous, policy: await signAdmissionPolicyV3(plan.body, n.authority, n.authorityKey.secretKey), key: n.authorityKey,
    reader: async digest => { const page = plan.pages.find(page => page.digest === digest); if (!page) throw new Error('Missing page'); return page.bytes; }, limits });
  await n.ledger.installPolicy(next.advance.policy, n.authority, { advance: next.advance, pages: plan.pages });
  expect(next.advance.policy.version).toBe(3);
  n.ledger.close();
  const file = (name: string) => join(n.directory, name), json = (name: string, value: unknown) => { writeFileSync(file(name), JSON.stringify(value), { mode: 0o600 }); return file(name); };
  const signer = n.options.protection.signingKey;
  const owner = json('owner.json', { publicKey: Buffer.from(signer.publicKey).toString('base64url'), secretKey: Buffer.from(signer.secretKey).toString('base64url') });
  const configValue = { version: 1, context: n.context, members: n.members, ownerKeyFile: owner };
  const config = json('config.json', configValue), profile = json('profile.json', n.profile), enrollment = json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis });
  writeFileSync(file('private.pem'), n.issuerPrivateKey.export({ type: 'pkcs8', format: 'pem' })); writeFileSync(file('authority.pub'), n.authority);
  const env = { ...process.env }; delete env.RESONANCE_RELAY_STORAGE_SELECTION_FILE; delete env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE;
  const main = fileURLToPath(new URL('../../../../scripts/protected-admission-issuer.ts', import.meta.url));
  const run = async (command: string, args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['--no-addons', '--import', import.meta.resolve('tsx'), main, command, ...args], { cwd: n.directory, env, timeout: 45000 })).stdout);
  const common = [config, profile, file('private.pem'), n.options.path, file('authority.pub')], workspace = file('recovery'), base = [...common, enrollment, workspace];
  const review = await run('recovery-plan', [...base, 'available', '1']); await run('recovery-start', ['--approve', review.approvalDigest, ...base, 'available', '1']);
  let status = await run('recovery-status', base);
  for (let i = 0; i < 12 && !status.complete; i++) status = await run('recovery-step', base);
  expect(status.complete).toBe(true);
  const destination = file('restored.json');
  await expect(run('recovery-review', [...base, destination])).rejects.toThrow('explicitly selected');
  expect(existsSync(destination)).toBe(false); expect(existsSync(`${destination}.history`)).toBe(false);
  const fresh = [config, profile, file('private.pem'), destination, file('authority.pub')];
  const continuationFile = json('continuation.json', status.continuation), downloadDirectory = join(workspace, 'download');
  const authorityDirectory = file('funding');
  let funding = openStorageReservationAuthority({ directory: authorityDirectory, mode: 'create-new', limitBytes: 1024 ** 3 });
  const authorityId = funding.status().authorityId;
  const requests = [{ path: downloadDirectory, scope: 'directory' as const, component: 'history-download-ciphertext', maximumBytes: 252 * 1024 * 1024 },
    { path: join(downloadDirectory, HISTORY_DOWNLOAD_FILENAME), scope: 'file' as const, component: 'encrypted-local-state', maximumBytes: 4 * 1024 * 1024 + 8192 }];
  const selection = { version: 1 as const, kind: 'recovery-download' as const, directory: downloadDirectory, enrollmentFile: enrollment, continuationFile, funding: { authorityDirectory, authorityId } };
  const captured = captureHistoryAncestrySource(selection, config, n.context), before = funding.status();
  expect(() => withStorageReservationAuthority(funding, () => captured.open({ localKey: n.key, signingKey: signer, members: n.members }))).toThrow('reservation');
  expect(funding.status()).toEqual(before);
  funding.close(); json('config.json', { ...configValue, ancestry: selection });
  await expect(run('recovery-review', [...base, destination])).rejects.toThrow('reservation');
  funding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId, mode: 'open-existing' });
  expect(funding.status()).toEqual(before); expect(existsSync(destination)).toBe(false);
  funding.reserve(requests[0]);
  const ciphertextOnly = funding.status();
  expect(() => withStorageReservationAuthority(funding, () => captured.open({ localKey: n.key, signingKey: signer, members: n.members }))).toThrow('reservation');
  expect(funding.status()).toEqual(ciphertextOnly); expect(existsSync(destination)).toBe(false);
  funding.close();
  await expect(run('recovery-review', [...base, destination])).rejects.toThrow('reservation');
  funding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId, mode: 'open-existing' });
  expect(funding.status()).toEqual(ciphertextOnly); expect(existsSync(destination)).toBe(false);
  funding.reserve(requests[1]);
  const wrongFunding = captureHistoryAncestrySource({ ...selection, funding: { ...selection.funding, authorityId: '0'.repeat(32) } }, config, n.context);
  expect(() => withStorageReservationAuthority(funding, () => wrongFunding.open({ localKey: n.key, signingKey: signer, members: n.members }))).toThrow('funding');
  // A selected complete download cannot be replaced by an incomplete manifest, even when its next ciphertext is already cached.
  const manifestPath = join(downloadDirectory, HISTORY_DOWNLOAD_FILENAME), originalManifest = readFileSync(manifestPath);
  const manifest = openEncryptedLocalState<{ version: number; contextId: string; proposal: unknown; blocks: string[] }>({ path: manifestPath, key: n.key,
    domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: undefined!, validate: (value): value is { version: number; contextId: string; proposal: unknown; blocks: string[] } => !!value });
  const complete = manifest.read(); manifest.write({ ...complete, blocks: complete.blocks.slice(0, -1) }); manifest.close();
  const incomplete = captureHistoryAncestrySource(selection, config, n.context);
  const funded = funding.status();
  expect(() => withStorageReservationAuthority(funding, () => incomplete.open({ localKey: n.key, signingKey: signer, members: n.members }))).toThrow('incomplete');
  expect(funding.status()).toEqual(funded); writeFileSync(manifestPath, originalManifest);
  const blockPath = join(downloadDirectory, readdirSync(downloadDirectory).find(name => name.endsWith('.block'))!), block = readFileSync(blockPath);
  writeFileSync(blockPath, '{}');
  expect(() => withStorageReservationAuthority(funding, () => captured.open({ localKey: n.key, signingKey: signer, members: n.members }))).toThrow();
  expect(funding.status()).toEqual(funded); writeFileSync(blockPath, block);
  const originalEnrollment = readFileSync(enrollment); json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: status.continuation });
  expect(() => captureHistoryAncestrySource(selection, config, n.context)).toThrow('original'); writeFileSync(enrollment, originalEnrollment);
  if (n.genesis.kind !== 'checkpoint') throw new Error('Expected original genesis');
  const originalGenesis = n.genesis;
  const closedDestination = { path: file('closed-preparation.json'), writerDirectory: file('closed-preparation.json.history') };
  const closedParent = await withStorageReservationAuthority(funding, () => openProtectedIssuerRecovery({ directory: workspace, context: n.context, genesis: originalGenesis,
    profile: n.profile, authority: n.authority, signingKey: signer, encryptionKey: n.key, members: n.members, timeoutMs: 30000, ancestrySelection: captured, ancestryBinding: captured.binding }));
  const closedReview = await closedParent.reviewRestore(closedDestination); closedReview.preparation.close?.(); closedParent.close();
  await expect(withStorageReservationAuthority(funding, () => openProtectedAdmissionIssuerLedger({ ...n.options, path: closedDestination.path,
    protection: { ...n.options.protection, writerDirectory: closedDestination.writerDirectory, initializeWriter: true, initializeArchive: true },
    restore: { preparation: closedReview.preparation, approvedDigest: closedReview.preparation.review.approvalDigest } }))).rejects.toThrow('reviewed');
  expect(() => takePreparedProtectedIssuerAncestry(closedReview.preparation)).toThrow('closed');
  expect(existsSync(closedDestination.path)).toBe(false); expect(existsSync(closedDestination.writerDirectory)).toBe(false);
  // The independent source remains fixed; child owner/write paths are managed under the same explicit authority on startup.
  funding.close(); json('config.json', { ...configValue, ancestry: selection });
  const reviewed = await run('recovery-review', [...base, destination]);
  // Altering only the explicitly selected pin path invalidates the saved approval.
  const duplicatePin = json('continuation-copy.json', status.continuation);
  json('config.json', { ...configValue, ancestry: { ...selection, continuationFile: duplicatePin } });
  await expect(run('recovery-restore', ['--approve', reviewed.approvalDigest, ...base, destination])).rejects.toThrow('reviewed');
  expect(existsSync(destination)).toBe(false);
  json('config.json', { ...configValue, ancestry: selection });
  await run('recovery-restore', ['--approve', reviewed.approvalDigest, ...base, destination]);
  rmSync(`${destination}.history`, { recursive: true });
  const interrupted = await run('recovery-resume-plan', [...base, destination]);
  await run('recovery-resume', ['--approve', interrupted.approvalDigest, ...base, destination]);
  const legacy = json('legacy.json', configValue);
  await expect(run('status', [legacy, ...fresh.slice(1)])).rejects.toThrow();
  expect(await run('status', fresh)).toMatchObject({ completedPermits: 1, policyFreshness: { installedRevision: 3 }, protection: { ready: false } });
  n.online(3); await expect(run('ready', fresh)).rejects.toThrow(); n.online(4); await run('ready', fresh); n.online(5);
  await expect(run('plan-retirement', fresh)).rejects.toThrow('active issuer');
  const activeFunding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId, mode: 'open-existing' }); cleanup.push(activeFunding.close);
  const source = withStorageReservationAuthority(activeFunding, () => captured.open({ localKey: n.key, signingKey: signer, members: n.members })); cleanup.push(source.close);
  const retainedOwner = readFileSync(destination), retainedWriter = readdirSync(`${destination}.history`).sort();
  await expect(withStorageReservationAuthority(activeFunding, () => openProtectedAdmissionIssuerLedger({ ...n.options, path: destination,
    protection: { ...n.options.protection, writerDirectory: `${destination}.history`, ancestrySource: () => source.blocks(), expectedAncestry: { ...captured.expectedAncestry, rootId: `sha256:${'0'.repeat(64)}` } } }))).rejects.toThrow('immutable');
  expect(readFileSync(destination)).toEqual(retainedOwner); expect(readdirSync(`${destination}.history`).sort()).toEqual(retainedWriter);
  const restored = await withStorageReservationAuthority(activeFunding, () => openProtectedAdmissionIssuerLedger({ ...n.options, path: destination,
    protection: { ...n.options.protection, writerDirectory: `${destination}.history`, ancestrySource: () => source.blocks(), expectedAncestry: captured.expectedAncestry } }));
  await restored.ready(); expect(await restored.approve(permit, batch.request, n.proofFor(restored, next.advance.commitment.next))).toEqual(response);
  expect(await restored.grantForAssignment(assignment, n.proofFor(restored, next.advance.commitment.next))).toEqual(permit);
  // Generate a real, later certified continuation in a second complete workspace without funding that workspace.
  const otherWorkspace = file('other-recovery'), otherOptions = { directory: otherWorkspace, context: n.context, genesis: n.genesis, profile: n.profile,
    authority: n.authority, signingKey: signer, encryptionKey: n.key, members: n.members, timeoutMs: 30000 };
  const otherReview = await prepareProtectedIssuerRecovery({ ...otherOptions, source: await restored.reviewRecoverySource() });
  const other = await openProtectedIssuerRecovery({ ...otherOptions, initialize: { review: otherReview, approvedDigest: otherReview.approvalDigest } });
  for (let i = 0; i < 12 && !other.status().complete; i++) await other.advance({ maxBlocks: 10001 });
  expect(other.status().complete).toBe(true); const otherContinuation = other.status().continuation!; other.close();
  const unchangedFunding = activeFunding.status();
  await expect(withStorageReservationAuthority(activeFunding, () => openProtectedIssuerRecovery(otherOptions))).rejects.toThrow('reservation');
  expect(activeFunding.status()).toEqual(unchangedFunding);
  restored.close(); source.close(); activeFunding.close();
  const refusedDestination = file('wrong-workspace-owner.json'), otherBase = [...common, enrollment, otherWorkspace];
  await expect(run('recovery-review', [...otherBase, refusedDestination])).rejects.toThrow('actual recovery download');
  await expect(run('recovery-resume-plan', [...otherBase, destination])).rejects.toThrow('actual recovery download');
  expect(existsSync(refusedDestination)).toBe(false); expect(existsSync(`${refusedDestination}.history`)).toBe(false);
  let checkedFunding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId, mode: 'open-existing' });
  expect(checkedFunding.status()).toEqual(unchangedFunding); checkedFunding.close();
  const wrongContinuation = json('wrong-valid-continuation.json', otherContinuation);
  json('config.json', { ...configValue, ancestry: { ...selection, continuationFile: wrongContinuation } });
  await expect(run('recovery-review', [...base, refusedDestination])).rejects.toThrow('continuation differs');
  await expect(run('recovery-resume-plan', [...base, destination])).rejects.toThrow('continuation differs');
  expect(existsSync(refusedDestination)).toBe(false); expect(existsSync(`${refusedDestination}.history`)).toBe(false);
  checkedFunding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId, mode: 'open-existing' });
  expect(checkedFunding.status()).toEqual(unchangedFunding); checkedFunding.close();
  json('config.json', { ...configValue, ancestry: selection });
  await run('status', fresh); // Normal suffix growth retains this immutable source selection.

  const saved = readFileSync(continuationFile); writeFileSync(continuationFile, '{}');
  await expect(run('status', fresh)).rejects.toThrow(); writeFileSync(continuationFile, saved);
  rmSync(downloadDirectory, { recursive: true }); await expect(run('status', fresh)).rejects.toThrow();
}, 120000);

it('transfers authenticated recovery ancestry to the child across parent close and releases its lock on child close', async () => {
  const n = await protectedIssuerRestoreFixture(close => cleanup.push(close)); await n.ledger.ready();
  if (n.genesis.kind !== 'checkpoint') throw new Error('Expected original genesis');
  const options = { directory: join(n.directory, 'recovery'), context: n.context, genesis: n.genesis, profile: n.profile,
    authority: n.authority, signingKey: n.options.protection.signingKey, encryptionKey: n.key, members: n.members, timeoutMs: 10000 };
  const review = await prepareProtectedIssuerRecovery({ ...options, source: await n.ledger.reviewRecoverySource() });
  const parent = await openProtectedIssuerRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(parent.close);
  for (let i = 0; i < 12 && !parent.status().complete; i++) await parent.advance({ maxBlocks: 10001 });
  const destination = { path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored.json.history') };
  const { preparation } = await parent.reviewRestore(destination); parent.close();
  const restored = await openProtectedAdmissionIssuerLedger({ ...n.options, path: destination.path,
    protection: { ...n.options.protection, writerDirectory: destination.writerDirectory, initializeWriter: true, initializeArchive: true },
    restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
  expect(() => takePreparedProtectedIssuerAncestry(preparation)).toThrow('consumed'); preparation.close?.();
  await restored.ready(); restored.close();
  const reopened = await openProtectedIssuerRecovery(options); cleanup.push(reopened.close);
  const child = await reopened.reviewResumption(destination, { privateKey: n.privateKey }); reopened.close();
  await child.apply(child.review().approvalDigest); child.close();
  const final = await openProtectedIssuerRecovery(options); final.close();
}, 45000);
