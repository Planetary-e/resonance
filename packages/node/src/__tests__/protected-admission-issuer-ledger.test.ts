import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, admissionPolicyDigest, signAdmissionPolicy, type AdmissionWalletProfileV1 } from '@resonance/core/admission-policy';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';
import { createHistoryFreeze, historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryAgreementReplica } from '../../../relay/src/history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../../../relay/src/history-agreement-coordinator.js';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from '../../../relay/src/history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../../../relay/src/history-writer-archive.js';
import { withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { MAX_PROTECTED_ISSUER_HISTORY_BYTES } from '@resonance/relay/protected-issuer-history';
import { DOMAIN, deriveAdmissionIssuerEncryptionKey } from '../admission-issuer-state.js';
import { openProtectedIssuerRestoreResumption } from '../admission-issuer-restore-resumption.js';
import { prepareProtectedIssuerRestore } from '../admission-issuer-history-restore.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../../../relay/src/history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../../../relay/src/history-checkpoint-store.js';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { openProtectedAdmissionIssuerLedger, readProtectedIssuerRecoverySource, fenceProtectedIssuerRecoverySource, type ProtectedIssuerRecoverySource, type ProtectedAdmissionIssuerLedger } from '../protected-admission-issuer-ledger.js';
import type { PreparedProtectedIssuerRestore } from '../admission-issuer-history-restore.js';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
let pairs: CryptoKeyPair[], profiles: AdmissionWalletProfileV1[];
beforeAll(async () => {
  pairs = await Promise.all([0, 1].map(() => publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) })));
  profiles = await Promise.all(pairs.map(async (pair, index) => ({ version: 1 as const, scope: { issuer: `protected-${index}`, community: 'public' as const, epoch: 'one' },
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45111/'] })));
});
async function fixture(limits: { maxArchiveBlocks?: number } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'protected-issuer-'))), h = historyCheckpointFixture();
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authorityKey = generateSigningKeyPair(), authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const observers = Array.from({ length: 5 }, generateSigningKeyPair);
  cleanup.push(() => { authorityKey.secretKey.fill(0); observers.forEach(key => key.secretKey.fill(0)); h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); });
  let now = Date.now(), online = 5, calls = 0, failedSequence: number | undefined;
  const start = now, body = { version: 1 as const, kind: 'admission-policy' as const, revision: 1, issuedAt: start - 1000, expiresAt: start + 100000,
    activeKey: admissionKeyFingerprint(profiles[0].issuerPublicKey), keys: profiles.map(profile => ({ profile, notBefore: start - 1000, issueUntil: start + 10000, spendUntil: start + 20000, retryUntil: start + 30000 })) };
  const policy = await signAdmissionPolicy(body, authority, authorityKey.secretKey);
  const allocation = await signAdmissionIssuanceAllocation({ version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1',
    community: 'public', epoch: 'one', notBefore: start - 1000, issueUntil: start + 10000, totalTokenBudget: 2,
    allocations: [{ profile: profiles[0], batchSize: 1, maxPermits: 2 }] }, authority, authorityKey.secretKey);
  const observerContext = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(policy), quorum: 4,
    members: observers.map((key, index) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${34001 + index}/` })) });
  const context = { ...h.context, role: 'admission-issuer' as const, authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const members = context.members.map((publicKey, index) => ({ publicKey, endpoint: `ws://127.0.0.1:${35001 + index}/` }));
  const roles: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
  const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame) => {
    calls++; const index = context.members.indexOf(member.publicKey);
    if (index >= online || failedSequence !== undefined && frame.envelope && frame.envelope.sequence >= failedSequence && index >= 3) throw new Error('offline');
    return roles[index].exchange(frame);
  };
  const options = { path: join(directory, 'issuer.json'), expectedProfile: profiles[0], privateKey: pairs[0].privateKey, expectedAllocationAuthority: authority, now: () => now,
    protection: { context, signingKey: h.owner, members, writerDirectory: join(directory, 'writer'), transport, timeoutMs: 2000, ...limits } };
  let ledger = await openProtectedAdmissionIssuerLedger({ ...options, initialize: { allocation, communityPolicy: policy, observers: observerContext },
    protection: { ...options.protection, initializeWriter: true, initializeArchive: true } });
  cleanup.push(() => ledger.close()); expect(calls).toBe(0);
  const { root } = ledger.enrollment();
  for (let index = 0; index < 5; index++) {
    const store = openHistoryCheckpointStore({ directory: join(directory, `replica-${index}`), context, replica: context.members[index], localKey: h.localKey,
      rootId: historyCheckpointEnvelopeId(root), generation: 0, initialize: root });
    stores.push(store); cleanup.push(() => store.close()); const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[index] });
    roles.push(role); cleanup.push(() => role.close());
  }
  const proof = (head: AdmissionPolicyHead = observerContext.genesis) => {
    const { query } = ledger.preparePolicyObservation();
    return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const,
      votes: observers.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, observerContext, key, now)) } };
  };
  const assign = (claimHandle = randomBytes(32).toString('base64url')) => signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority,
    allocationDigest: admissionIssuanceAllocationDigest(allocation), community: 'public', epoch: 'one', claimHandle, issuerKeyFingerprint: admissionKeyFingerprint(profiles[0].issuerPublicKey) }, allocation, authority, authorityKey.secretKey);
  return { directory, authority, authorityKey, start, body, policy, allocation, observerContext, options, assign, proof, h, stores, roles, get ledger() { return ledger; },
    get calls() { return calls; }, failAt(sequence: number | undefined) { failedSequence = sequence; }, online(count: number) { online = count; }, clock(value: number) { now = value; },
    async reopen(ready = true) { ledger.close(); ledger = await openProtectedAdmissionIssuerLedger(options); if (ready) await ledger.ready(); return ledger; } };
}

