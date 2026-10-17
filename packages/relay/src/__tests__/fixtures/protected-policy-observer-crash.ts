import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openProtectedPolicyObserver } from '../../protected-policy-observer.js';

process.once('message', async (input: any) => {
  try {
    const directory = fs.realpathSync(input.options.directory);
    const observer = await openProtectedPolicyObserver({ ...input.options, directory, now: () => input.now, mode: 'open-existing' });
    const rename = fs.renameSync, flush = fs.fsyncSync, open = fs.openSync, close = fs.closeSync;
    const path = join(fs.realpathSync(input.options.directory), 'history-writer.json'), fds = new Map<number, string>();
    let publications = 0, published = false;
    const stop = (boundary: string) => {
      if (input.boundary !== boundary) return;
      fs.writeFileSync(input.marker, boundary); process.kill(process.pid, 'SIGKILL');
    };
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { const fd = Reflect.apply(open, fs, args); fds.set(fd, String(args[0])); return fd; }) as typeof fs.openSync;
    fs.closeSync = fd => { fds.delete(fd); close(fd); };
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (String(to) === path) { publications++; published = true; stop(publications === 1 ? 'pending-published' : 'certificate-published'); }
      else if (String(to).endsWith('.block')) stop('ciphertext-published');
      else if (String(to).endsWith('history-writer-payloads.json')) stop('archive-index-published');
    };
    fs.fsyncSync = fd => {
      flush(fd);
      if (published && fds.get(fd) === fs.realpathSync(input.options.directory)) {
        published = false; stop(publications === 1 ? 'pending-flushed' : 'certificate-flushed');
      }
    };
    syncBuiltinESMExports(); await observer.advance(input.advance);
    process.send!({ error: 'Expected interruption not reached' }, () => process.exit(2));
  } catch (error) { process.send!({ error: String(error) }, () => process.exit(1)); }
});
process.send!('ready');
