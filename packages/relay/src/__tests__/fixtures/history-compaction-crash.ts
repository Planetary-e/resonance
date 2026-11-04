import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from '../../history-checkpoint-exchange.js';

process.once('message', (input: any) => {
  const store = openHistoryCheckpointStore({ ...input.options, localKey: Buffer.from(input.options.localKey, 'hex') });
  const review = store.reviewDigest(), write = fs.writeSync, flush = fs.fsyncSync, rename = fs.renameSync, remove = fs.rmSync;
  const retirement = input.retire ? store.planPrefixRetirement() : undefined;
  const role = input.frame ? createHistoryCheckpointReplica({ context: input.options.context, store,
    signingKey: { publicKey: Buffer.from(input.signingKey.publicKey, 'hex'), secretKey: Buffer.from(input.signingKey.secretKey, 'hex') } }) : undefined;
  let manifests = 0;
  process.send!('ready', () => {
    fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      if (input.boundary === 'before-write') process.kill(process.pid, 'SIGKILL');
      return Reflect.apply(write, fs, args);
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => { flush(fd); if (input.boundary === 'after-file-flush') process.kill(process.pid, 'SIGKILL'); };
    fs.renameSync = (from, to) => {
      const manifest = String(to).endsWith(HISTORY_MANIFEST_FILENAME);
      if (manifest) manifests++;
      if (input.frame && manifest && manifests === 2 && input.boundary === 'before-retirement') process.kill(process.pid, 'SIGKILL');
      if (String(to).endsWith(HISTORY_MANIFEST_FILENAME) && input.boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (input.frame && manifest && ((manifests === 1 && input.boundary === 'after-install')
        || (manifests === 2 && input.boundary === 'after-retirement'))) process.kill(process.pid, 'SIGKILL');
      if (String(to).endsWith('.block') && input.boundary === 'block-renamed') process.kill(process.pid, 'SIGKILL');
      if (String(to).endsWith(HISTORY_MANIFEST_FILENAME) && input.boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
    };
    fs.rmSync = (path, options) => {
      if (String(path).endsWith('.block') && input.boundary === 'before-unlink') process.kill(process.pid, 'SIGKILL');
      remove(path, options);
      if (String(path).endsWith('.block') && input.boundary === 'after-unlink') process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    if (role) role.exchange(input.frame);
    else if (retirement) store.retirePrefix(retirement.approvalDigest);
    else if (input.checkpoint) store.installCheckpoint(input.checkpoint, input.certificate, review);
    else store.retainCompactionAnchor(input.certificate, review);
    if (input.boundary === 'durable') process.kill(process.pid, 'SIGKILL');
    process.exit(2);
  });
});
