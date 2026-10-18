import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { admissionKeyFingerprint, admissionPolicyDigest } from '@resonance/core/admission-policy';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createAdmissionPolicyHeadVote, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';
import { historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { policyObserverFixture } from '../../../../relay/src/__tests__/fixtures/policy-observer-fixture.js';
import { historyCheckpointFixture } from '../../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { openHistoryVolunteerService } from '../../../../relay/src/history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../../../../relay/src/history-agreement-exchange.js';
import { createHistoryCheckpointRecovery } from '../../../../relay/src/history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator } from '../../../../relay/src/history-agreement-coordinator.js';
import { createHistoryAncestryDownload } from '../../../../relay/src/history-ancestry-download.js';
import { createHistoryProvisionCoordinator } from '../../../../relay/src/history-provision-coordinator.js';
import { openProtectedAdmissionIssuerLedger, type ProtectedAdmissionIssuerLedgerOptions } from '../../protected-admission-issuer-ledger.js';
import { deriveAdmissionIssuerEncryptionKey } from '../../admission-issuer-state.js';
import { prepareProtectedIssuerRestore } from '../../admission-issuer-history-restore.js';

/** Real volunteer services and socket protocols; policy-observer votes are controlled signed fixtures. */
export async function protectedIssuerRestoreFixture(register: (close: () => void | Promise<void>) => void) {
  const f = await policyObserverFixture({ policyLifetimeMs: 600000, keyLifetimeMs: 300000 }); register(f.close);
  const h = historyCheckpointFixture(), profile = f.first.keys[0].profile;
  register(() => { h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); });
  const privateKey = await crypto.subtle.importKey('pkcs8', f.issuerPrivateKey.export({ type: 'pkcs8', format: 'der' }),
    { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  const key = await deriveAdmissionIssuerEncryptionKey(privateKey); register(() => { key.fill(0); });
  const context = { ...h.context, role: 'admission-issuer' as const, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(f.first)}` };
  const allocation = await signAdmissionIssuanceAllocation({ version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1',
    community: 'public', epoch: 'one', notBefore: f.now - 1000, issueUntil: f.now + 100000, totalTokenBudget: 4,
    allocations: [{ profile, batchSize: 1, maxPermits: 4 }] }, f.authority, f.key.secretKey);
  const services: ReturnType<typeof openHistoryVolunteerService>[] = [], members: Array<{ publicKey: string; endpoint: string }> = [], agreementMembers: typeof members = [];
  let online = 5, now = f.now;
  const service = (i: number) => { if (i >= online || !services[i]) throw new Error('Volunteer unavailable'); return services[i]; };
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryAgreementReplica({ checkpoint: raw => service(i).checkpoint(raw), exchange: raw => service(i).exchange(raw),
      transfer: raw => service(i).transfer(raw), provision: raw => service(i).provision(raw) }, { maxConnections: 8 }); register(listener.close);
    members.push({ publicKey: context.members[i], endpoint: listener.checkpointEndpoint });
    agreementMembers.push({ publicKey: context.members[i], endpoint: listener.endpoint });
  }
  const options: ProtectedAdmissionIssuerLedgerOptions = { path: join(f.directory, 'owner', 'issuer.json'), expectedProfile: profile, privateKey,
    expectedAllocationAuthority: f.authority, now: () => now,
    protection: { context, signingKey: h.owner, members, writerDirectory: join(f.directory, 'owner', 'writer'), timeoutMs: 10000 } };
  let ledger = await openProtectedAdmissionIssuerLedger({ ...options, initialize: { allocation, communityPolicy: f.first, observers: f.context },
    protection: { ...options.protection, initializeWriter: true, initializeArchive: true } }); register(() => ledger.close());
  const genesis = ledger.enrollment().root, genesisId = historyCheckpointEnvelopeId(genesis);
  for (let i = 0; i < 5; i++) {
    const volunteer = openHistoryVolunteerService({ directory: join(f.directory, `volunteer-${i}`), context, genesisId,
      localKey: randomBytes(32), signingKey: h.memberKeys[i], initialize: genesis }); services.push(volunteer); register(volunteer.close);
  }
  let currentRoot: HistoryCheckpointEnvelope = genesis, currentOptions = options;
  const proof = (head: AdmissionPolicyHead = f.context.genesis) => {
    const { query } = ledger.preparePolicyObservation();
    return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const,
      votes: f.keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, f.context, key, now)) } };
  };
  const assign = () => signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority: f.authority,
    allocationDigest: admissionIssuanceAllocationDigest(allocation), community: 'public', epoch: 'one', claimHandle: randomBytes(32).toString('base64url'),
    issuerKeyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey) }, allocation, f.authority, f.key.secretKey);

  async function recover() {
    const generation = currentRoot.generation, rootId = historyCheckpointEnvelopeId(currentRoot), nextGeneration = generation + 1;
    const recovery = createHistoryCheckpointRecovery({ directory: join(f.directory, `freeze-${generation}`), localKey: key, context, signingKey: h.owner,
      rootId, generation, nextGeneration, members, initialize: true, timeoutMs: 10000 }); register(recovery.close);
    const frozen = await recovery.prepare(), proposal = createHistorySuccessorProposal(frozen, context, h.owner);
    const agreement = createHistoryAgreementCoordinator({ directory: join(f.directory, `agreement-${generation}`), localKey: key, context, signingKey: h.owner,
      rootId, generation, nextGeneration, members: agreementMembers, initialize: { proposal }, timeoutMs: 10000,
      historyTransfer: { retained: () => frozen.envelopes } }); register(agreement.close);
    const certificate = await agreement.run(), selected = agreement.read().selected!;
    const root = createHistoryContinuationRoot(selected, certificate, context);
    const download = createHistoryAncestryDownload({ directory: join(f.directory, `download-${generation}`), localKey: key, context,
      signingKey: h.owner, proposal: selected, members, initialize: true, timeoutMs: 10000 }); register(download.close);
    // Only the production downloader supplies ancestry; no owner archive or manually constructed child stores.
    await download.run({ maxBlocks: 10001 });
    if (!download.read().complete) throw new Error('Fixture ancestry download incomplete');
    const blocks = [...download.blocks()];
    const provision = createHistoryProvisionCoordinator({ directory: join(f.directory, `provision-${generation}`), localKey: key, context,
      signingKey: h.owner, root, members: agreementMembers, initialize: true, timeoutMs: 10000 }); register(provision.close);
    const receipts = await provision.run();
    const destination = { path: join(f.directory, `restored-${nextGeneration}`, 'issuer.json'), writerDirectory: join(f.directory, `restored-${nextGeneration}`, 'writer') };
    const restoreOptions = { destination, context, genesisId, profile, authority: f.authority, encryptionKey: key, continuation: root, blocks };
    currentRoot = root;
    return { root, blocks, receipts, restoreOptions, downloadStatus: download.read(), async restore() {
      const preparation = await prepareProtectedIssuerRestore(restoreOptions);
      currentOptions = { ...options, path: destination.path, protection: { ...options.protection, writerDirectory: destination.writerDirectory } };
      ledger = await openProtectedAdmissionIssuerLedger({ ...currentOptions, restore: { preparation, approvedDigest: preparation.review.approvalDigest },
        protection: { ...currentOptions.protection, initializeWriter: true, initializeArchive: true } });
      return preparation;
    } };
  }
  return { ...f, authorityKey: f.key, observerContext: f.context, profile, privateKey, key, context, genesis, options, allocation, members, services, proof, assign, recover,
    get ledger() { return ledger; }, get currentOptions() { return currentOptions; },
    online(count: number) { online = count; }, clock(value: number) { now = value; },
    loseOwner() { ledger.close(); rmSync(currentOptions.path, { force: true }); rmSync(currentOptions.protection.writerDirectory, { recursive: true, force: true }); },
    async reopen() { ledger.close(); ledger = await openProtectedAdmissionIssuerLedger(currentOptions); return ledger; } };
}
