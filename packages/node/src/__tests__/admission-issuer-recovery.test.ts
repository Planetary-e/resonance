import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { admissionKeyFingerprint, admissionPolicyDigest } from '@resonance/core/admission-policy';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createRetainedHistoryCheckpointWriter } from '../../../relay/src/history-retained-writer.js';
import { prepareProtectedIssuerRecovery, openProtectedIssuerRecovery, PROTECTED_ISSUER_RECOVERY_FILENAME } from '../admission-issuer-recovery.js';
import { deriveAdmissionIssuerEncryptionKey } from '../admission-issuer-state.js';
import { openProtectedAdmissionIssuerLedger, readProtectedIssuerRecoverySource } from '../protected-admission-issuer-ledger.js';
import { runProtectedIssuerRecoveryCommand } from '../admission-issuer-recovery-command.js';
import { policyObserverFixture } from '../../../relay/src/__tests__/fixtures/policy-observer-fixture.js';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { openHistoryVolunteerService } from '../../../relay/src/history-volunteer-service.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await policyObserverFixture({ policyLifetimeMs: 600000, keyLifetimeMs: 300000 }); cleanup.push(f.close);
  const h = historyCheckpointFixture(), profile = f.first.keys[0].profile;
  cleanup.push(() => { h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); });
  const privateKey = await crypto.subtle.importKey('pkcs8', f.issuerPrivateKey.export({ type: 'pkcs8', format: 'der' }),
    { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  const key = await deriveAdmissionIssuerEncryptionKey(privateKey); cleanup.push(() => { key.fill(0); });
  const context = { ...h.context, role: 'admission-issuer' as const, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(f.first)}` };
  const allocation = await signAdmissionIssuanceAllocation({ version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1',
    community: 'public', epoch: 'one', notBefore: f.now - 1000, issueUntil: f.now + 100000, totalTokenBudget: 4,
    allocations: [{ profile, batchSize: 1, maxPermits: 4 }] }, f.authority, f.key.secretKey);
  const services: ReturnType<typeof openHistoryVolunteerService>[] = [];
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${42001 + i}/history-checkpoint` }));
  let calls = 0;
  const memberService = (member: { publicKey: string }) => services[context.members.indexOf(member.publicKey)];
  const transport = async (member: { publicKey: string }, frame: unknown) => { calls++; return memberService(member).checkpoint(frame); };
  const options = { path: join(f.directory, 'issuer.json'), expectedProfile: profile, privateKey, expectedAllocationAuthority: f.authority,
    protection: { context, signingKey: h.owner, members, writerDirectory: join(f.directory, 'writer'), transport, timeoutMs: 10000 } };
  const ledger = await openProtectedAdmissionIssuerLedger({ ...options, initialize: { allocation, communityPolicy: f.first, observers: f.context },
    protection: { ...options.protection, initializeWriter: true, initializeArchive: true } }); cleanup.push(ledger.close);
  const genesis = ledger.enrollment().root; if (genesis.kind !== 'checkpoint') throw new Error('Fixture needs original genesis');
  for (let i = 0; i < 5; i++) {
    const volunteer = openHistoryVolunteerService({ directory: join(f.directory, `volunteer-${i}`), context, genesisId: historyCheckpointEnvelopeId(genesis),
      localKey: randomBytes(32), signingKey: h.memberKeys[i], initialize: genesis }); services.push(volunteer); cleanup.push(volunteer.close);
  }
  const proof = () => {
    const { query } = ledger.preparePolicyObservation();
    return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const,
      votes: f.keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, f.context.genesis, f.context, key, Date.now())) } };
  };
  const assign = () => signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority: f.authority,
    allocationDigest: admissionIssuanceAllocationDigest(allocation), community: 'public', epoch: 'one', claimHandle: randomBytes(32).toString('base64url'),
    issuerKeyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey) }, allocation, f.authority, f.key.secretKey);
  const recoveryOptions = { directory: join(f.directory, 'recovery'), encryptionKey: key, signingKey: h.owner,
    context, genesis, profile, authority: f.authority, members, timeoutMs: 10000, transport,
    agreementTransport: async (member: { publicKey: string }, frame: unknown) => { calls++; return memberService(member).exchange(frame); },
    dataTransport: async (member: { publicKey: string }, frame: unknown) => { calls++; return memberService(member).transfer(frame); },
    provisionTransport: async (member: { publicKey: string }, frame: unknown) => { calls++; return memberService(member).provision(frame); } };
  return { ...f, context, genesis, profile, privateKey, key, services, members, ledger, options, proof, assign, recoveryOptions, calls: () => calls };
}
it('requires explicit source capability and matching reviewed scope before fencing or creating recovery state', async () => {
  const n = await fixture(); await n.ledger.ready();
  const source = await n.ledger.reviewRecoverySource(), before = n.calls();
  await expect(prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source: structuredClone(source) })).rejects.toThrow('capability');
  await expect(prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source: undefined as never })).rejects.toThrow('explicit');
  expect(n.calls()).toBe(before);
  const review = await prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source });
  for (const candidate of [structuredClone(review), review]) await expect(openProtectedIssuerRecovery({ ...n.recoveryOptions,
    initialize: { review: candidate, approvedDigest: candidate === review ? 'wrong' : review.approvalDigest } })).rejects.toThrow('reviewed');
  expect(existsSync(n.recoveryOptions.directory)).toBe(false);
  await n.ledger.grantForAssignment(await n.assign(), n.proof());
  await expect(openProtectedIssuerRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } })).rejects.toThrow('changed');
  expect(existsSync(n.recoveryOptions.directory)).toBe(false);
});
it('keeps status offline, rejects changed retained configuration and never recreates a missing registered artifact', async () => {
  const n = await fixture(); await n.ledger.ready();
  const review = await prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source: await n.ledger.reviewRecoverySource() });
  let recovery = await openProtectedIssuerRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } });
  cleanup.push(() => recovery.close()); await recovery.advance();
  const status = recovery.status(), count = n.calls(); recovery.close();
  recovery = await openProtectedIssuerRecovery(n.recoveryOptions); expect(recovery.status()).toEqual(status); expect(n.calls()).toBe(count); recovery.close();
  await expect(openProtectedIssuerRecovery({ ...n.recoveryOptions, maxReplayBlocks: 100 })).rejects.toThrow('invalid');
  const journal = join(n.recoveryOptions.directory, PROTECTED_ISSUER_RECOVERY_FILENAME), bytes = readFileSync(journal);
  rmSync(join(n.recoveryOptions.directory, 'freeze', 'history-recovery.json'));
  await expect(openProtectedIssuerRecovery(n.recoveryOptions)).rejects.toThrow('missing');
  expect(n.calls()).toBe(count); expect(readFileSync(journal)).toEqual(bytes);
});
it('authenticates selected issuer semantics before any confirmation or child provisioning', async () => {
  const n = await fixture(); await n.ledger.ready(); await n.ledger.grantForAssignment(await n.assign(), n.proof());
  const evidence = readProtectedIssuerRecoverySource(await n.ledger.reviewRecoverySource()), current = evidence.minimumEvidence.at(-1)!;
  n.ledger.close();
  // The history owner can authenticate ciphertext that volunteers cannot decrypt.
  // Recovery still must reject this erased permit before signing confirmations.
  const writer = createRetainedHistoryCheckpointWriter({ directory: n.options.protection.writerDirectory, context: n.context, localKey: n.key,
    signingKey: n.options.protection.signingKey, rootId: historyCheckpointEnvelopeId(n.genesis), generation: 0, members: n.members,
    transport: n.recoveryOptions.transport, timeoutMs: 10000 }); cleanup.push(writer.close);
  const previous = writer.read().committed!.envelope;
  const bad = sealHistoryCheckpoint({ context: n.context, encryptionKey: n.key, signingKey: n.options.protection.signingKey,
    header: { kind: 'checkpoint', generation: 0, sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous) },
    plaintext: Buffer.from(JSON.stringify({ ...current, entries: [] })) });
  await writer.replicate(bad); writer.close();
  const review = await prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source: 'unavailable' });
  const recovery = await openProtectedIssuerRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  await recovery.advance(); await recovery.advance(); await recovery.advance();
  await expect(recovery.advance()).rejects.toThrow(/deleted|reset/);
  expect(recovery.status()).toMatchObject({ phase: 'download-and-confirm', complete: false });
  expect(n.services.every(service => service.describe().latest.generation === 0)).toBe(true);
  await expect(recovery.reviewRestore({ path: join(n.directory, 'unsafe.json'), writerDirectory: join(n.directory, 'unsafe-writer') })).rejects.toThrow('not completed');
});
it('completes a confirmed generation while keeping restoration, inspection and resumption independent of readiness', async () => {
  const n = await fixture();
  const review = await prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source: await n.ledger.reviewRecoverySource() });
  const recovery = await openProtectedIssuerRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  for (let step = 0; step < 12 && !recovery.status().complete; step++) await recovery.advance({ maxBlocks: 1 });
  expect(recovery.status().complete).toBe(true);
  const count = n.calls(), destination = { path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored.history') };
  const { preparation } = await recovery.reviewRestore(destination); expect(n.calls()).toBe(count);
  const restored = await openProtectedAdmissionIssuerLedger({ ...n.options, path: destination.path,
    protection: { ...n.options.protection, writerDirectory: destination.writerDirectory, initializeWriter: true, initializeArchive: true },
    restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
  expect(restored.status().protection.ready).toBe(false); restored.close();
  const inspected = await recovery.inspectRestored(destination); expect(inspected.readiness).toBe('unverified'); expect(n.calls()).toBe(count);
  const resumption = await recovery.reviewResumption(destination, { privateKey: n.privateKey }); cleanup.push(resumption.close);
  const result = await resumption.apply(resumption.review().approvalDigest);
  expect(result.readiness).toBe('unverified'); expect(result.status.ready).toBe(false); expect(n.calls()).toBe(count);
}, 30000);
it('binds approval to the exact available owner and writer paths even for identical authenticated history copies', async () => {
  const n = await fixture(); await n.ledger.ready();
  const source = await n.ledger.reviewRecoverySource(), first = await prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source });
  n.ledger.close();
  const path = join(n.directory, 'copy.json'), writerDirectory = join(n.directory, 'copy.history');
  cpSync(n.options.path, path); cpSync(n.options.protection.writerDirectory, writerDirectory, { recursive: true });
  const copy = await openProtectedAdmissionIssuerLedger({ ...n.options, path, protection: { ...n.options.protection, writerDirectory } }); cleanup.push(copy.close);
  const second = await prepareProtectedIssuerRecovery({ ...n.recoveryOptions, source: await copy.reviewRecoverySource() });
  expect(first.localStateDigest).toBe(second.localStateDigest); expect(first.localSource?.path).toBe(realpathSync(n.options.path));
  expect(second.localSource?.path).toBe(realpathSync(path)); expect(first.approvalDigest).not.toBe(second.approvalDigest);
});
it.skipIf(process.platform === 'win32')('rejects a recovery workspace symlink retargeted after review', async () => {
  const n = await fixture(), first = join(n.directory, 'first-workspaces'), second = join(n.directory, 'second-workspaces'), alias = join(n.directory, 'workspace-link');
  mkdirSync(first); mkdirSync(second); symlinkSync(first, alias, 'dir');
  const options = { ...n.recoveryOptions, directory: join(alias, 'recovery') };
  const review = await prepareProtectedIssuerRecovery({ ...options, source: 'unavailable' });
  expect(review.directory).toBe(join(realpathSync(first), 'recovery'));  rmSync(alias); symlinkSync(second, alias, 'dir');
  const calls = n.calls();
  await expect(openProtectedIssuerRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } })).rejects.toThrow('reviewed');
  expect(n.calls()).toBe(calls); expect(existsSync(join(first, 'recovery'))).toBe(false); expect(existsSync(join(second, 'recovery'))).toBe(false);
});
it('rejects command grammar and missing write approval before reading any operator files', async () => {
  for (const command of ['recovery-start', 'recovery-restore', 'recovery-resume']) {
    await expect(runProtectedIssuerRecoveryCommand(command, Array.from({ length: 9 }, () => 'missing'))).rejects.toThrow('approval');
  }
  await expect(runProtectedIssuerRecoveryCommand('recovery-status', [])).rejects.toThrow('Invalid');
  const cancelled = new AbortController(); cancelled.abort();
  await expect(runProtectedIssuerRecoveryCommand('recovery-status', Array.from({ length: 7 }, () => 'missing'), cancelled.signal)).rejects.toThrow('cancelled');
});
