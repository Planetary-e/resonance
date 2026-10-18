import { afterEach, beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { openHistoryVolunteerService } from '../../../relay/src/history-volunteer-service.js';
import { createRetainedHistoryCheckpointWriter } from '../../../relay/src/history-retained-writer.js';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { allocationAuthorityHistoryAnchor, deriveAdmissionAllocationAuthorityEncryptionKey } from '../admission-allocation-authority-state.js';
import { openProtectedAdmissionAllocationAuthority, readProtectedAllocationAuthorityRecoverySource } from '../protected-admission-allocation-authority.js';
import { PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FILENAME, openProtectedAllocationAuthorityRecovery, prepareProtectedAllocationAuthorityRecovery } from '../admission-allocation-authority-recovery.js';
import { prepareProtectedIssuerRecovery } from '../admission-issuer-recovery.js';
import { runProtectedAllocationAuthorityCommand, runProtectedAllocationAuthorityRecoveryCommand } from '../admission-allocation-authority-command.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
let issuerPublicKey: string;
beforeAll(() => { issuerPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(); });
function plan(epoch = 'one') {
  return { version: 2 as const, kind: 'admission-issuance-allocation' as const, claimPolicy: 'authority-assigned-v1' as const,
    community: 'public' as const, epoch, notBefore: Date.now() - 10000, issueUntil: Date.now() + 600000, totalTokenBudget: 2,
    allocations: [{ batchSize: 1, maxPermits: 2, profile: { version: 1 as const, scope: { issuer: 'allocator', community: 'public' as const, epoch },
      issuerPublicKey, relayUrls: ['ws://127.0.0.1:44010/'] } }] };
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'allocation-recovery-')), h = historyCheckpointFixture(), authorityKey = generateSigningKeyPair();
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => { authorityKey.secretKey.fill(0); h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url'), key = deriveAdmissionAllocationAuthorityEncryptionKey(authorityKey.secretKey, authority); cleanup.push(() => key.fill(0));
  const context = { ...h.context, role: 'admission-allocation-authority' as const, authority, policyDigest: allocationAuthorityHistoryAnchor(authority) };
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${47001 + i}/history-checkpoint` }));
  const services: ReturnType<typeof openHistoryVolunteerService>[] = []; let calls = 0;
  const service = (member: { publicKey: string }) => services[context.members.indexOf(member.publicKey)];
  const transport = async (member: { publicKey: string }, frame: unknown) => { calls++; return service(member).checkpoint(frame); };
  const options = { path: join(directory, 'owner.json'), authority, secretKey: authorityKey.secretKey, protection: { context, signingKey: h.owner, members, writerDirectory: join(directory, 'owner.json.history'), transport, timeoutMs: 10000 } };
  const ledger = await openProtectedAdmissionAllocationAuthority({ ...options, mode: 'create-new' }); cleanup.push(ledger.close);
  const genesis = ledger.enrollment().root; if (genesis.kind !== 'checkpoint') throw new Error('Original genesis required');
  for (let i = 0; i < 5; i++) {
    const volunteer = openHistoryVolunteerService({ directory: join(directory, `volunteer-${i}`), context, genesisId: historyCheckpointEnvelopeId(genesis), localKey: randomBytes(32), signingKey: h.memberKeys[i], initialize: genesis });
    services.push(volunteer); cleanup.push(volunteer.close);
  }
  const recoveryOptions = { directory: join(directory, 'recovery'), context, authority, genesis, members, encryptionKey: key, signingKey: h.owner, timeoutMs: 10000, transport,
    agreementTransport: async (member: { publicKey: string }, frame: unknown) => { calls++; return service(member).exchange(frame); },
    dataTransport: async (member: { publicKey: string }, frame: unknown) => { calls++; return service(member).transfer(frame); },
    provisionTransport: async (member: { publicKey: string }, frame: unknown) => { calls++; return service(member).provision(frame); } };
  return { directory, h, authorityKey, authority, key, context, members, ledger, genesis, options, recoveryOptions, services, calls: () => calls };
}
it('requires authentic role-specific source and review capabilities before creating or fencing', async () => {
  const n = await fixture(), source = await n.ledger.reviewRecoverySource(), calls = n.calls();
  await expect(prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source: structuredClone(source) })).rejects.toThrow('capability');
  await expect(prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source: undefined as never })).rejects.toThrow('explicit');
  await expect(prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source, domain: 'injected' } as never)).rejects.toThrow('fixed');
  await expect(prepareProtectedIssuerRecovery({ ...n.recoveryOptions, profile: {} as never, source: source as never })).rejects.toThrow('role');
  const review = await prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source });
  await expect(openProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, initialize: { review: structuredClone(review), approvedDigest: review.approvalDigest } })).rejects.toThrow('reviewed');
  await expect(openProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: 'wrong' } })).rejects.toThrow('reviewed');
  expect(existsSync(n.recoveryOptions.directory)).toBe(false); expect(n.calls()).toBeGreaterThanOrEqual(calls); expect(n.ledger.status().protection.fenced).toBe(false);
});
it('binds archive limits and keeps reopening status offline without recreating registered files', async () => {
  const n = await fixture(), review = await prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source: 'unavailable' });
  const different = await prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source: 'unavailable', maxArchiveBlocks: 100 });
  expect(different.approvalDigest).not.toBe(review.approvalDigest);
  let recovery = await openProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } });
  cleanup.push(() => recovery.close()); await recovery.advance(); const status = recovery.status(), count = n.calls(); recovery.close();
  recovery = await openProtectedAllocationAuthorityRecovery(n.recoveryOptions); expect(recovery.status()).toEqual(status); expect(n.calls()).toBe(count); recovery.close();
  await expect(openProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, maxArchiveBytes: 1234 })).rejects.toThrow('invalid');
  const journal = join(n.recoveryOptions.directory, PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FILENAME), bytes = readFileSync(journal);
  rmSync(join(n.recoveryOptions.directory, 'freeze', 'history-recovery.json'));
  await expect(openProtectedAllocationAuthorityRecovery(n.recoveryOptions)).rejects.toThrow('missing'); expect(readFileSync(journal)).toEqual(bytes); expect(n.calls()).toBe(count);
});
it('rejects signed history that erases a manifest before confirmation', async () => {
  const n = await fixture(); await n.ledger.ready(); const body = plan(), reviewPlan = await n.ledger.review(body); await n.ledger.sign(body, reviewPlan.approvalDigest);
  const current = readProtectedAllocationAuthorityRecoverySource(await n.ledger.reviewRecoverySource()).minimumEvidence.at(-1)!; n.ledger.close();
  const writer = createRetainedHistoryCheckpointWriter({ directory: n.options.protection.writerDirectory, context: n.context, localKey: n.key, signingKey: n.h.owner,
    rootId: historyCheckpointEnvelopeId(n.genesis), generation: 0, members: n.members, transport: n.recoveryOptions.transport, timeoutMs: 10000 }); cleanup.push(writer.close);
  const previous = writer.read().committed!.envelope;
  await writer.replicate(sealHistoryCheckpoint({ context: n.context, encryptionKey: n.key, signingKey: n.h.owner,
    header: { kind: 'checkpoint', generation: 0, sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous) }, plaintext: Buffer.from(JSON.stringify({ ...current, manifests: [] })) })); writer.close();
  const review = await prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source: 'unavailable' });
  const recovery = await openProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  await recovery.advance(); await recovery.advance(); await recovery.advance(); await expect(recovery.advance()).rejects.toThrow(/append|delete|immutable/);
  expect(recovery.status()).toMatchObject({ phase: 'download-and-confirm', complete: false }); expect(n.services.every(service => service.describe().latest.generation === 0)).toBe(true);
});
it('recovers manifests and claims while keeping restore, inspection and pristine resumption separate from readiness', async () => {
  const n = await fixture(); await n.ledger.ready(); const body = plan(), planned = await n.ledger.review(body), manifest = await n.ledger.sign(body, planned.approvalDigest);
  const request = { community: 'public' as const, epoch: 'one', claimHandle: randomBytes(32).toString('base64url'), issuerKeyFingerprint: admissionKeyFingerprint(issuerPublicKey) };
  const claimReview = await n.ledger.reviewAssignment(request), assignment = await n.ledger.assignClaim(request, claimReview.approvalDigest);
  const review = await prepareProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, source: await n.ledger.reviewRecoverySource() });
  const recovery = await openProtectedAllocationAuthorityRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  expect(n.ledger.status().protection.fenced).toBe(true);
  for (let i = 0; i < 16 && !recovery.status().complete; i++) await recovery.advance({ maxBlocks: 1 }); expect(recovery.status().complete).toBe(true);
  const destination = { path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored.json.history') }, count = n.calls();
  const { preparation } = await recovery.reviewRestore(destination);
  const restored = await openProtectedAdmissionAllocationAuthority({ ...n.options, path: destination.path, mode: 'create-new', protection: { ...n.options.protection, writerDirectory: destination.writerDirectory }, restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); cleanup.push(restored.close);
  expect(restored.current('public', 'one')).toEqual(manifest); expect(restored.currentAssignment('public', 'one', request.claimHandle)).toEqual(assignment); expect(restored.status().protection.ready).toBe(false); restored.close();
  expect((await recovery.inspectRestored(destination)).readiness).toBe('unverified'); expect(n.calls()).toBe(count);
  await expect(recovery.reviewResumption(destination, { secretKey: n.authorityKey.secretKey, maxArchiveBlocks: 10 })).rejects.toThrow('bounds differ');
  const resumption = await recovery.reviewResumption(destination, { secretKey: n.authorityKey.secretKey }); cleanup.push(resumption.close);
  const result = await resumption.apply(resumption.review().approvalDigest); expect(result.readiness).toBe('unverified'); expect(result.status.ready).toBe(false); expect(n.calls()).toBe(count);
}, 30000);
it('rejects invalid grammar, missing approvals and cancellation before reading operator files', async () => {
  for (const command of ['config', 'init', 'sign', 'assign', 'recovery-start', 'recovery-restore', 'recovery-resume']) await expect(runProtectedAllocationAuthorityCommand(command, Array.from({ length: 8 }, () => 'missing'))).rejects.toThrow('approval');
  for (const command of ['unknown', 'status', 'review', 'recovery-status']) await expect(runProtectedAllocationAuthorityCommand(command, [])).rejects.toThrow('Invalid');
  await expect(runProtectedAllocationAuthorityRecoveryCommand('sign', [])).rejects.toThrow('Invalid');
  const cancelled = new AbortController(); cancelled.abort(); await expect(runProtectedAllocationAuthorityCommand('status', ['a', 'b', 'c', 'd'], cancelled.signal)).rejects.toThrow('cancelled');
});
it('creates strict configurations and empty owners, with offline reviews and exclusive outputs', async () => {
  const n = await fixture(), config = join(n.directory, 'config.json'), publicFile = join(n.directory, 'authority.pub'), ownerKey = join(n.directory, 'owner-key.json'), secretFile = join(n.directory, 'authority-private.json'), members = join(n.directory, 'members.json');
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const keyJson = (key: typeof n.h.owner) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), secretKey: Buffer.from(key.secretKey).toString('base64url') });
  writeFileSync(publicFile, n.authority); write(ownerKey, keyJson(n.h.owner)); write(secretFile, keyJson(n.authorityKey)); write(members, n.members);
  await runProtectedAllocationAuthorityCommand('config', ['--approve', ownerKey, publicFile, members, config]);
  const owner = join(n.directory, 'command-owner.json'), enrollment = join(n.directory, 'enrollment.json'), common = [config, publicFile, secretFile, owner];
  await runProtectedAllocationAuthorityCommand('init', ['--approve', ...common, enrollment]);
  expect((await runProtectedAllocationAuthorityCommand('status', common)).result).toMatchObject({ manifestCount: 0, assignmentCount: 0, protection: { ready: false } });
  const planFile = join(n.directory, 'plan.json'); write(planFile, plan()); expect((await runProtectedAllocationAuthorityCommand('review', [...common, planFile])).result).toMatchObject({ result: 'allocation-plan-reviewed' });
  await expect(runProtectedAllocationAuthorityCommand('enrollment', [...common, enrollment])).rejects.toThrow();
  const value = JSON.parse(readFileSync(config, 'utf8')); write(config, { ...value, parser: 'injected' }); await expect(runProtectedAllocationAuthorityCommand('status', common)).rejects.toThrow('configuration');
});
