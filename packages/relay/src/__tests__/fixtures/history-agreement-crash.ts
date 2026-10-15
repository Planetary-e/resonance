import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openHistoryCheckpointStore, HISTORY_MANIFEST_FILENAME } from '../../history-checkpoint-store.js';

// Pass keys and potentially large proofs over IPC, not command-line arguments.
process.once('message', (input: any) => {
  const store = openHistoryCheckpointStore({ ...input.options, localKey: Buffer.from(input.localKey, 'hex') });
  const key = { publicKey: Buffer.from(input.member.publicKey, 'hex'), secretKey: Buffer.from(input.member.secretKey, 'hex') };
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const manifest = String(to).endsWith(HISTORY_MANIFEST_FILENAME);
    if (manifest && input.boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
    rename(from, to);
    if (manifest && input.boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
  };
  syncBuiltinESMExports();
  if (input.transfer) store.exchangeAgreementData(input.frame, key, () => input.now);
  else store.exchangeAgreement(input.frame, key, () => input.now);
  // Successful response would now be safe to emit. Simulate losing it before delivery.
  process.send!('durable', () => process.kill(process.pid, 'SIGKILL'));
});
process.send!('ready');
