import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../../history-checkpoint-store.js';

const [raw, mode] = process.argv.slice(2), input = JSON.parse(raw);
const options = { ...input.options, localKey: Buffer.from(input.localKey, 'hex') };
const owner = { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') };
const store = openHistoryCheckpointStore(options), previous = store.read().envelopes.at(-1)!;
const envelope = sealHistoryCheckpoint({ context: options.context, encryptionKey: Buffer.from(input.key, 'hex'), signingKey: owner,
  header: { kind: 'delta', sequence: previous.sequence + 1, generation: previous.generation, previous: historyCheckpointEnvelopeId(previous) },
  plaintext: Buffer.from('crash-preserved-spend') });
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if ((mode === 'before-index' && String(to).endsWith('.block'))
    || (mode === 'after-index' && String(to).endsWith(HISTORY_MANIFEST_FILENAME))) process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
process.send!({ id: historyCheckpointEnvelopeId(envelope) }, () => {
  store.append(envelope);
  if (mode === 'frozen') store.freeze(createHistoryFreeze(options.context, 0, 1, randomBytes(32).toString('base64url'), owner));
  process.send!('stored');
  setInterval(() => {}, 1000);
});
