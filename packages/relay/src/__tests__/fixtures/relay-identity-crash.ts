import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { loadOrCreateRelayIdentity, RELAY_IDENTITY_FILENAME } from '../../relay-identity-store.js';

process.once('message', (input: any) => {
  try {
    const directory = fs.realpathSync(input.directory), path = join(directory, RELAY_IDENTITY_FILENAME);
    const candidate = join(directory, `.${RELAY_IDENTITY_FILENAME}.pending`);
    const open = fs.openSync, close = fs.closeSync, write = fs.writeSync, flush = fs.fsyncSync, rename = fs.renameSync;
    const paths = new Map<number, string>(); let published = false, written = false;
    const stop = (boundary: string) => {
      if (input.boundary !== boundary) return;
      fs.writeFileSync(input.marker, boundary);
      if (input.mode === 'kill') process.kill(process.pid, 'SIGKILL');
      throw new Error(`Injected failure: ${boundary}`);
    };
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(open, fs, args); paths.set(fd, String(args[0]));
      if (String(args[0]) === candidate && args[1] === 'wx') stop('candidate-opened');
      return fd;
    }) as typeof fs.openSync;
    fs.closeSync = fd => { paths.delete(fd); close(fd); };
    fs.writeSync = ((fd: number, bytes: Buffer, offset: number, length: number) => {
      if (paths.get(fd) === candidate && input.boundary === 'candidate-partial') {
        const count = write(fd, bytes, offset, Math.min(length, 19)); stop('candidate-partial'); return count;
      }
      const count = write(fd, bytes, offset, length);
      if (paths.get(fd) === candidate) { written = true; stop('candidate-written'); }
      return count;
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => {
      flush(fd);
      if (paths.get(fd) === candidate) stop('candidate-flushed');
      if (written && paths.get(fd) === directory) stop(published ? 'directory-after-publication' : 'directory-before-publication');
    };
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (String(from) === candidate && String(to) === path) { published = true; stop('published'); }
    };
    syncBuiltinESMExports();
    const identity = loadOrCreateRelayIdentity(directory, input.passphrase);
    process.send!({ did: identity.did }, () => process.exit(0)); identity.secretKey.fill(0);
  } catch (error) { process.send!({ error: String(error) }, () => process.exit(input.mode === 'kill' ? 1 : 0)); }
});
process.send!('ready');
