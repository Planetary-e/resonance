import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openAdmissionHistoryActivation } from '../../admission-history-activation.js';

process.once('message', async (input: any) => {
  try {
    const activation = await openAdmissionHistoryActivation({ ...input.options, encryptionKey: Buffer.from(input.key, 'hex'),
      protection: { ...input.options.protection, signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') } } });
    const rename = fs.renameSync, targetPath = join(fs.realpathSync(input.options.runtimeDirectory), 'admission-community-policy.json'); let count = 0;
    fs.renameSync = (from, to) => {
      const target = String(to) === targetPath;
      if (target && input.boundary === `before-${++count}`) process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (target && input.boundary === `after-${count}`) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports(); await activation.apply(activation.review().approvalDigest);
    throw new Error('Activation interruption boundary was not reached');
  } catch (error) { process.send!({ error: error instanceof Error ? error.message : 'Activation crash fixture failed' }); process.exitCode = 1; process.disconnect?.(); }
});
process.send!('ready');
