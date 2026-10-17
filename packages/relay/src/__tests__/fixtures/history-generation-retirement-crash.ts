import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';
import { HISTORY_VOLUNTEER_FRONTIER_FILENAME } from '../../history-volunteer-frontier.js';

process.once('message', (input: any) => {
  try {
    const service = openHistoryVolunteerService({ ...input.options, localKey: Buffer.from(input.localKey, 'hex'),
      signingKey: { publicKey: Buffer.from(input.member.publicKey, 'hex'), secretKey: Buffer.from(input.member.secretKey, 'hex') } });
    const plan = service.planGenerationRetirement(input.retention), write = fs.writeSync, rename = fs.renameSync, remove = fs.rmSync,
      removeDirectory = fs.rmdirSync, open = fs.openSync;
    let journalFile: number | undefined;
    process.send!('ready', () => {
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = Reflect.apply(open, fs, args);
        if (/\.history-volunteer-frontier\.json\.[a-f0-9]{16}\.tmp$/.test(String(args[0]))) journalFile = fd;
        return fd;
      }) as typeof fs.openSync;
      fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
        if (input.boundary === 'before-lock-write' || input.boundary === 'before-journal-write' && args[0] === journalFile) process.kill(process.pid, 'SIGKILL');
        return Reflect.apply(write, fs, args);
      }) as typeof fs.writeSync;
      fs.renameSync = (from, to) => {
        const selected = String(to).endsWith(HISTORY_VOLUNTEER_FRONTIER_FILENAME);
        if (selected && input.boundary === 'before-commit') process.kill(process.pid, 'SIGKILL');
        rename(from, to);
        if (selected && input.boundary === 'after-commit') process.kill(process.pid, 'SIGKILL');
      };
      fs.rmSync = (path, options) => {
        const block = String(path).endsWith('.block');
        if (block && input.boundary === 'before-unlink') process.kill(process.pid, 'SIGKILL');
        remove(path, options);
        if (block && input.boundary === 'after-unlink') process.kill(process.pid, 'SIGKILL');
      };
      fs.rmdirSync = ((...args: Parameters<typeof fs.rmdirSync>) => {
        const result = Reflect.apply(removeDirectory, fs, args);
        if (input.boundary === 'after-directory') process.kill(process.pid, 'SIGKILL');
        return result;
      }) as typeof fs.rmdirSync;
      syncBuiltinESMExports(); service.retireGenerations(input.retention, plan.approvalDigest);
      if (input.boundary === 'durable') process.kill(process.pid, 'SIGKILL');
      process.send?.('unexpected-completion'); service.close(); process.exit(2);
    });
  } catch { process.send?.('error'); process.exit(1); }
});
