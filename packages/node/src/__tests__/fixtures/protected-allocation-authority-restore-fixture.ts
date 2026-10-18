import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryCheckpointRecovery } from '../../../../relay/src/history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator } from '../../../../relay/src/history-agreement-coordinator.js';
import { createHistoryAncestryDownload } from '../../../../relay/src/history-ancestry-download.js';
import { createHistoryProvisionCoordinator } from '../../../../relay/src/history-provision-coordinator.js';
import { deriveAdmissionAllocationAuthorityEncryptionKey } from '../../admission-allocation-authority-state.js';
import { replayProtectedAllocationAuthorityHistory } from '../../admission-allocation-authority-history-replay.js';
import { prepareProtectedAllocationAuthorityRestore } from '../../admission-allocation-authority-history-restore.js';
import { openProtectedAdmissionAllocationAuthority, readProtectedAllocationAuthorityRecoverySource, fenceProtectedAllocationAuthorityRecoverySource } from '../../protected-admission-allocation-authority.js';
import { protectedAllocationAuthorityFixture } from './protected-allocation-authority-fixture.js';

export async function protectedAllocationAuthorityRestoreFixture(register: (close: () => void | Promise<void>) => void) {
  const n = await protectedAllocationAuthorityFixture(register);
  const encryptionKey = deriveAdmissionAllocationAuthorityEncryptionKey(n.authorityKey.secretKey, n.authority); register(() => { encryptionKey.fill(0); });
  let journal = n.journal, currentOptions = n.options, currentRoot: HistoryCheckpointEnvelope = n.genesis;
  register(() => journal.close());
  const agreementMembers = n.members.map(member => { const url = new URL(member.endpoint); url.pathname = '/history-agreement'; return { ...member, endpoint: url.toString() }; });
  async function recover(sourceAvailable: boolean) {
    let minimumEvidence: readonly unknown[] | undefined;
    if (sourceAvailable) {
      const source = await journal.reviewRecoverySource(); minimumEvidence = readProtectedAllocationAuthorityRecoverySource(source).minimumEvidence;
      await fenceProtectedAllocationAuthorityRecoverySource(source);
      if (!journal.status().protection.fenced) throw new Error('Source was not fenced');
      journal.close();
    }
    const generation = currentRoot.generation, nextGeneration = generation + 1, rootId = historyCheckpointEnvelopeId(currentRoot);
    const common = { localKey: encryptionKey, context: n.context, signingKey: n.options.protection.signingKey, rootId, generation, nextGeneration, timeoutMs: 10000 };
    const recovery = createHistoryCheckpointRecovery({ ...common, directory: join(n.directory, `freeze-${generation}`), members: n.members, initialize: true }); register(recovery.close);
    const frozen = await recovery.prepare(), proposal = createHistorySuccessorProposal(frozen, n.context, common.signingKey);
    const agreement = createHistoryAgreementCoordinator({ ...common, directory: join(n.directory, `agreement-${generation}`), members: agreementMembers,
      initialize: { proposal }, historyTransfer: { retained: () => frozen.envelopes } }); register(agreement.close);
    const selected = (await agreement.select()).proposal;
    const download = createHistoryAncestryDownload({ directory: join(n.directory, `download-${generation}`), localKey: encryptionKey, context: n.context,
      signingKey: common.signingKey, proposal: selected, members: n.members, initialize: true, timeoutMs: 10000 }); register(download.close);
    await download.run({ maxBlocks: 10001 }); if (!download.read().complete) throw new Error('Incomplete retained authority ancestry');
    const blocks = [...download.blocks()];
    const replayOptions = { context: n.context, genesisId: historyCheckpointEnvelopeId(n.genesis), authority: n.authority, encryptionKey, blocks, minimumEvidence };
    const replay = await replayProtectedAllocationAuthorityHistory({ ...replayOptions, proposal: selected });
    // Semantic validation precedes any agreement confirmation.
    const certificate = await agreement.run(), root = createHistoryContinuationRoot(selected, certificate, n.context);
    const provision = createHistoryProvisionCoordinator({ directory: join(n.directory, `provision-${generation}`), localKey: encryptionKey,
      context: n.context, signingKey: common.signingKey, root, members: agreementMembers, initialize: true, timeoutMs: 10000 }); register(provision.close);
    const receipts = await provision.run();
    const destination = { path: join(n.directory, `restored-${nextGeneration}`, 'authority.json'), writerDirectory: join(n.directory, `restored-${nextGeneration}`, 'writer') };
    const preparation = await prepareProtectedAllocationAuthorityRestore({ ...replayOptions, destination, continuation: root });
    currentOptions = { ...n.options, path: destination.path, protection: { ...n.options.protection, writerDirectory: destination.writerDirectory } };
    journal = await openProtectedAdmissionAllocationAuthority({ ...currentOptions, mode: 'create-new', restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
    currentRoot = root;
    return { preparation, replay, receipts, minimumEvidence, root };
  }
  return { ...n, encryptionKey, get journal() { return journal; }, get currentOptions() { return currentOptions; }, recover,
    async reopen() { journal.close(); journal = await openProtectedAdmissionAllocationAuthority(currentOptions); return journal; },
    loseOwner() { journal.close(); rmSync(currentOptions.path); rmSync(currentOptions.protection.writerDirectory, { recursive: true }); } };
}
