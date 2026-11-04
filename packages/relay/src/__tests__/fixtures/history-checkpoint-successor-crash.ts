import { createHistoryCheckpointSuccessor } from '../../history-checkpoint-successor.js';
import { exchangeHistoryCheckpoint } from '../../history-checkpoint-exchange.js';
const [raw, mode] = process.argv.slice(2), input = JSON.parse(raw);
const successor = createHistoryCheckpointSuccessor({ ...input.options,
  localKey: Buffer.from(input.localKey, 'hex'), signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') },
  initialize: input.preparation, timeoutMs: 20000,
  transport: async (member, frame, signal) => {
    const response = await exchangeHistoryCheckpoint(member, frame, signal);
    if (mode === 'pending' && frame.request.action === 'seal') throw new Error('lost reservation acknowledgement');
    return response;
  } });
try { await successor.reserve(); process.send!('certified'); }
catch { process.send!('pending'); }
setInterval(() => {}, 1000);
