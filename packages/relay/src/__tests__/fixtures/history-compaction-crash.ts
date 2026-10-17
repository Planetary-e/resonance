import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../../history-checkpoint-store.js';

process.once('message', (input: any) => {
  const store = openHistoryCheckpointStore({ ...input.options, localKey: Buffer.from(input.options.localKey, 'hex') });
  const review = store.reviewDigest(), write = fs.writeSync, flush = fs.fsyncSync, rename = fs.renameSync;
  process.send!('ready', () => {
    fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      if (input.boundary === 'before-write') process.kill(process.pid, 'SIGKILL');
      return Reflect.apply(write, fs, args);
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => { flush(fd); if (input.boundary === 'after-file-flush') process.kill(process.pid, 'SIGKILL'); };
    fs.renameSync = (from, to) => {
      if (String(to).endsWith(HISTORY_MANIFEST_FILENAME) && input.boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (String(to).endsWith(HISTORY_MANIFEST_FILENAME) && input.boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports(); store.retainCompactionAnchor(input.certificate, review);
    if (input.boundary === 'durable') process.kill(process.pid, 'SIGKILL');
    process.exit(2);
  });
});
