/** Real separate address spaces: no signature cache is shared with the owner or other replicas. */
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { createHistoryAgreementReplica } from '../../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { listenHistoryAgreementReplica } from '../../history-agreement-exchange.js';
import type { HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import type { HistorySuccessorProposal } from '@resonance/core/history-successor';
import type { HistoryReplicaEndpoint } from '../../history-checkpoint-exchange.js';

interface Input {
  role: 'replica' | 'owner'; directory: string; localKey: string;
  context: HistoryCheckpointContext; rootId: string;
  signingKey: { publicKey: string; secretKey: string };
  proposal: HistorySuccessorProposal; members: HistoryReplicaEndpoint[];
}

process.once('message', async (input: Input) => {
  try {
    const signingKey = { publicKey: Buffer.from(input.signingKey.publicKey, 'hex'), secretKey: Buffer.from(input.signingKey.secretKey, 'hex') };
    const common = { directory: input.directory, localKey: Buffer.from(input.localKey, 'hex'), context: input.context,
      rootId: input.rootId, generation: 0, signingKey };
    if (input.role === 'replica') {
      const store = openHistoryCheckpointStore({ ...common, replica: signingKey.publicKey.toString('base64url') });
      const role = createHistoryAgreementReplica({ ...common, store });
      const listener = await listenHistoryAgreementReplica(role, { connectionTimeoutMs: 30_000 });
      process.send!({ endpoint: listener.endpoint });
    } else {
      const owner = createHistoryAgreementCoordinator({ ...common, nextGeneration: 1, members: input.members,
        initialize: { proposal: input.proposal, view: 2 }, historyTransfer: {} });
      try {
        const certificate = await owner.run();
        process.send!({ certificate, selected: owner.read().selected });
      } finally { owner.close(); process.disconnect!(); }
    }
  } catch (error) { process.stderr.write(`${String(error)}\n`); process.exit(1); }
});
process.send!('ready');
