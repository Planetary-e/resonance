import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openProtectedAdmissionSpendHistory } from '../../protected-admission-history.js';

process.once('message', async (input: any) => {
  try {
    const history = await openProtectedAdmissionSpendHistory({ ...input.options, encryptionKey: Buffer.from(input.key, 'hex'), now: () => input.time,
      protection: { ...input.protection, signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') } } });
    await history.ready();
    const rename = fs.renameSync; let renames = 0;
    fs.renameSync = (from, to) => {
      const phase = String(to).endsWith('admission-spends-v2.jsonl') ? (++renames === 1 ? 'intent' : 'apply') : '';
      if (input.boundary === `before-${phase}`) process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (input.boundary === `after-${phase}`) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports(); await history.write(input.row);
    if (input.boundary !== 'durable') throw new Error('Requested interruption boundary was not reached');
    process.kill(process.pid, 'SIGKILL');
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.message : 'Protected admission crash fixture failed' });
    process.exitCode = 1; process.disconnect?.();
  }
});
process.send!('ready');
