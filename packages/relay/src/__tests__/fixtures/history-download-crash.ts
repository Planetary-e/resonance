import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from '../../history-ancestry-download.js';

process.once('message', async (input: any) => {
  const decode = (key: any) => ({ publicKey: Buffer.from(key.publicKey, 'hex'), secretKey: Buffer.from(key.secretKey, 'hex') });
  const role = createHistoryAncestryDownload({ ...input, signingKey: decode(input.owner), localKey: Buffer.from(input.localKey, 'hex'),
    transport: async (member, frame) => {
      if (member.publicKey !== input.members[0].publicKey) throw new Error('offline');
      return createHistoryExchangeResponse(frame.request, 'block', { generation: 0, rootId: input.proposal.rootId,
        sequence: input.proposal.sequence, envelopeId: input.proposal.envelopeId, freeze: input.proposal.freezes[0].head.freeze },
      input.blocks[frame.request.sequence], input.context, decode(input.member));
    } });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const phase = String(to).endsWith('.block') ? 'block' : String(to).endsWith(HISTORY_DOWNLOAD_FILENAME) ? 'index' : '';
    if (input.boundary === `before-${phase}`) process.kill(process.pid, 'SIGKILL');
    rename(from, to);
    if (input.boundary === `after-${phase}`) process.kill(process.pid, 'SIGKILL');
  };
  syncBuiltinESMExports();
  await role.run({ maxBlocks: 1 });
  process.send!('durable', () => process.kill(process.pid, 'SIGKILL'));
});
process.send!('ready');
