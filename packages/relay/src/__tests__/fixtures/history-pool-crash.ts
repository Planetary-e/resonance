import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';
import { HISTORY_POOL_FILENAME } from '../../history-volunteer-pool.js';
import { HISTORY_VOLUNTEER_FRONTIER_FILENAME } from '../../history-volunteer-frontier.js';

process.once('message', (input: any) => {
  try {
    const service = openHistoryVolunteerService({ ...input.options, localKey: Buffer.from(input.localKey, 'hex'),
      signingKey: { publicKey: Buffer.from(input.member.publicKey, 'hex'), secretKey: Buffer.from(input.member.secretKey, 'hex') } });
    const plan = input.retention && !input.migrate ? service.planGenerationRetirement(input.retention) : service.planPool(2, input.retention);
    const rename = fs.renameSync, remove = fs.rmSync, removeDirectory = fs.rmdirSync, mkdir = fs.mkdirSync;
    let commits = 0;
    const stop = () => process.kill(process.pid, 'SIGKILL');
    process.send!('ready', () => {
      fs.renameSync = (from, to) => {
        const selected = String(to).endsWith(HISTORY_POOL_FILENAME);
        const relocation = /[/\\]history$/.test(String(to));
        if (relocation && input.boundary === 'before-relocation') stop();
        if (selected && commits === 0 && input.boundary === 'before-pool-commit') stop();
        if (selected && commits === 1 && input.boundary === 'before-cleanup-completion') stop();
        rename(from, to);
        if (relocation && input.boundary === 'after-relocation') stop();
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
        const target = input.retention && !input.migrate ? String(path).endsWith('.block') : String(path).endsWith('history-provision.json');
        if (target && input.boundary === 'before-unlink') stop();
        remove(path, options);
        if (input.migrate && String(path).endsWith(HISTORY_VOLUNTEER_FRONTIER_FILENAME) && input.boundary === 'after-legacy-frontier') stop();
        if (target && input.boundary === 'after-unlink') stop();
      };
      fs.rmdirSync = ((...args: Parameters<typeof fs.rmdirSync>) => {
        const result = Reflect.apply(removeDirectory, fs, args);
        if (input.boundary === 'after-directory' && /[/\\](?:history|successor)$/.test(String(args[0]))) stop();
        return result;
      }) as typeof fs.rmdirSync;
      syncBuiltinESMExports();
      if (input.retention && !input.migrate) service.retireGenerations(input.retention, plan.approvalDigest);
      else service.enablePool(2, plan.approvalDigest, input.retention);
      if (input.boundary === 'durable') stop();
      process.send?.('unexpected-completion'); service.close(); process.exit(2);
    });
  } catch (error) { process.send?.({ error: String(error) }); process.exit(1); }
});
