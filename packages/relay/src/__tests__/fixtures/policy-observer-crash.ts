import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { openAdmissionPolicyObserver } from '../../admission-policy-observer.js';
process.once('message', async (input: any) => {
  try {
    const path = join(fs.realpathSync(dirname(input.options.path)), basename(input.options.path));
    const observer = await openAdmissionPolicyObserver({ ...input.options, path, now: () => input.now, mode: 'open-existing' });
    const open = fs.openSync, write = fs.writeSync, close = fs.closeSync, flush = fs.fsyncSync, rename = fs.renameSync;
    const paths = new Map<number, string>(); let published = false;
    const candidate = (value: string | undefined) => !!value && dirname(value) === dirname(path)
      && basename(value).startsWith(`.${basename(path)}.`) && value.endsWith('.tmp');
    const stop = (boundary: string) => {
      if (input.boundary !== boundary) return;
      fs.writeFileSync(input.marker, boundary); process.kill(process.pid, 'SIGKILL');
    };
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(open, fs, args); paths.set(fd, String(args[0]));
      if (candidate(String(args[0]))) stop('candidate-opened'); return fd;
    }) as typeof fs.openSync;
    fs.closeSync = fd => { paths.delete(fd); close(fd); };
    fs.writeSync = ((fd: number, bytes: Buffer, offset: number, length: number) => {
      if (candidate(paths.get(fd)) && input.boundary === 'candidate-partial') {
        const count = write(fd, bytes, offset, Math.min(length, 17)); stop('candidate-partial'); return count;
      }
      const count = write(fd, bytes, offset, length); if (candidate(paths.get(fd))) stop('candidate-written'); return count;
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => { flush(fd); if (candidate(paths.get(fd))) stop('candidate-flushed'); if (published && paths.get(fd) === dirname(path)) stop('directory-flushed'); };
    fs.renameSync = (from, to) => { rename(from, to); if (String(to) === path) { published = true; stop('published'); } };
    syncBuiltinESMExports(); await observer.advance(input.advance);
    process.send!({ error: 'Expected interruption was not reached' }, () => process.exit(2));
  } catch (error) { process.send!({ error: String(error) }, () => process.exit(1)); }
});
process.send!('ready');