it('requires explicit fresh quorum, protects the same local file and retains exact assignment quota across restart', async () => {
  const n = await fixture(), assignment = await n.assign();
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 0, protection: { ready: false } });
  await expect(n.ledger.grantForAssignment(assignment)).rejects.toThrow('readiness');
  n.online(3); await expect(n.ledger.ready()).rejects.toThrow();
  n.online(5); await n.ledger.ready();
  const permit = await n.ledger.grantForAssignment(assignment, n.proof());
  await n.reopen(false); expect(() => n.proof()).toThrow('readiness'); await n.ledger.ready();
  expect(await n.ledger.grantForAssignment(assignment, n.proof())).toEqual(permit);
  await n.ledger.grantForAssignment(await n.assign(), n.proof());
  await expect(n.ledger.grantForAssignment(await n.assign(), n.proof())).rejects.toThrow('exhausted');
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 2, remainingPermits: 0 }); n.ledger.close();
  await expect(openAdmissionIssuerLedger({ path: n.options.path, expectedProfile: profiles[0], privateKey: pairs[0].privateKey })).rejects.toThrow();
});

it('never starts signing without durable binding quorum, and refuses to re-sign an unresolved reservation after restart', async () => {
  const n = await fixture(); await n.ledger.ready(); const permit = await n.ledger.grantForAssignment(await n.assign(), n.proof());
  const batch = await createAdmissionIssuanceBatch(profiles[0], 1), proof = n.proof(), signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  n.online(3); await expect(n.ledger.approve(permit, batch.request, proof)).rejects.toThrow(); expect(signing).not.toHaveBeenCalled();
  expect(n.ledger.status()).toMatchObject({ protection: { ready: false, pending: true } });
  n.online(5); await n.reopen();
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow('unresolved'); expect(signing).not.toHaveBeenCalled();
  n.ledger.cancelPolicyObservation();
  const other = await createAdmissionIssuanceBatch(profiles[0], 1);
  await expect(n.ledger.approve(permit, other.request)).rejects.toThrow('already bound');
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 1, boundPermits: 1, preparedPermits: 0, completedPermits: 0 });
});

