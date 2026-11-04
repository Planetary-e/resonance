import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { exchangeHistoryAgreementData } from '../../history-agreement-exchange.js';

process.once('message', async (input: any) => {
  const owner = createHistoryAgreementCoordinator({ ...input.options, localKey: Buffer.from(input.localKey, 'hex'),
    signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') },
    initialize: { proposal: input.proposal }, historyTransfer: { transport: async (member, frame, signal) => {
      const result = await exchangeHistoryAgreementData(member, frame, signal);
      if (member.publicKey === input.target && frame.action === 'stage') {
        process.send!('staged'); return new Promise(() => {});
      }
      return result;
    } } });
  try { await owner.run(); } catch (error) { process.stderr.write(String(error)); process.exit(1); }
});
process.send!('ready');
