import { createHistoryCheckpointRecovery } from '../../history-checkpoint-recovery.js';
import { exchangeHistoryCheckpoint } from '../../history-checkpoint-exchange.js';
const [raw, mode] = process.argv.slice(2), input = JSON.parse(raw);
const recovery = createHistoryCheckpointRecovery({ ...input.options,
  localKey: Buffer.from(input.localKey, 'hex'), signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') },
  initialize: true, timeoutMs: 10000,
  transport: async (member, frame, signal) => {
    const response = await exchangeHistoryCheckpoint(member, frame, signal);
    if (mode === 'pending') throw new Error('lost freeze acknowledgement');
    return response;
  } });
try { await recovery.prepare(); process.send!('prepared'); }
catch { process.send!('pending'); }
setInterval(() => {}, 1000);