it('replicates produced signatures despite observation expiry and resumes prepared/completed replies without signing again', async () => {
  const n = await fixture(); await n.ledger.ready(); const assignment = await n.assign(), permit = await n.ledger.grantForAssignment(assignment, n.proof());
  const batch = await createAdmissionIssuanceBatch(profiles[0], 1), original = publicVerif.Issuer.prototype.issue;
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockImplementation(async function (this: InstanceType<typeof publicVerif.Issuer>, ...args) {
    const result = await Reflect.apply(original, this, args); n.clock(n.start + 5000); return result;
  });
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow('observation expired');
  expect(n.ledger.status()).toMatchObject({ preparedPermits: 1, completedPermits: 0, boundPermits: 1 });
  await n.reopen();
  const response = await n.ledger.approve(permit, batch.request, n.proof()); expect(await batch.finalize(response)).toHaveLength(1);
  expect(signing).toHaveBeenCalledTimes(1); expect(n.ledger.status()).toMatchObject({ preparedPermits: 0, completedPermits: 1 });
  await n.reopen(); n.clock(n.start + 10000);
  expect(await n.ledger.grantForAssignment(assignment, n.proof())).toEqual(permit);
  expect(await n.ledger.approve(permit, batch.request, n.proof())).toEqual(response); expect(signing).toHaveBeenCalledTimes(1);
});

it('preflights space for both durable responses before signing', async () => {
  const n = await fixture({ maxArchiveBlocks: 4 }); await n.ledger.ready();
  const permit = await n.ledger.grantForAssignment(await n.assign(), n.proof()), batch = await createAdmissionIssuanceBatch(profiles[0], 1);
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow('capacity');
  expect(signing).not.toHaveBeenCalled(); expect(n.ledger.status().completedPermits).toBe(0);
});

