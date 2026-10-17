import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openAdmissionOwnerSetup } from '../../admission-history-setup.js';
process.once('message', async (message: any) => {
  try {
    const setup = await openAdmissionOwnerSetup(message.input), rename = fs.renameSync, open = fs.openSync, write = fs.writeSync, sync = fs.fsyncSync;
    const directory = setup.review().directory, output = setup.review().output;
    const targets: Record<string, string> = { baseline: join(directory, 'admission-spends-v2.jsonl'), writer: join(directory, 'admission-history-writer', 'history-writer.json'),
      archive: join(directory, 'admission-history-writer', 'payloads', 'history-writer-payloads.json') };
    const [when, stage] = message.boundary.split('-'); let outputFd = -1, observed = false;
    fs.renameSync = (from, to) => {
      const target = !observed && resolve(String(to)) === targets[stage];
      if (target) { observed = true; if (when === 'before') process.kill(process.pid, 'SIGKILL'); }
      rename(from, to); if (target && when === 'after') process.kill(process.pid, 'SIGKILL');
    };
    fs.openSync = ((path: fs.PathLike, ...args: any[]) => {
      const fd = (open as any)(path, ...args); if (resolve(String(path)) === output) outputFd = fd; return fd;
    }) as typeof fs.openSync;
    fs.writeSync = ((fd: number, ...args: any[]) => {
      if (fd === outputFd && message.boundary === 'during-export') { write(fd, Buffer.from('partial')); process.kill(process.pid, 'SIGKILL'); }
      return (write as any)(fd, ...args);
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => { sync(fd); if (fd === outputFd && message.boundary === 'after-export') process.kill(process.pid, 'SIGKILL'); };
    syncBuiltinESMExports(); await setup.apply(setup.review().approvalDigest);
    throw new Error('Setup interruption boundary was not reached');
  } catch (error) { process.send!({ error: error instanceof Error ? error.message : 'Setup crash fixture failed' }); process.exitCode = 1; process.disconnect?.(); }
});
process.send!('ready');
