import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { generateIdentity } from '@resonance/core';
import { createIdentityManager } from '../../identity.js';

process.once('message', async (input: any) => {
  try {
    input.path = join(fs.realpathSync(dirname(input.path)), basename(input.path));
    const manager = createIdentityManager(input.path);
    if (input.mode === 'race') {
      try {
        const identity = await manager.create('password');
        process.send!({ created: identity.did }, () => process.exit(0)); identity.secretKey.fill(0);
      } catch (error) { process.send!({ refused: String(error) }, () => process.exit(0)); }
      return;
    }
    const identity = input.replace ? await manager.load('old password') : generateIdentity();
    fs.writeFileSync(input.expected, identity.did);
    const open = fs.openSync, close = fs.closeSync, write = fs.writeSync, flush = fs.fsyncSync;
    const link = fs.linkSync, rename = fs.renameSync, unlink = fs.unlinkSync;
    const paths = new Map<number, string>(); let published = false;
    const stop = (boundary: string) => {
      if (input.boundary !== boundary) return;
      fs.writeFileSync(input.marker, boundary);
      if (input.mode === 'kill') process.kill(process.pid, 'SIGKILL');
      throw new Error(`Injected failure: ${boundary}`);
    };
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(open, fs, args), path = String(args[0]); paths.set(fd, path);
      if (path === `${input.path}.next` && args[1] === 'wx') stop('candidate-opened');
      return fd;
    }) as typeof fs.openSync;
    fs.closeSync = fd => { paths.delete(fd); close(fd); };
    fs.writeSync = ((fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
      const path = paths.get(fd), role = path === `${input.path}.pending` ? 'intent' : path === `${input.path}.next` ? 'candidate' : undefined;
      if (role && input.boundary === `${role}-partial`) {
        const written = write(fd, bytes, offset, Math.min(length, 19), position); stop(`${role}-partial`); return written;
      }
      const written = write(fd, bytes, offset, length, position);
      if (role) stop(`${role}-written`); return written;
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => {
      flush(fd); const path = paths.get(fd);
      if (path === `${input.path}.pending`) stop('intent-flushed');
      if (path === `${input.path}.next`) stop('candidate-flushed');
      if (published && path === dirname(input.path)) stop('directory-after-publication');
    };
    fs.linkSync = (from, to) => { link(from, to); if (String(to) === input.path) { published = true; stop('published'); } };
    fs.renameSync = (from, to) => { rename(from, to); if (String(to) === input.path) { published = true; stop('published'); } };
    fs.unlinkSync = path => {
      unlink(path);
      if (String(path) === `${input.path}.next`) stop('candidate-removed');
      if (String(path) === `${input.path}.pending`) stop('intent-removed');
    };
    syncBuiltinESMExports();
    await manager.save(identity, 'new password'); identity.secretKey.fill(0);
    process.send!({ error: 'Expected interruption did not happen' }, () => process.exit(2));
  } catch (error) { process.send!({ error: String(error) }, () => process.exit(input.mode === 'throw' ? 0 : 1)); }
});
process.send!('ready');