it('protects newer policy floors and conflict fences even when issuance is denied', async () => {
  const n = await fixture(); await n.ledger.ready(); const assignment = await n.assign();
  const successor = await signAdmissionPolicy({ ...n.body, revision: 2 }, n.authority, n.authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(n.policy, successor, n.observerContext, n.authorityKey);
  await expect(n.ledger.grantForAssignment(assignment, n.proof(advance.commitment.next))).rejects.toThrow('newer');
  await n.reopen(); expect(n.ledger.status()).toMatchObject({ allocatedPermits: 0, policyFreshness: { observedRevision: 2 } });
  await expect(n.ledger.grantForAssignment(assignment, n.proof({ ...advance.commitment.next, transition: 'f'.repeat(64) }))).rejects.toThrow('conflict');
  await n.reopen(); expect(n.ledger.status().policyFreshness?.conflict).toBe(true); expect(() => n.proof()).toThrow('conflicting');
});

it('protects permanent retirement and lifetime totals through failed quorum and restart', async () => {
  const n = await fixture(); await n.ledger.ready(); await n.ledger.grantForAssignment(await n.assign(), n.proof());
  const successor = await signAdmissionPolicy({ ...n.body, revision: 2, activeKey: admissionKeyFingerprint(profiles[1].issuerPublicKey) }, n.authority, n.authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(n.policy, successor, n.observerContext, n.authorityKey);
  await n.ledger.installPolicy(successor, n.authority, { advance }); n.clock(n.start + 30000);
  const review = n.ledger.planRetirement(n.authority); n.online(3);
  await expect(n.ledger.retire(n.authority, review.approvalDigest)).rejects.toThrow();
  expect(n.ledger.status().protection).toMatchObject({ ready: false, pending: true });
  n.online(5); await n.reopen(); expect(n.ledger.status()).toMatchObject({ permanentlyRetired: true, retainedEntries: 0, allocatedPermits: 1, remainingPermits: 0 });
  await expect(n.ledger.grantForAssignment(await n.assign())).rejects.toThrow('retired');
  await n.reopen(false); expect(n.ledger.status().permanentlyRetired).toBe(true);
});

it.each([3, 4])('resumes the exact pending prepared/completed response after replication fails at sequence %s', async sequence => {
  const n = await fixture(); await n.ledger.ready();
  const permit = await n.ledger.grantForAssignment(await n.assign(), n.proof()), batch = await createAdmissionIssuanceBatch(profiles[0], 1);
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue'); n.failAt(sequence);
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow();
  expect(signing).toHaveBeenCalledTimes(1); expect(n.ledger.status().protection).toMatchObject({ ready: false, pending: true });
  n.failAt(undefined); await n.reopen();
  expect(n.ledger.status()).toMatchObject({ preparedPermits: sequence === 3 ? 1 : 0, completedPermits: sequence === 4 ? 1 : 0 });
  const response = await n.ledger.approve(permit, batch.request, n.proof());
  expect(await batch.finalize(response)).toHaveLength(1); expect(signing).toHaveBeenCalledTimes(1);
});

it('requires independent observer pins at creation, freezes inputs and cannot promote an existing local ledger', async () => {
  const n = await fixture(), initialize = { allocation: n.allocation, communityPolicy: n.policy, observers: n.observerContext };
  await expect(openProtectedAdmissionIssuerLedger({ ...n.options, path: join(n.directory, 'missing-observers.json'),
    initialize: { ...initialize, observers: undefined } })).rejects.toThrow();
  const path = join(n.directory, 'frozen.json'), mutable = { ...n.options, path, initialize: structuredClone(initialize),
    expectedProfile: structuredClone(profiles[0]), protection: { ...n.options.protection, context: structuredClone(n.options.protection.context),
      members: structuredClone(n.options.protection.members), writerDirectory: join(n.directory, 'frozen-writer'), initializeWriter: true, initializeArchive: true } };
  const opening = openProtectedAdmissionIssuerLedger(mutable);
  mutable.path = join(n.directory, 'changed.json');
  if (mutable.initialize.allocation.version !== 2) throw new Error('Fixture requires authority-assigned allocation');
  mutable.initialize.allocation.claimPolicy = 'invalid' as never;
  mutable.protection.context.authority = randomBytes(32).toString('base64url'); mutable.expectedProfile.scope.epoch = 'changed';
  const frozen = await opening; cleanup.push(() => frozen.close());
  expect(frozen.enrollment().context).toEqual(n.options.protection.context);
  const localPath = join(n.directory, 'local.json');
  const local = await openAdmissionIssuerLedger({ path: localPath, expectedProfile: profiles[0], privateKey: pairs[0].privateKey, allocation: { manifest: n.allocation, authority: n.authority } });
  local.close();
  await expect(openProtectedAdmissionIssuerLedger({ ...n.options, path: localPath })).rejects.toThrow();
});

it('retains prepared signatures but refuses to complete them once issuance or allocation expires', async () => {
  const n = await fixture(); await n.ledger.ready();
  const permit = await n.ledger.grantForAssignment(await n.assign(), n.proof()), batch = await createAdmissionIssuanceBatch(profiles[0], 1), original = publicVerif.Issuer.prototype.issue;
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockImplementation(async function (this: InstanceType<typeof publicVerif.Issuer>, ...args) {
    const result = await Reflect.apply(original, this, args); n.clock(n.start + 10000); return result;
  });
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow();
  await n.reopen(); expect(n.ledger.status()).toMatchObject({ preparedPermits: 1, completedPermits: 0 });
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow('retired or inactive');
  expect(signing).toHaveBeenCalledTimes(1); expect(n.ledger.status()).toMatchObject({ preparedPermits: 1, completedPermits: 0 });
});

it('requires the node reviewed restore capability and rejects generic restoration or semantic-validation overrides', async () => {
  const n = await fixture(), original = readFileSync(n.options.path);
  const restore = { preparation: Object.create(null) as PreparedProtectedIssuerRestore, approvedDigest: `sha256:${'0'.repeat(64)}` };
  await expect(openProtectedAdmissionIssuerLedger({ ...n.options, restore })).rejects.toThrow('matching reviewed history');
  for (const override of [{ restore: {} }, { assertTransition: () => {} }, { validateGenesis: () => {} }]) {
    await expect(openProtectedAdmissionIssuerLedger({ ...n.options, protection: Object.assign({}, n.options.protection, override) })).rejects.toThrow('business API capability');
  }
  await expect(openProtectedAdmissionIssuerLedger({ ...n.options, initialize: { allocation: n.allocation, communityPolicy: n.policy, observers: n.observerContext }, restore })).rejects.toThrow('mutually exclusive');
  expect(readFileSync(n.options.path)).toEqual(original);
});

it('captures exact applied and pending images in an opaque recovery source, confirms the pending obligation and durably fences across reopen', async () => {
  const n = await fixture(); await n.ledger.ready(); await n.ledger.grantForAssignment(await n.assign(), n.proof());
  const assignment = await n.assign(), observation = n.proof(); n.online(3);
  await expect(n.ledger.grantForAssignment(assignment, observation)).rejects.toThrow();
  const source = await n.ledger.reviewRecoverySource(), evidence = readProtectedIssuerRecoverySource(source);
  expect(evidence.minimumEvidence.map(image => image.entries.length)).toEqual([1, 2]);
  expect(evidence.applied?.sequence).toBe(1); expect(evidence.pending?.sequence).toBe(2);
  expect(evidence.path).toBe(n.options.path); expect(evidence.writerDirectory).toBe(n.options.protection.writerDirectory);
  const original = structuredClone(evidence); evidence.minimumEvidence[0].entries.length = 0;
  expect(readProtectedIssuerRecoverySource(source)).toEqual(original);
  for (const fake of [structuredClone(source), { ...source }, Object.create(null)] as ProtectedIssuerRecoverySource[]) {
    expect(() => readProtectedIssuerRecoverySource(fake)).toThrow('capability'); await expect(fenceProtectedIssuerRecoverySource(fake)).rejects.toThrow('capability');
  }
  await expect(fenceProtectedIssuerRecoverySource(source)).rejects.toThrow();
  expect(n.ledger.status().protection).toMatchObject({ pending: true, fenced: false });
  n.online(5); await fenceProtectedIssuerRecoverySource(source); await fenceProtectedIssuerRecoverySource(source);
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 2, protection: { fenced: true, pending: false, ready: false } });
  await expect(n.ledger.ready()).rejects.toThrow('fenced'); expect(() => n.proof()).toThrow('fenced');
  await expect(n.ledger.grantForAssignment(assignment)).rejects.toThrow('fenced'); await expect(n.ledger.installPolicy(n.policy, n.authority)).rejects.toThrow('fenced');
  await n.reopen(false); expect(n.ledger.status().protection.fenced).toBe(true); await expect(n.ledger.ready()).rejects.toThrow('fenced');
  const reopenedSource = await n.ledger.reviewRecoverySource(); expect(readProtectedIssuerRecoverySource(reopenedSource).minimumEvidence).toHaveLength(1);
  await fenceProtectedIssuerRecoverySource(reopenedSource);
});

