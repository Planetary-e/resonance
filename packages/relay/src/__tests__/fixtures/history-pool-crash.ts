import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';
import { HISTORY_POOL_FILENAME } from '../../history-volunteer-pool.js';

process.once('message', (input: any) => {
  try {
    const service = openHistoryVolunteerService({ ...input.options, localKey: Buffer.from(input.localKey, 'hex'),
      signingKey: { publicKey: Buffer.from(input.member.publicKey, 'hex'), secretKey: Buffer.from(input.member.secretKey, 'hex') } });
    const plan = input.retention ? service.planGenerationRetirement(input.retention) : service.planPool(2);
    const rename = fs.renameSync, remove = fs.rmSync, removeDirectory = fs.rmdirSync, mkdir = fs.mkdirSync;
    let commits = 0;
    const stop = () => process.kill(process.pid, 'SIGKILL');
    process.send!('ready', () => {
      fs.renameSync = (from, to) => {
        const selected = String(to).endsWith(HISTORY_POOL_FILENAME);
        if (selected && commits === 0 && input.boundary === 'before-pool-commit') stop();
        if (selected && commits === 1 && input.boundary === 'before-cleanup-completion') stop();
        rename(from, to);
        if (selected) {
          commits++;
          if (commits === 1 && input.boundary === 'after-pool-commit') stop();
          if (commits === 2 && input.boundary === 'after-cleanup-completion') stop();
        }
      };
      fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
        const result = Reflect.apply(mkdir, fs, args);
        if (String(args[0]).endsWith('slot-0') && input.boundary === 'after-slot-directory') stop();
        return result;
      }) as typeof fs.mkdirSync;
      fs.rmSync = (path, options) => {
        const target = input.retention ? String(path).endsWith('.block') : String(path).endsWith('history-provision.json');
        if (target && input.boundary === 'before-unlink') stop();
        remove(path, options);
        if (target && input.boundary === 'after-unlink') stop();
      };
      fs.rmdirSync = ((...args: Parameters<typeof fs.rmdirSync>) => {
        const result = Reflect.apply(removeDirectory, fs, args);
        if (input.boundary === 'after-directory') stop();
        return result;
      }) as typeof fs.rmdirSync;
      syncBuiltinESMExports();
      if (input.retention) service.retireGenerations(input.retention, plan.approvalDigest);
      else service.enablePool(2, plan.approvalDigest);
      if (input.boundary === 'durable') stop();
      process.send?.('unexpected-completion'); service.close(); process.exit(2);
    });
  } catch (error) { process.send?.({ error: String(error) }); process.exit(1); }
});
