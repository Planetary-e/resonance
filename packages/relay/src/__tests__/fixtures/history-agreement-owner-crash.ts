import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { exchangeHistoryAgreement } from '../../history-agreement-exchange.js';

process.once('message', async (input: any) => {
  const owner = createHistoryAgreementCoordinator({ ...input.options,
    localKey: Buffer.from(input.localKey, 'hex'), signingKey: {
      publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') },
    initialize: { proposal: input.proposal }, transport: async (member, frame, signal) => {
      const result = await exchangeHistoryAgreement(member, frame, signal);
      if (frame.request.action === input.phase) throw new Error('lost phase reply');
      return result;
    } });
  try { await owner.run(); } catch { /* Parent verifies the exact durable phase before killing this process. */ }
  process.send!(owner.read().phase);
  setInterval(() => {}, 1000);
});
process.send!('ready');