it('refuses a stale source after a business mutation and never invokes a blind signer when fencing an unresolved batch', async () => {
  const n = await fixture(); await n.ledger.ready(); const assignment = await n.assign(), permit = await n.ledger.grantForAssignment(assignment, n.proof());
  const old = await n.ledger.reviewRecoverySource(); const batch = await createAdmissionIssuanceBatch(profiles[0], 1), observation = n.proof(); n.online(3);
  await expect(n.ledger.approve(permit, batch.request, observation)).rejects.toThrow();
  await expect(fenceProtectedIssuerRecoverySource(old)).rejects.toThrow('changed since source review');
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue'), source = await n.ledger.reviewRecoverySource();
  expect(readProtectedIssuerRecoverySource(source).minimumEvidence.map(image => image.entries[0].batchId)).toEqual([undefined, batch.request.batchId]);
  n.online(5); await fenceProtectedIssuerRecoverySource(source); expect(signing).not.toHaveBeenCalled();
  expect(n.ledger.status()).toMatchObject({ boundPermits: 1, preparedPermits: 0, completedPermits: 0, protection: { fenced: true } });
});

async function interruptedRestoreFixture(stage: 'owner' | 'writer' | 'archive' = 'owner') {
  const n = await fixture(); await n.ledger.ready(); await n.ledger.grantForAssignment(await n.assign(), n.proof()); n.ledger.close();
  const blocks = n.stores[0].read().envelopes, genesisId = historyCheckpointEnvelopeId(blocks[0]), issuedAt = Date.now(), challenge = randomBytes(32).toString('base64url');
  const context = n.options.protection.context, freeze = createHistoryFreeze(context, 0, 1, challenge, n.h.owner);
  const receipts = await Promise.all(n.options.protection.members.map(async member => {
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId: genesisId, generation: 0, replica: member.publicKey,
      challenge, issuedAt, expiresAt: issuedAt + 30000, sequence: 1, envelopeId: null }, context, n.h.owner);
    return parseHistoryExchangeResponse(await n.options.protection.transport(member, { request, envelope: null, freeze }, new AbortController().signal), request, context);
  }));
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId: genesisId, generation: 0, nextGeneration: 1,
    receipts: receipts.slice(0, 4), envelopes: blocks }, context, n.h.owner);
  const voters = n.stores.map((store, index) => createHistoryAgreementReplica({ context, store, signingKey: n.h.memberKeys[index] })); cleanup.push(() => voters.forEach(voter => voter.close()));
  const coordinator = createHistoryAgreementCoordinator({ directory: join(n.directory, 'agreement'), localKey: n.h.localKey, context, signingKey: n.h.owner,
    rootId: genesisId, generation: 0, nextGeneration: 1, members: n.options.protection.members, initialize: { proposal }, transport: async (member, frame) => voters[context.members.indexOf(member.publicKey)].exchange(frame) }); cleanup.push(coordinator.close);
  const root = createHistoryContinuationRoot(proposal, await coordinator.run(), context);
  const key = await deriveAdmissionIssuerEncryptionKey(pairs[0].privateKey); cleanup.push(() => key.fill(0));
  for (let index = 0; index < 5; index++) {
    const parent = n.stores[index]; parent.activateContinuation(root);
    const store = openHistoryCheckpointStore({ directory: join(n.directory, `g1-${index}`), localKey: n.h.localKey, context, replica: context.members[index], rootId: historyCheckpointEnvelopeId(root), generation: 1, initialize: root, parent }); cleanup.push(store.close); n.stores[index] = store;
    const role = createHistoryCheckpointReplica({ context, store, signingKey: n.h.memberKeys[index] }); cleanup.push(role.close); n.roles[index] = role;
  }
  const destination = { path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored-writer') };
  const replay = { context, genesisId, profile: profiles[0], authority: n.authority, encryptionKey: key, continuation: root, blocks };
  const preparation = await prepareProtectedIssuerRestore({ ...replay, destination });
  const restored = await openProtectedAdmissionIssuerLedger({ ...n.options, path: destination.path, protection: { ...n.options.protection, writerDirectory: destination.writerDirectory, initializeWriter: true, initializeArchive: true }, restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
  cleanup.push(restored.close); restored.close();
  // Precisely reproduce publication prefixes: owner -> pristine writer -> pristine archive, without a new key or owner rewrite.
  if (stage === 'owner') rmSync(destination.writerDirectory, { recursive: true });
  if (stage === 'writer') rmSync(join(destination.writerDirectory, 'payloads'), { recursive: true });
  const options = { ...replay, destination, privateKey: pairs[0].privateKey, signingKey: n.h.owner, members: n.options.protection.members,
    transport: n.options.protection.transport, timeoutMs: 2000 };
  return { n, options, destination, key, restoredOptions: { ...n.options, path: destination.path, protection: { ...n.options.protection, writerDirectory: destination.writerDirectory } } };
}

it.each(['owner', 'writer', 'archive'] as const)('resumes only the authenticated pristine %s publication prefix and keeps readiness unverified', async stage => {
  const f = await interruptedRestoreFixture(stage), before = readFileSync(f.destination.path);
  const resumption = await openProtectedIssuerRestoreResumption(f.options); cleanup.push(resumption.close);
  const review = resumption.review(); expect(review).toMatchObject({ initializeWriter: stage === 'owner', initializeArchive: stage !== 'archive', readiness: 'unverified', startsService: false });
  f.n.online(3);
  if (stage !== 'archive') await expect(resumption.apply(review.approvalDigest)).rejects.toThrow('Four current');
  f.n.online(5); const result = await resumption.apply(review.approvalDigest);
  expect(result).toMatchObject({ readiness: 'unverified', startsService: false, status: { ready: false, pending: true } });
  expect(readFileSync(f.destination.path)).toEqual(before); resumption.close();
  const ledger = await openProtectedAdmissionIssuerLedger(f.restoredOptions); cleanup.push(ledger.close); expect(ledger.status().protection.ready).toBe(false); await ledger.ready(); expect(ledger.status().allocatedPermits).toBe(1);
});

it('refuses applied history with missing archives, wrong replay/key inputs and files changed after resumption review', async () => {
  const f = await interruptedRestoreFixture('owner');
  await expect(openProtectedIssuerRestoreResumption({ ...f.options, blocks: f.options.blocks.slice(1) })).rejects.toThrow();
  await expect(openProtectedIssuerRestoreResumption({ ...f.options, privateKey: pairs[1].privateKey })).rejects.toThrow();
  const resumption = await openProtectedIssuerRestoreResumption(f.options); cleanup.push(resumption.close); const review = resumption.review();
  mkdirSync(f.destination.writerDirectory); writeFileSync(join(f.destination.writerDirectory, 'unexpected'), 'evidence');
  await expect(resumption.apply(review.approvalDigest)).rejects.toThrow('files changed'); resumption.close(); rmSync(f.destination.writerDirectory, { recursive: true });
  const next = await openProtectedIssuerRestoreResumption(f.options); cleanup.push(next.close); await next.apply(next.review().approvalDigest); next.close();
  const ledger = await openProtectedAdmissionIssuerLedger(f.restoredOptions); cleanup.push(ledger.close); await ledger.ready(); ledger.close();
  rmSync(join(f.destination.writerDirectory, 'payloads'), { recursive: true });
  await expect(openProtectedIssuerRestoreResumption(f.options)).rejects.toThrow('Missing components beside applied');
});

it('does not recreate pristine components while four replicas retain a later root suffix', async () => {
  const f = await interruptedRestoreFixture('owner');
  const raw = openEncryptedLocalState<any>({ path: f.destination.path, key: f.key, domain: DOMAIN, maxBytes: MAX_PROTECTED_ISSUER_HISTORY_BYTES,
    mode: 'open-existing', initial: {}, validate: (value): value is any => !!value }); const state = raw.read(); raw.close();
  const root = f.options.continuation, later = sealHistoryCheckpoint({ context: f.options.context,
    header: { kind: 'checkpoint', generation: root.generation, sequence: 1, previous: historyCheckpointEnvelopeId(root) },
    plaintext: Buffer.from(JSON.stringify(state.image)), encryptionKey: f.key, signingKey: f.n.h.owner });
  f.n.stores.slice(0, 4).forEach(store => store.append(later));
  const review = await openProtectedIssuerRestoreResumption(f.options); cleanup.push(review.close);
  await expect(review.apply(review.review().approvalDigest)).rejects.toThrow('Four current'); expect(existsSync(f.destination.writerDirectory)).toBe(false);
});

it('preserves committed writer evidence when its archive is missing and refuses tampered retained owner baselines', async () => {
  const f = await interruptedRestoreFixture('writer'), root = f.options.continuation;
  const writer = createHistoryCheckpointWriter({ directory: f.destination.writerDirectory, localKey: f.key, signingKey: f.n.h.owner, context: f.options.context,
    rootId: historyCheckpointEnvelopeId(root), generation: root.generation, continuation: root, members: f.options.members, timeoutMs: 2000, transport: f.options.transport });
  await writer.replicate(root); writer.close(); const retained = readFileSync(join(f.destination.writerDirectory, HISTORY_WRITER_FILENAME));
  await expect(openProtectedIssuerRestoreResumption(f.options)).rejects.toThrow('Committed issuer archive is missing');
  expect(readFileSync(join(f.destination.writerDirectory, HISTORY_WRITER_FILENAME))).toEqual(retained); expect(existsSync(join(f.destination.writerDirectory, 'payloads'))).toBe(false);
  const raw = openEncryptedLocalState<any>({ path: f.destination.path, key: f.key, domain: DOMAIN, maxBytes: MAX_PROTECTED_ISSUER_HISTORY_BYTES,
    mode: 'open-existing', initial: {}, validate: (value): value is any => !!value }); const state = raw.read(); state.restoration.baseline.entries = []; raw.write(state); raw.close();
  await expect(openProtectedIssuerRestoreResumption(f.options)).rejects.toThrow('independently replayed');
});

it.skipIf(process.platform === 'win32')('binds restore approval and source metadata to canonical destinations and refuses a retargeted symlink parent', async () => {
  const f = await interruptedRestoreFixture('archive'), first = join(f.n.directory, 'physical-one'), second = join(f.n.directory, 'physical-two'), link = join(f.n.directory, 'chosen');
  mkdirSync(first); mkdirSync(second); symlinkSync(first, link, 'dir');
  const destination = { path: join(link, 'issuer.json'), writerDirectory: join(link, 'writer') };
  const preparation = await prepareProtectedIssuerRestore({ ...f.options, destination });
  expect(preparation.review.path).toBe(join(first, 'issuer.json'));
  rmSync(link); symlinkSync(second, link, 'dir');
  await expect(openProtectedAdmissionIssuerLedger({ ...f.n.options, path: destination.path,
    protection: { ...f.n.options.protection, writerDirectory: destination.writerDirectory, initializeWriter: true },
    restore: { preparation, approvedDigest: preparation.review.approvalDigest } })).rejects.toThrow('matching reviewed history');
  expect(existsSync(join(first, 'issuer.json'))).toBe(false); expect(existsSync(join(second, 'issuer.json'))).toBe(false);
  const existingLink = join(f.n.directory, 'existing-selection'); symlinkSync(f.n.directory, existingLink, 'dir');
  const ledger = await openProtectedAdmissionIssuerLedger({ ...f.restoredOptions, path: join(existingLink, 'restored.json'),
    protection: { ...f.restoredOptions.protection, writerDirectory: join(existingLink, 'restored-writer') } }); cleanup.push(ledger.close);
  const source = await ledger.reviewRecoverySource(); expect(source.path).toBe(f.destination.path); expect(source.writerDirectory).toBe(f.destination.writerDirectory);
});

it('retains the construction storage authority for deferred source fencing and refuses authority switching', async () => {
  const n = await fixture(); await n.ledger.ready(); n.ledger.close(); const requests: string[] = [];
  const authority = { reserve(request: { path: string }) { requests.push(request.path); if (request.path.includes('issuer-recovery-fence.json')) throw new Error('fence reservation denied'); return { assertWritable() {} }; } };
  const ledger = await withStorageReservationAuthority(authority, () => openProtectedAdmissionIssuerLedger(n.options)); cleanup.push(ledger.close);
  const source = await ledger.reviewRecoverySource(), switched = { reserve() { return { assertWritable() {} }; } };
  await expect(withStorageReservationAuthority(switched, () => fenceProtectedIssuerRecoverySource(source))).rejects.toThrow('switch its storage authority');
  await expect(fenceProtectedIssuerRecoverySource(source)).rejects.toThrow('fence reservation denied');
  expect(requests.some(path => path.includes('issuer-recovery-fence.json'))).toBe(true); expect(existsSync(join(n.options.protection.writerDirectory, 'issuer-recovery-fence.json'))).toBe(false);
});

it('retains the construction storage authority for escaped resumption apply and refuses authority switching', async () => {
  const f = await interruptedRestoreFixture('owner'), requests: string[] = [];
  const authority = { reserve(request: { path: string }) { requests.push(request.path); if (request.path.startsWith(f.destination.writerDirectory)) throw new Error('writer reservation denied'); return { assertWritable() {} }; } };
  const resume = await withStorageReservationAuthority(authority, () => openProtectedIssuerRestoreResumption(f.options)); cleanup.push(resume.close);
  const review = resume.review(), switched = { reserve() { return { assertWritable() {} }; } };
  await expect(withStorageReservationAuthority(switched, () => resume.apply(review.approvalDigest))).rejects.toThrow('switch its storage authority');
  await expect(resume.apply(review.approvalDigest)).rejects.toThrow('writer reservation denied');
  expect(requests.some(path => path.startsWith(f.destination.writerDirectory))).toBe(true); expect(existsSync(join(f.destination.writerDirectory, HISTORY_WRITER_FILENAME))).toBe(false);
});
