import fs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openAdmissionHistoryRecovery, ADMISSION_RECOVERY_FILENAME } from '../../admission-history-recovery.js';

process.once('message', async (input: any) => {
  const key = Buffer.from(input.encryptionKey, 'hex');
  try {
    const recovery = await openAdmissionHistoryRecovery({ directory: input.directory, encryptionKey: key, genesis: input.genesis,
      protection: { context: input.context, members: input.members, signingKey: {
        publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') } } });
    const original = fs.renameSync, target = join(input.directory, ADMISSION_RECOVERY_FILENAME);
    const nth = input.boundary.includes('intent') ? 1 : input.boundary.includes('register') ? 2 : input.boundary === 'after-confirm' ? 1 : 3;
    const before = input.boundary.startsWith('before-'); let calls = 0;
    fs.renameSync = (from: PathLike, to: PathLike) => {
      const stop = to.toString() === target && ++calls === nth;
      if (stop && before) process.kill(process.pid, 'SIGKILL');
      original(from, to);
      if (stop && !before) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports(); await recovery.advance(); recovery.close();
    process.send?.('boundary-not-reached'); process.exitCode = 2;
  } catch { process.send?.('recovery-failed'); process.exitCode = 1; }
  finally { key.fill(0); process.disconnect?.(); }
});
process.send?.('ready');
