import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createRetainedHistoryCheckpointWriter } from '../../history-retained-writer.js';
import { HISTORY_WRITER_FILENAME } from '../../history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../../history-writer-archive.js';

process.once('message', async (input: any) => {
  try {
    const writer = createRetainedHistoryCheckpointWriter({ ...input.options, localKey: Buffer.from(input.localKey, 'hex'),
      signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') } });
    const rename = fs.renameSync; let writerRenames = 0;
    fs.renameSync = (from, to) => {
      const file = String(to);
      const phase = file.endsWith(HISTORY_WRITER_FILENAME) ? (++writerRenames === 1 ? 'pending' : 'certificate')
        : file.endsWith('.block') ? 'payload' : file.endsWith(HISTORY_WRITER_ARCHIVE_FILENAME) ? 'index' : '';
      if (input.boundary === `before-${phase}`) process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (input.boundary === `after-${phase}`) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    await writer.replicate(input.delta);
    if (input.boundary !== 'durable') throw new Error('Requested interruption boundary was not reached');
    process.kill(process.pid, 'SIGKILL');
  } catch (error) { process.send!({ error: error instanceof Error ? error.message : 'Writer crash fixture failed' }); process.exitCode = 1; process.disconnect?.(); }
});
process.send!('ready');
