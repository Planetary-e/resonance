import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenHistoryAgreementReplica } from '../../../relay/src/history-agreement-exchange.js';
import { generateSigningKeyPair, createAdmissionRequestBindingV2 } from '@resonance/core';
import { admissionKeyFingerprint, admissionPolicyDigest, signAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance, admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionPolicyProofReference, createResolvedAdmissionPolicyAdvance, prepareAdmissionPolicyV3Successor, resolveAdmissionPolicy, signAdmissionPolicyV3,
  AdmissionPolicyArchiveBudget, resolveAdmissionPolicyAdvance, resolveAdmissionPolicyHistoryMembership, admissionPolicyHistoryEntry, type ResolvedAdmissionPolicy, type AdmissionPolicyArchiveLimits, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId, openHistoryCheckpoint, historyCheckpointEnvelopeByteLength, sealHistoryCheckpoint, createHistoryFreeze } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { openHistoryVolunteerService } from '../../../relay/src/history-volunteer-service.js';
import { createHistoryCheckpointRecovery } from '../../../relay/src/history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator } from '../../../relay/src/history-agreement-coordinator.js';
import { createHistoryAncestryDownload } from '../../../relay/src/history-ancestry-download.js';
import { createHistoryProvisionCoordinator } from '../../../relay/src/history-provision-coordinator.js';
import { openProtectedAdmissionSpendHistory } from '../../../relay/src/protected-admission-history.js';
import { createConfiguredAdmissionVerifier } from '../../../relay/src/configured-admission-verifier.js';
import { prepareAdmissionHistoryRestore } from '../../../relay/src/admission-history-restore.js';
import { openProtectedAdmissionIssuerLedger, readProtectedIssuerRecoverySource } from '../protected-admission-issuer-ledger.js';
import { prepareProtectedIssuerRestore } from '../admission-issuer-history-restore.js';
import { deriveAdmissionIssuerEncryptionKey } from '../admission-issuer-state.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { createAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { createAdmissionWitnessVote, admissionWitnessSetId } from '@resonance/core/admission-witness';
import { replayAdmissionHistory } from '../../../relay/src/admission-history-replay.js';
import { replayProtectedIssuerHistory } from '../admission-issuer-history-replay.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const authorityKey = generateSigningKeyPair(), authority = Buffer.from(authorityKey.publicKey).toString('base64url');
const observers = Array.from({ length: 5 }, generateSigningKeyPair), witnesses = Array.from({ length: 5 }, generateSigningKeyPair);
const pub = (key: ReturnType<typeof generateSigningKeyPair>) => Buffer.from(key.publicKey).toString('base64url');
const members = observers.map((key, i) => ({ publicKey: pub(key), endpoint: `ws://127.0.0.1:${41000 + i}/` }));
const limits: AdmissionPolicyArchiveLimits = { maxPages: 20000, maxEntries: 100000, maxArchiveBytes: 64 * 1024 * 1024,
  maxHistoryBytes: 256 * 1024 * 1024, maxTransitions: 100, maxPageReads: 20000, timeoutMs: 3000 };
const relayUrl = 'ws://127.0.0.1:42000/';
let entries: AdmissionPolicyKey[], genesis: Awaited<ReturnType<typeof signAdmissionPolicy>>, privateKey: CryptoKey,
  context: ReturnType<typeof parseAdmissionPolicyObservers>, migrationResolved: ResolvedAdmissionPolicy, advances: ArchivedAdmissionPolicyAdvance[], migrationPages: Array<{ digest: string; bytes: Uint8Array }>;
beforeAll(async () => {
  const rsa = Array.from({ length: 67 }, () => generateKeyPairSync('rsa', { modulusLength: 2048 }));
  const set = { version: 1 as const, quorum: 4 as const, members: witnesses.map((key, i) => ({ publicKey: pub(key), endpoint: `ws://127.0.0.1:${43000 + i}/` })), coordinators: [authority] };
  entries = rsa.map((pair, i) => ({ profile: { version: 1, scope: { issuer: 'protected-consumers', community: 'public', epoch: `period-${i}` },
    issuerPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: [relayUrl] },
    notBefore: 1000 + i * 10, issueUntil: i === 0 ? 4000 : 1001 + i * 10, spendUntil: i === 0 ? 4500 : 1002 + i * 10,
    retryUntil: i === 0 ? 4900 : 1003 + i * 10, witnesses: set }));
  privateKey = await crypto.subtle.importKey('pkcs8', rsa[0].privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  genesis = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: 1010, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: [entries[0], entries[1]] }, authority, authorityKey.secretKey);
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(genesis), quorum: 4, members });
  advances = []; let previous = genesis, head = context.genesis;
  const fields = (i: number) => ({ revision: i + 1, issuedAt: 1010 + i * 10, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[i + 1].profile.issuerPublicKey), keys: [entries[0], entries[i + 1]] });
  for (let i = 1; i <= 64; i++) {
    const next = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', ...fields(i), archivedKeys: entries.slice(1, i + 1) }, authority, authorityKey.secretKey);
    const advance = await createAdmissionPolicyAdvance(previous, next, context, authorityKey, head);
    advances.push(advance); previous = next; head = advance.commitment.next;
  }
  const pages = new Map<string, Uint8Array>(), reader = async (digest: string) => { const bytes = pages.get(digest); if (!bytes) throw new Error('Missing fixture page'); return bytes; };
  let resolved = await resolveAdmissionPolicy({ context, genesis, advances, selectedHead: head, reader, limits });
  const staged = await prepareAdmissionPolicyV3Successor({ previous: resolved, next: fields(65), reader, limits });
  migrationPages = staged.pages; for (const page of migrationPages) pages.set(page.digest, page.bytes);
  const signed = await signAdmissionPolicyV3(staged.body, authority, authorityKey.secretKey);
  const migration = await createResolvedAdmissionPolicyAdvance({ previous: resolved, policy: signed, key: authorityKey, reader, limits }); advances.push(migration.advance); migrationResolved = migration.resolved; resolved = migration.resolved;
  const final = await prepareAdmissionPolicyV3Successor({ previous: resolved, next: { ...fields(65), revision: 67, issuedAt: 1661, activeKey: genesis.activeKey }, reader, limits });
  expect(final.pages).toHaveLength(0);
  advances.push((await createResolvedAdmissionPolicyAdvance({ previous: resolved, policy: await signAdmissionPolicyV3(final.body, authority, authorityKey.secretKey), key: authorityKey, reader, limits })).advance);
}, 60000);

