import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { prepareAdmissionHistoryRestore } from '../../admission-history-restore.js';
import { openProtectedAdmissionSpendHistory } from '../../protected-admission-history.js';

process.once('message', async (input: any) => {
  try {
    const encryptionKey = Buffer.from(input.key, 'hex'), signingKey = {
      publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') };
    const preparation = await prepareAdmissionHistoryRestore({ ...input.review, encryptionKey, now: () => input.time });
    const rename = fs.renameSync; let images = 0, writers = 0;
    fs.renameSync = (from, to) => {
      const path = String(to), phase = path.endsWith('admission-spends-v2.jsonl') ? (++images === 1 ? 'image' : 'apply')
        : path.endsWith('history-writer.json') ? ['writer', 'pending', 'certificate'][writers++] : '';
      if (input.boundary === `before-${phase}`) process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (input.boundary === `after-${phase}`) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    const history = await openProtectedAdmissionSpendHistory({ directory: input.review.directory, authority: input.review.context.authority,
      policy: input.review.policy, encryptionKey, now: () => input.time, initialize: true,
      protection: { context: input.review.context, signingKey, members: input.members, timeoutMs: 30000, initializeWriter: true,
        restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
    await history.ready();
    if (input.boundary !== 'durable') throw new Error('Requested restoration interruption was not reached');
    process.kill(process.pid, 'SIGKILL');
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.message : 'Admission restore crash fixture failed' });
    process.exitCode = 1; process.disconnect?.();
  }
});
process.send!('ready');