async function fixture(settings: { sockets?: boolean; maxArchiveBlocks?: number; maxArchiveBytes?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'protected-consumers-v3-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let funding = openStorageReservationAuthority({ directory: join(directory, 'authority'), mode: 'create-new', limitBytes: 16 * 1024 ** 3 }); cleanup.push(() => funding.close());
  const fundingId = funding.status().authorityId;
  const replicaFunding = settings.sockets ? openStorageReservationAuthority({ directory: join(directory, 'replica-authority'), mode: 'create-new', limitBytes: 16 * 1024 ** 3 }) : funding;
  if (replicaFunding !== funding) cleanup.push(replicaFunding.close);
  const runReplica = <T>(work: () => T): T => withStorageReservationAuthority(replicaFunding, work);
  const run = <T>(work: () => T): T => withStorageReservationAuthority(funding, work);
  let now = 1010, selected = context.genesis;
  const allocation = await signAdmissionIssuanceAllocation({ version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1', community: 'public', epoch: 'period-0',
    notBefore: 1000, issueUntil: 4000, totalTokenBudget: 4, allocations: [{ profile: entries[0].profile, batchSize: 1, maxPermits: 4 }] }, authority, authorityKey.secretKey);
  const key = await deriveAdmissionIssuerEncryptionKey(privateKey); cleanup.push(() => { key.fill(0); });
  async function role(kind: 'admission-issuer' | 'relay-admission-spends') {
    const h = historyCheckpointFixture(), roleDirectory = join(directory, kind);
    const historyContext = { ...h.context, role: kind, authority, policyDigest: `sha256:${admissionPolicyDigest(genesis)}` };
    const endpoints = historyContext.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${44000 + i}/history-checkpoint` }));
    const services: ReturnType<typeof openHistoryVolunteerService>[] = [];
    let online = 5;
    const service = (publicKey: string) => { const i = historyContext.members.indexOf(publicKey); if (i < 0 || i >= online) throw new Error('offline'); return services[i]; };
    const transport = async (member: { publicKey: string }, frame: Parameters<ReturnType<typeof openHistoryVolunteerService>['checkpoint']>[0]) => service(member.publicKey).checkpoint(frame);
    const agreementTransport = async (member: { publicKey: string }, frame: Parameters<ReturnType<typeof openHistoryVolunteerService>['exchange']>[0]) => service(member.publicKey).exchange(frame);
    const dataTransport = async (member: { publicKey: string }, frame: Parameters<ReturnType<typeof openHistoryVolunteerService>['transfer']>[0]) => service(member.publicKey).transfer(frame);
    const provisionTransport = async (member: { publicKey: string }, frame: Parameters<ReturnType<typeof openHistoryVolunteerService>['provision']>[0]) => service(member.publicKey).provision(frame);
    if (settings.sockets) for (let i = 0; i < 5; i++) {
      const listener = await listenHistoryAgreementReplica({ checkpoint: frame => services[i].checkpoint(frame), exchange: frame => services[i].exchange(frame),
        transfer: frame => services[i].transfer(frame), provision: frame => services[i].provision(frame) }, { maxConnections: 8 });
      endpoints[i].endpoint = listener.checkpointEndpoint; cleanup.push(listener.close);
    }
    const agreementEndpoints = endpoints.map(member => ({ ...member, endpoint: new URL('/history-agreement', member.endpoint).href }));
    const protection = { maxArchiveBlocks: settings.maxArchiveBlocks, maxArchiveBytes: settings.maxArchiveBytes, context: historyContext, signingKey: h.owner, members: endpoints, transport, timeoutMs: 2000 };
    const ownerDirectory = join(roleDirectory, 'owner');
    const issuerOptions = { path: join(ownerDirectory, 'issuer.json'), expectedProfile: entries[0].profile, privateKey, expectedAllocationAuthority: authority, now: () => now,
      protection: { ...protection, writerDirectory: join(ownerDirectory, 'writer') } };
    const relayOptions = { directory: ownerDirectory, encryptionKey: key, authority, policy: genesis, now: () => now, protection };
    const owner = kind === 'admission-issuer'
      ? await run(() => openProtectedAdmissionIssuerLedger({ ...issuerOptions, initialize: { allocation, communityPolicy: genesis, observers: context }, protection: { ...issuerOptions.protection, initializeWriter: true, initializeArchive: true } }))
      : await run(() => openProtectedAdmissionSpendHistory({ ...relayOptions, initialize: true, protection: { ...protection, initializeWriter: true, initializeArchive: true } }));
    cleanup.push(owner.close);
    const root = owner.enrollment().root, genesisId = historyCheckpointEnvelopeId(root);
    for (let i = 0; i < 5; i++) {
      const volunteer = runReplica(() => openHistoryVolunteerService({ directory: join(roleDirectory, `replica-${i}`), context: historyContext, genesisId,
        localKey: randomBytes(32), signingKey: h.memberKeys[i], initialize: root })); services.push(volunteer); cleanup.push(volunteer.close);
    }
    await owner.ready();
    async function recover() {
      const freeze = run(() => createHistoryCheckpointRecovery({ directory: join(roleDirectory, 'freeze'), localKey: key, context: historyContext, signingKey: h.owner,
        rootId: genesisId, generation: 0, nextGeneration: 1, members: endpoints, initialize: true, timeoutMs: 2000, transport })); cleanup.push(freeze.close);
      const frozen = await freeze.prepare(), proposal = createHistorySuccessorProposal(frozen, historyContext, h.owner);
      const agreement = run(() => createHistoryAgreementCoordinator({ directory: join(roleDirectory, 'agreement'), localKey: key, context: historyContext, signingKey: h.owner,
        rootId: genesisId, generation: 0, nextGeneration: 1, members: agreementEndpoints, initialize: { proposal }, timeoutMs: 2000,
        transport: agreementTransport, historyTransfer: { transport: dataTransport, retained: () => frozen.envelopes } })); cleanup.push(agreement.close);
      const certificate = await agreement.run(), chosen = agreement.read().selected!, continuation = createHistoryContinuationRoot(chosen, certificate, historyContext);
      const download = run(() => createHistoryAncestryDownload({ directory: join(roleDirectory, 'download'), localKey: key, context: historyContext,
        signingKey: h.owner, proposal: chosen, members: endpoints, initialize: true, timeoutMs: 2000, transport })); cleanup.push(download.close);
      while (!download.read().complete) await download.run({ maxBlocks: 8 }); expect(download.read().complete).toBe(true);
      const provision = run(() => createHistoryProvisionCoordinator({ directory: join(roleDirectory, 'provision'), localKey: key, context: historyContext, signingKey: h.owner,
        root: continuation, members: agreementEndpoints, initialize: true, timeoutMs: 2000, transport: provisionTransport })); cleanup.push(provision.close);
      expect((await provision.run()).length).toBe(4);
      return { continuation, download, blocks: () => download.blocks() };
    }
    return { owner, ownerDirectory, issuerOptions, relayOptions, protection, context: historyContext, genesisId, key, recover, services, online(count: number) { online = count; } };
  }
  const issuer = await role('admission-issuer'), relay = await role('relay-admission-spends');
  const observation = () => { const query = createAdmissionPolicyQuery(context, now); return { query, reply: { version: 1 as const, type: 'admission_policy_query_reply' as const,
    certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const, votes: observers.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, selected, context, key, now)) } } }; };
  const issuerProof = (ledger: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>) => { const { query } = ledger.preparePolicyObservation(); return { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate', votes: observers.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, selected, context, key, now)) } }; };
  const assign = () => signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority, allocationDigest: admissionIssuanceAllocationDigest(allocation), community: 'public', epoch: 'period-0', claimHandle: randomBytes(32).toString('base64url'), issuerKeyFingerprint: genesis.activeKey }, allocation, authority, authorityKey.secretKey);
  return { directory, get funding() { return funding; }, reopenFunding() { funding = openStorageReservationAuthority({ directory: join(directory, 'authority'), mode: 'open-existing', authorityId: fundingId }); }, run, issuer, relay, key, observation, issuerProof, assign, now: () => now, head: () => selected, select(advance: ArchivedAdmissionPolicyAdvance) { selected = advance.commitment.next; now = advance.policy.issuedAt; } };
}

it('crosses65 archived configurations with protected issuance/admission, exact backfill, restart and actual owner-loss replica restoration', async () => {
  const started = performance.now(); const stage = (name: string) => console.info('protected-consumers stage', name, Math.round(performance.now() - started));
  stage('start');
  const n = await fixture(); stage('fixture'); let issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  let relay = n.relay.owner as Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
  const local = await n.run(() => openAdmissionPolicyStore({ path: join(n.relay.ownerDirectory, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'create-new', now: n.now }));
  await local.install(genesis, authority, { observers: context }); local.bindProtectedHistory((await import('@resonance/core/history-checkpoint')).historyCheckpointContextId(n.relay.context));
  const roles = { witness: { version: 2 as const, witness: pub(witnesses[0]), votes: [], retiredIssuerKeys: [] }, coordinator: { version: 2 as const, coordinator: authority, certificates: [], retiredIssuerKeys: [] } };
  const capture = await relay.planRoleCapture(roles); await relay.captureRoles(roles, capture.approvalDigest);
  const wallet = await n.run(() => openManagedAdmissionWallet({ directory: join(n.directory, 'wallet'), encryptionKey: randomBytes(32), now: n.now,
    proofStorage: { authority: n.funding, authorityId: n.funding.status().authorityId, directory: join(n.directory, 'wallet-proof'), maxCiphertextBytes: 16 * 1024 * 1024, maxRecords: 256,
      limits: { ...limits, maxPageReads: 20000 } } })); cleanup.push(wallet.close);
  await wallet.installPolicy(genesis, authority, context);
  const grant = await n.assign(), permit = await issuer.grantForAssignment(grant, n.issuerProof(issuer)), batch = await createAdmissionIssuanceBatch(entries[0].profile, 1);
  stage('before-issue');
  const response = await issuer.approve(permit, batch.request, n.issuerProof(issuer)); await wallet.importTokens(await batch.finalize(response));
  // Installed legacy state advances first. Backfill then proves that exact installed head without resetting work.
  stage('before-legacy');
  for (let i = 0; i < 64; i++) {
    const advance = advances[i]; n.select(advance); await issuer.installPolicy(advance.policy, authority, { advance });
    relay.close(); relay = await n.run(() => openProtectedAdmissionSpendHistory({ ...n.relay.relayOptions, policy: advance.policy })); await relay.ready();
    await local.install(advance.policy, authority, { advance }); await wallet.appendPolicyProof({ advance, pages: [] });
    if ((i + 1) % 16 === 0) stage(`legacy-${i + 1}`);
  }
  stage('legacy-complete');
  const installed = local.freshness()!, before = issuer.status();
  await issuer.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits);
  await relay.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, installed, limits);
  stage('backfill-genesis');
  let backfilled = 0;
  for (const advance of advances.slice(0, 64)) {
    await issuer.backfillPolicyProof({ version: 1, kind: 'advance', advance, pages: [] });
    await relay.backfillPolicyProof({ version: 1, kind: 'advance', advance, pages: [] }, installed);
    if (++backfilled % 16 === 0) stage(`backfill-${backfilled}`);
  }
  stage('backfill-complete');
  expect(issuer.status()).toMatchObject({ allocatedPermits: before.allocatedPermits, completedPermits: before.completedPermits, policyFreshness: before.policyFreshness });
  relay.close(); local.close();
  let currentPolicy = advances[63].policy;
  let verifier: Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>;
  const configured = (policy = currentPolicy, advance?: ArchivedAdmissionPolicyAdvance, pages?: typeof migrationPages) => n.run(() => createConfiguredAdmissionVerifier({
    directory: n.relay.ownerDirectory, authority, policy, encryptionKey: n.key, now: n.now, historyProtection: n.relay.protection,
    policyAdvance: advance, policyPages: pages, coordinatorKey: authorityKey, witnessKey: witnesses[0],
    policyObservationTransport: async (member, frame) => createAdmissionPolicyHeadVote(frame.request, n.head(), context,
      observers.find(key => pub(key) === member.publicKey)!, n.now()),
    witnessTransport: async (member, request) => createAdmissionWitnessVote(request, witnesses.find(key => pub(key) === member.publicKey)!),
  }));
  // Fixed configured observer transport signs the exact selected retained head, never a request-provided head.
  for (const [i, advance] of advances.slice(64).entries()) {
    n.select(advance); const pages = i === 0 ? migrationPages : [];
    await issuer.installPolicy(advance.policy, authority, { advance, pages });
    currentPolicy = advance.policy; verifier = await configured(currentPolicy, advance, pages); verifier.close();
    await wallet.appendPolicyProof({ advance, pages });
  }
  stage('v3-installed');
  expect(currentPolicy.version).toBe(3); if (currentPolicy.version !== 3) throw new Error('Expected archived policy');
  expect(currentPolicy.archive.entryCount).toBe(65); expect(currentPolicy.keys).toHaveLength(2);
  issuer.close(); issuer = await n.run(() => openProtectedAdmissionIssuerLedger(n.issuer.issuerOptions)); cleanup.push(issuer.close); await issuer.ready();
  expect(await issuer.approve(permit, batch.request, n.issuerProof(issuer))).toEqual(response);
  verifier = await configured(); cleanup.push(() => verifier.close());
  const request = { relayUrl, action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { real: 'protected-consumers' }), policyObservation: n.observation() };
  const capability = wallet.capabilityFor(request); if (!capability) throw new Error('Expected wallet capability');
  expect(await verifier.verifyAndSpend(capability, { action: 'search', requestBinding: request.requestBinding, now: n.now() })).toEqual({ status: 'accepted' });
  verifier.close(); verifier = await configured();
  expect(await verifier.verifyAndSpend(capability, { action: 'search', requestBinding: request.requestBinding, now: n.now() })).toEqual({ status: 'replay' });
  issuer.close(); verifier.close();
  rmSync(n.issuer.ownerDirectory, { recursive: true, force: true }); rmSync(n.relay.ownerDirectory, { recursive: true, force: true });
  stage('owners-deleted');
  const recoveredIssuer = await n.issuer.recover(), recoveredRelay = await n.relay.recover();
  const issuerDestination = { path: join(n.directory, 'restored-issuer', 'issuer.json'), writerDirectory: join(n.directory, 'restored-issuer', 'writer') };
  const preparedIssuer = await prepareProtectedIssuerRestore({ destination: issuerDestination, context: n.issuer.context, genesisId: n.issuer.genesisId,
    profile: entries[0].profile, authority, encryptionKey: n.key, continuation: recoveredIssuer.continuation, blocks: recoveredIssuer.blocks() });
  const issuerOptions = { ...n.issuer.issuerOptions, path: issuerDestination.path, protection: { ...n.issuer.issuerOptions.protection, writerDirectory: issuerDestination.writerDirectory, ancestrySource: recoveredIssuer.blocks } };
  issuer = await n.run(() => openProtectedAdmissionIssuerLedger({ ...issuerOptions, restore: { preparation: preparedIssuer, approvedDigest: preparedIssuer.review.approvalDigest }, protection: { ...issuerOptions.protection, initializeWriter: true, initializeArchive: true } })); cleanup.push(issuer.close); await issuer.ready();
  expect(await issuer.approve(permit, batch.request, n.issuerProof(issuer))).toEqual(response);
  const relayDirectory = join(n.directory, 'restored-relay');
  const preparedRelay = await prepareAdmissionHistoryRestore({ directory: relayDirectory, context: n.relay.context, genesisId: n.relay.genesisId,
    encryptionKey: n.key, continuation: recoveredRelay.continuation, blocks: recoveredRelay.blocks(), blockSource: recoveredRelay.blocks, policy: currentPolicy, now: n.now });
  const restoredRelay = await n.run(() => openProtectedAdmissionSpendHistory({ ...n.relay.relayOptions, directory: relayDirectory, policy: currentPolicy, initialize: true,
    protection: { ...n.relay.protection, ancestrySource: recoveredRelay.blocks, initializeWriter: true, initializeArchive: true, restore: { preparation: preparedRelay, approvedDigest: preparedRelay.review.approvalDigest } } })); cleanup.push(restoredRelay.close); await restoredRelay.ready();
  stage('restored');
  expect(restoredRelay.size()).toBe(1); expect(restoredRelay.roleState().coordinator?.certificates).toHaveLength(1);
  expect(restoredRelay.read().image.policyProof?.head).toEqual(advances.at(-1)!.commitment.next);
  expect(() => restoredRelay.planCheckpointCertification()).toThrow('proof-preserving');
  // The restored baseline cannot authorize reopening without its original funded ancestry.
  issuer.close(); await expect(n.run(() => openProtectedAdmissionIssuerLedger({ ...issuerOptions, protection: { ...issuerOptions.protection, ancestrySource: undefined } }))).rejects.toThrow('genesis');
  let proofBlock: ReturnType<typeof recoveredIssuer.blocks> extends Iterable<infer T> ? T | undefined : never;
  for (const block of recoveredIssuer.blocks()) {
    if (block.kind !== 'checkpoint') continue;
    const bytes = openHistoryCheckpoint(block, n.issuer.context, n.key);
    try { if (JSON.parse(bytes.toString('utf8')).policyProofAppend?.kind === 'genesis') { proofBlock = block; break; } } finally { bytes.fill(0); }
  }
  if (!proofBlock) throw new Error('Expected retained original proof record');
  const proofPath = join(n.directory, 'admission-issuer', 'download', `${historyCheckpointEnvelopeId(proofBlock).slice(7)}.block`), proofBytes = readFileSync(proofPath);
  rmSync(proofPath); await expect(n.run(() => openProtectedAdmissionIssuerLedger(issuerOptions))).rejects.toThrow(); writeFileSync(proofPath, proofBytes);
  const altered = JSON.parse(proofBytes.toString('utf8')); altered.ciphertext = `${altered.ciphertext[0] === 'A' ? 'B' : 'A'}${altered.ciphertext.slice(1)}`;
  writeFileSync(proofPath, JSON.stringify(altered)); await expect(n.run(() => openProtectedAdmissionIssuerLedger(issuerOptions))).rejects.toThrow(); writeFileSync(proofPath, proofBytes);
  issuer = await n.run(() => openProtectedAdmissionIssuerLedger(issuerOptions)); await issuer.ready(); issuer.close();
}, 120000);

it('honors a stricter cancellation signal on an explicitly shared immutable core budget', async () => {
  const controller = new AbortController(), budget = new AdmissionPolicyArchiveBudget({ limits });
  expect(Object.isFrozen(budget.limits)).toBe(true);
  const previous = await resolveAdmissionPolicy({ context, genesis, advances: [], selectedHead: context.genesis, reader: async () => { throw new Error('No pages'); }, limits, budget });
  controller.abort();
  await expect(resolveAdmissionPolicyAdvance({ previous, advance: advances[0], selectedHead: advances[0].commitment.next,
    reader: async () => { throw new Error('No pages'); }, limits, budget, signal: controller.signal })).rejects.toThrow('cancelled');
});

it('refuses protected proof capacity/cancellation before intent and completes exact pending proof after quorum loss', async () => {
  const n = await fixture(), issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  const before = readFileSync(n.issuer.issuerOptions.path), controller = new AbortController(); controller.abort();
  await expect(issuer.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits, controller.signal)).rejects.toThrow();
  expect(readFileSync(n.issuer.issuerOptions.path)).toEqual(before); expect(issuer.status().protection.pending).toBe(false);
  n.issuer.online(3);
  await expect(issuer.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits)).rejects.toThrow();
  expect(issuer.status().protection.pending).toBe(true); expect(() => issuer.preparePolicyObservation()).toThrow('readiness');
  issuer.close(); n.issuer.online(5);
  const reopened = await n.run(() => openProtectedAdmissionIssuerLedger(n.issuer.issuerOptions)); cleanup.push(reopened.close); await reopened.ready();
  expect(reopened.status()).toMatchObject({ allocatedPermits: 0, completedPermits: 0, protection: { pending: false, ready: true } });
  const capacity = await fixture({ maxArchiveBlocks: 1 }), low = capacity.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  const original = readFileSync(capacity.issuer.issuerOptions.path);
  await expect(low.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits)).rejects.toThrow('capacity');
  expect(readFileSync(capacity.issuer.issuerOptions.path)).toEqual(original); expect(low.status().protection.pending).toBe(false);
  const relay = n.relay.owner as Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
  await relay.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, { context, installed: context.genesis, observed: context.genesis }, limits);
  n.select(advances[0]); await expect(relay.observePolicy(n.observation())).rejects.toThrow('newer community policy');
  const fenced = readFileSync(join(n.relay.ownerDirectory, 'admission-spends-v2.jsonl'));
  await expect(relay.write({ issuerKey: genesis.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: createAdmissionRequestBindingV2('search', { fenced: true }) })).rejects.toThrow('retained policy fence');
  expect(readFileSync(join(n.relay.ownerDirectory, 'admission-spends-v2.jsonl'))).toEqual(fenced);
}, 20000);

it.each(['before-intent', 'after-intent', 'before-policy-mirror'] as const)('recovers the exact protected proof after actual process death at %s', async stage => {
  const n = await fixture({ sockets: true });
  const issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  let relay = n.relay.owner as Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
  const migration = await shortMigration(); n.select(advances[0]);
  const trust = { context, installed: advances[0].commitment.next, observed: advances[0].commitment.next };
  if (stage === 'before-policy-mirror') {
    const local = await n.run(() => openAdmissionPolicyStore({ path: join(n.relay.ownerDirectory, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'create-new', now: n.now }));
    await local.install(genesis, authority, { observers: context }); await local.install(advances[0].policy, authority, { advance: advances[0] });
    local.bindProtectedHistory((await import('@resonance/core/history-checkpoint')).historyCheckpointContextId(n.relay.context));
    relay.close(); relay = await n.run(() => openProtectedAdmissionSpendHistory({ ...n.relay.relayOptions, policy: advances[0].policy })); cleanup.push(relay.close); await relay.ready();
    await relay.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, local.freshness()!, limits);
    await relay.backfillPolicyProof({ version: 1, kind: 'advance', advance: advances[0], pages: [] }, local.freshness()!); local.close();
    n.select(migration.advance); relay.close();
    relay = await n.run(() => openProtectedAdmissionSpendHistory({ ...n.relay.relayOptions, policy: migration.advance.policy, policyAdvance: migration.advance, policyPages: migration.pages })); cleanup.push(relay.close); await relay.ready();
  } else {
    await issuer.installPolicy(advances[0].policy, authority, { advance: advances[0] });
    await issuer.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits);
    await issuer.backfillPolicyProof({ version: 1, kind: 'advance', advance: advances[0], pages: [] });
    n.select(migration.advance);
  }
  issuer.close(); relay.close();
  const marker = join(n.directory, 'boundary.txt'), inputPath = join(n.directory, 'child.json'), authorityId = n.funding.status().authorityId;
  const protection = stage === 'before-policy-mirror' ? n.relay.protection : n.issuer.issuerOptions.protection;
  writeFileSync(inputPath, JSON.stringify({ stage, marker, directory: n.relay.ownerDirectory, path: n.issuer.issuerOptions.path,
    privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64'), profile: entries[0].profile,
    encryptionKey: Buffer.from(n.key).toString('hex'), authority, genesis, context, limits, policy: migration.advance.policy, advance: migration.advance, pages: migration.pages.map(page => ({ digest: page.digest, data: Buffer.from(page.bytes).toString('base64url') })), now: n.now(),
    authorityDirectory: join(n.directory, 'authority'), authorityId,
    protection: { ...protection, transport: undefined, signingKey: { publicKey: Buffer.from(protection.signingKey.publicKey).toString('base64'), secretKey: Buffer.from(protection.signingKey.secretKey).toString('base64') } } }));
  n.funding.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/protected-consumer-proof-crash.ts', import.meta.url)), inputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); expect(output).not.toContain('Error:'); expect(readFileSync(marker, 'utf8')).toBe(stage); expect(exit.code === 0).toBe(false);
  n.reopenFunding();
  if (stage === 'before-policy-mirror') {
    const configured = await n.run(() => createConfiguredAdmissionVerifier({ directory: n.relay.ownerDirectory, encryptionKey: n.key, authority, policy: migration.advance.policy, now: n.now, historyProtection: n.relay.protection })); configured.close();
    const local = await n.run(() => openAdmissionPolicyStore({ path: join(n.relay.ownerDirectory, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'open-existing', now: n.now }));
    expect(local.retained().version).toBe(4); expect(local.retained().policy?.version).toBe(3); local.close();
  } else {
    const reopened = await n.run(() => openProtectedAdmissionIssuerLedger(n.issuer.issuerOptions)); cleanup.push(reopened.close); await reopened.ready();
    if (stage === 'before-intent') await reopened.installPolicy(migration.advance.policy, authority, { advance: migration.advance, pages: migration.pages });
    expect(reopened.status().policyFreshness?.installedRevision).toBe(3);
    expect(reopened.status()).toMatchObject({ allocatedPermits: 0, completedPermits: 0, protection: { pending: false, ready: true } });
  }
}, 20000);

async function shortMigration() {
  const noPages = async () => { throw new Error('No earlier v3 pages'); };
  const previous = await resolveAdmissionPolicy({ context, genesis, advances: [advances[0]], selectedHead: advances[0].commitment.next, reader: noPages, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 3, issuedAt: 1021, expiresAt: 5000, activeKey: genesis.activeKey, keys: advances[0].policy.keys }, reader: noPages, limits });
  const reader = async (digest: string) => { const page = plan.pages.find(page => page.digest === digest); if (!page) throw new Error('Missing page'); return page.bytes; };
  const next = await createResolvedAdmissionPolicyAdvance({ previous, policy: await signAdmissionPolicyV3(plan.body, authority, authorityKey.secretKey), key: authorityKey, reader, limits });
  return { ...next, pages: plan.pages };
}

it('binds opaque historical membership to the exact resolved signed body and rejects cloned capabilities', async () => {
  const pages = new Map(migrationPages.map(page => [page.digest, page.bytes]));
  const reader = async (digest: string) => { const bytes = pages.get(digest); if (!bytes) throw new Error('Missing immutable page'); return bytes; };
  const membership = await resolveAdmissionPolicyHistoryMembership({ policy: migrationResolved, issuerKeys: [admissionKeyFingerprint(entries[1].profile.issuerPublicKey)], reader, limits });
  const policy = advances[64].policy;
  expect(admissionPolicyHistoryEntry(policy, membership, admissionKeyFingerprint(entries[1].profile.issuerPublicKey))).toEqual(genesis.keys[1]);
  expect(() => admissionPolicyHistoryEntry(advances[65].policy, membership, admissionKeyFingerprint(entries[1].profile.issuerPublicKey))).toThrow('original authenticated');
  expect(() => admissionPolicyHistoryEntry(policy, structuredClone(membership), admissionKeyFingerprint(entries[1].profile.issuerPublicKey))).toThrow('original authenticated');
});

it('preserves archived coordinator proofs, witness pins and permanent denials through protected v3 reopening', async () => {
  const n = await fixture(); let issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  const permit = await issuer.grantForAssignment(await n.assign(), n.issuerProof(issuer)), batch = await createAdmissionIssuanceBatch(entries[0].profile, 1);
  const response = await issuer.approve(permit, batch.request, n.issuerProof(issuer)); expect(await batch.finalize(response)).toHaveLength(1);
  let relay = n.relay.owner as Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
  const issuerKey = admissionKeyFingerprint(entries[1].profile.issuerPublicKey), set = genesis.keys[1].witnesses!;
  const row = { issuerKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: createAdmissionRequestBindingV2('search', { old: 'protected-role' }) };
  const claim = { setId: admissionWitnessSetId(set), issuerKey, spend: row.spend, action: 'search' as const, requestBinding: row.binding };
  const votes = witnesses.slice(0, 4).map(key => createAdmissionWitnessVote(claim, key));
  const roles = { witness: { version: 2 as const, witness: pub(witnesses[0]), votes: [], retiredIssuerKeys: [] }, coordinator: { version: 2 as const, coordinator: authority, certificates: [], retiredIssuerKeys: [] } };
  await relay.captureRoles(roles, (await relay.planRoleCapture(roles)).approvalDigest);
  await relay.writeRoleDecision({ kind: 'witness-vote', vote: votes[0] });
  await relay.writeAuthorizedSpend(row, { version: 1, votes });
  n.select(advances[0]); await issuer.installPolicy(advances[0].policy, authority, { advance: advances[0] });
  await issuer.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits);
  await issuer.backfillPolicyProof({ version: 1, kind: 'advance', advance: advances[0], pages: [] }); relay.close();
  relay = await n.run(() => openProtectedAdmissionSpendHistory({ ...n.relay.relayOptions, policy: advances[0].policy })); cleanup.push(relay.close); await relay.ready();
  await relay.retireRole('witness', issuerKey, relay.planRoleRetirement('witness', issuerKey).approvalDigest);
  await relay.retire(issuerKey, relay.planRetirement(issuerKey).approvalDigest);
  const trust = { context, installed: advances[0].commitment.next, observed: advances[0].commitment.next };
  await relay.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, trust, limits);
  await relay.backfillPolicyProof({ version: 1, kind: 'advance', advance: advances[0], pages: [] }, trust);
  const noPages = async () => { throw new Error('No earlier v3 pages'); };
  const previous = await resolveAdmissionPolicy({ context, genesis, advances: [advances[0]], selectedHead: trust.installed, reader: noPages, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 3, issuedAt: 1021, expiresAt: 5000, activeKey: genesis.activeKey, keys: advances[0].policy.keys }, reader: noPages, limits });
  const reader = async (digest: string) => { const page = plan.pages.find(page => page.digest === digest); if (!page) throw new Error('Missing page'); return page.bytes; };
  const next = await createResolvedAdmissionPolicyAdvance({ previous, policy: await signAdmissionPolicyV3(plan.body, authority, authorityKey.secretKey), key: authorityKey, reader, limits }); n.select(next.advance);
  await issuer.installPolicy(next.advance.policy, authority, { advance: next.advance, pages: plan.pages });
  expect(await issuer.approve(permit, batch.request, n.issuerProof(issuer))).toEqual(response);
  const inactivePlan = await prepareAdmissionPolicyV3Successor({ previous: next.resolved, next: { revision: 4, issuedAt: 4901, expiresAt: 5000, activeKey: admissionKeyFingerprint(entries[2].profile.issuerPublicKey), keys: next.advance.policy.keys.filter(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) !== genesis.activeKey) }, reader, limits });
  const inactiveReader = async (digest: string) => inactivePlan.pages.find(page => page.digest === digest)?.bytes ?? reader(digest);
  const inactive = await createResolvedAdmissionPolicyAdvance({ previous: next.resolved, policy: await signAdmissionPolicyV3(inactivePlan.body, authority, authorityKey.secretKey), key: authorityKey, reader: inactiveReader, limits });
  n.select(inactive.advance); await issuer.installPolicy(inactive.advance.policy, authority, { advance: inactive.advance, pages: inactivePlan.pages });
  const retirement = issuer.planRetirement(authority); await issuer.retire(authority, retirement.approvalDigest); issuer.close();
  issuer = await n.run(() => openProtectedAdmissionIssuerLedger(n.issuer.issuerOptions)); cleanup.push(issuer.close); await issuer.ready();
  expect(issuer.status()).toMatchObject({ permanentlyRetired: true, allocatedPermits: 1, boundPermits: 1, completedPermits: 1 });
  await expect(issuer.approve(permit, batch.request)).rejects.toThrow('permanently retired');
  const options = { ...n.relay.relayOptions, policy: next.advance.policy, policyAdvance: next.advance, policyPages: plan.pages };
  relay.close(); relay = await n.run(() => openProtectedAdmissionSpendHistory(options)); cleanup.push(relay.close); await relay.ready(); relay.close();
  relay = await n.run(() => openProtectedAdmissionSpendHistory(options)); cleanup.push(relay.close); await relay.ready();
  expect(relay.roleState().coordinator?.certificates).toEqual([{ version: 1, votes }]);
  expect(relay.roleState().witness).toMatchObject({ votes: [], retiredIssuerKeys: [issuerKey] });
  expect(relay.read().image.state.retiredIssuerKeys).toEqual([issuerKey]);
  await expect(relay.writeRoleDecision({ kind: 'coordinator-certificate', certificate: { version: 1, votes } })).rejects.toThrow('unavailable');
  await expect(relay.write(row)).rejects.toThrow();
}, 20000);

it('refuses a real v3 archive checkpoint one byte below its complete encoded history requirement before intent', async () => {
  const migration = await shortMigration();
  const stage = async (n: Awaited<ReturnType<typeof fixture>>) => {
    const issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>; n.select(advances[0]);
    await issuer.installPolicy(advances[0].policy, authority, { advance: advances[0] });
    await issuer.backfillPolicyProof({ version: 1, kind: 'genesis', policy: genesis }, limits);
    await issuer.backfillPolicyProof({ version: 1, kind: 'advance', advance: advances[0], pages: [] });
    return issuer;
  };
  const control = await fixture(), issuer = await stage(control);
  const image = readProtectedIssuerRecoverySource(await issuer.reviewRecoverySource()).minimumEvidence.at(-1)!;
  const head = migration.advance.commitment.next, candidate = { ...image, communityPolicy: migration.advance.policy,
    freshness: { ...image.freshness!, installed: head, observed: head }, policyProof: admissionPolicyProofReference(context, head, limits),
    policyProofAppend: { version: 1, kind: 'advance', advance: migration.advance, pages: migration.pages.map(page => ({ digest: page.digest, data: Buffer.from(page.bytes).toString('base64url') })) } };
  const usage = issuer.status().protection, applied = usage.applied!;
  const required = historyCheckpointEnvelopeByteLength({ context: control.issuer.context, header: { kind: 'checkpoint', generation: 0,
    sequence: applied.sequence + 1, previous: applied.id }, plaintextBytes: Buffer.byteLength(JSON.stringify(candidate)) });
  const constrained = await fixture({ maxArchiveBytes: usage.retainedCiphertextBytes + required - 1 }), low = await stage(constrained);
  constrained.select(migration.advance); const before = readFileSync(constrained.issuer.issuerOptions.path);
  await expect(low.installPolicy(migration.advance.policy, authority, { advance: migration.advance, pages: migration.pages })).rejects.toThrow('capacity');
  expect(readFileSync(constrained.issuer.issuerOptions.path)).toEqual(before);
  expect(low.status()).toMatchObject({ allocatedPermits: 0, policyFreshness: { installedRevision: 2 }, protection: { pending: false } });
}, 20000);

function selectedProofRoot(image: unknown, role: 'admission-issuer' | 'relay-admission-spends', key: Uint8Array) {
  const h = historyCheckpointFixture(), proofContext = { ...h.context, role, authority, policyDigest: `sha256:${admissionPolicyDigest(genesis)}` };
  const root = sealHistoryCheckpoint({ context: proofContext, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: key, signingKey: h.owner });
  const rootId = historyCheckpointEnvelopeId(root), challenge = randomBytes(32).toString('base64url'), freeze = createHistoryFreeze(proofContext, 0, 1, challenge, h.owner);
  const receipts = h.memberKeys.slice(0, 4).map((member, i) => {
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId, generation: 0, replica: proofContext.members[i], challenge,
      issuedAt: 1000, expiresAt: 2000, sequence: 1, envelopeId: null }, proofContext, h.owner);
    return createHistoryExchangeResponse(request, 'frozen', { generation: 0, rootId, sequence: 0, envelopeId: rootId, freeze }, null, proofContext, member);
  });
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation: 0, nextGeneration: 1, receipts, envelopes: [root] }, proofContext, h.owner);
  return { context: proofContext, genesisId: rootId, proposal, encryptionKey: key, blocks: [root] };
}

/** Hold one real RSA-key import, then release it after the operation must already have refused. */
function holdPolicyCrypto(skip: number) {
  let entered!: () => void, release!: () => void, imports = 0;
  const held = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args) => {
    if (args[0] === 'spki' && ++imports === skip + 1) { entered(); await gate; }
    return original(...args);
  });
  return { held, release, restore: () => spy.mockRestore() };
}

it.each(['relay-cancel', 'issuer-cancel', 'relay-deadline', 'issuer-deadline'] as const)('bounds retained proof replay crypto by its original operation at %s', async mode => {
  const n = await fixture(), issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  const issuerImage = readProtectedIssuerRecoverySource(await issuer.reviewRecoverySource()).minimumEvidence[0];
  const relayImage = (n.relay.owner as Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>).read().image;
  const proof = { proofVersion: 1 as const, policyProof: admissionPolicyProofReference(context, context.genesis, limits), policyProofAppend: { version: 1, kind: 'genesis', policy: genesis } };
  const isIssuer = mode.startsWith('issuer'), cancelled = mode.endsWith('cancel'), controller = new AbortController();
  const input = selectedProofRoot(isIssuer ? { ...issuerImage, ...proof } : { ...relayImage, ...proof, policyTrust: { context, installed: context.genesis, observed: context.genesis } }, isIssuer ? 'admission-issuer' : 'relay-admission-spends', n.key);
  // Consume part of the replay deadline before the first await. A later proof budget may not restart it.
  const blocks = { *[Symbol.iterator]() { if (!cancelled) { const until = performance.now() + 80; while (performance.now() < until) { /* bounded local iterable work */ } } yield* input.blocks; } };
  const crypto = holdPolicyCrypto(isIssuer ? 1 : 0);
  let settled = false;
  const work = (isIssuer ? replayProtectedIssuerHistory({ ...input, blocks, authority, profile: entries[0].profile, timeoutMs: 180, signal: controller.signal })
    : replayAdmissionHistory({ ...input, blocks, timeoutMs: 180, signal: controller.signal })).then(() => ({ error: undefined }), error => ({ error })).finally(() => { settled = true; });
  try {
    await crypto.held;
    if (cancelled) controller.abort();
    const result = await Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Replay did not refuse while crypto remained held')), 500))]);
    expect(result.error).toBeInstanceOf(Error); expect(String(result.error)).toMatch(/cancelled|timed out/); expect(settled).toBe(true);
  } finally { crypto.release(); crypto.restore(); await work; }
}, 20000);

it('cancels the first protected issuer install verification and releases busy without an intent', async () => {
  const n = await fixture(), issuer = n.issuer.owner as Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>>;
  n.select(advances[0]);
  const before = readFileSync(n.issuer.issuerOptions.path), controller = new AbortController(), crypto = holdPolicyCrypto(0);
  const work = issuer.installPolicy(advances[0].policy, authority, { advance: advances[0], signal: controller.signal }).then(() => ({ error: undefined }), error => ({ error }));
  try {
    await crypto.held; controller.abort();
    const result = await Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Install did not refuse while its first crypto remained held')), 500))]);
    expect(String(result.error)).toMatch(/cancelled|timed out/);
    expect(readFileSync(n.issuer.issuerOptions.path)).toEqual(before); expect(issuer.status().protection.pending).toBe(false);
    expect(() => issuer.preparePolicyObservation()).not.toThrow();
  } finally { crypto.release(); crypto.restore(); await work; }
  await issuer.installPolicy(advances[0].policy, authority, { advance: advances[0] });
  expect(issuer.status().policyFreshness?.installedRevision).toBe(2);
}, 20000);
