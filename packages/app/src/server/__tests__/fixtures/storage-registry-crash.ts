import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { retainRelayStorageRegistry } from '../../history-storage-registry.js';

process.on('message', (input: { runtime: string; target: string; boundary: string; file?: boolean }) => {
  try {
    const mkdir = fs.mkdirSync, open = fs.openSync, write = fs.writeSync;
    let manifestFd: number | undefined;
    fs.mkdirSync = ((path, options) => {
      const result = mkdir(path, options);
      if (String(path).endsWith('/relay-storage-locations') && input.boundary === 'initial-directory') process.kill(process.pid, 'SIGKILL');
      return result;
    }) as typeof fs.mkdirSync;
    fs.openSync = (path, flags, mode) => {
      const fd = open(path, flags, mode);
      if (String(path).endsWith('/relay-storage-locations/locations.json')) manifestFd = fd;
      return fd;
    };
    fs.writeSync = ((fd: number, ...args: unknown[]) => {
      if (fd === manifestFd && input.boundary === 'initial-partial-manifest') { write(fd, Buffer.from('partial')); process.kill(process.pid, 'SIGKILL'); }
      return Reflect.apply(write, fs, [fd, ...args]);
    }) as typeof fs.writeSync;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const target = String(to).endsWith('/relay-storage-locations/locations.json');
      if (target && input.boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (target && input.boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    retainRelayStorageRegistry(input.runtime, input.file ? [input.runtime] : [input.runtime, input.target], input.file ? [input.target] : []);
    if (input.boundary === 'registered') process.kill(process.pid, 'SIGKILL');
    if (input.file) fs.writeFileSync(input.target, 'retained output');
    else { fs.mkdirSync(input.target); fs.writeFileSync(join(input.target, 'created-output'), 'retained output'); }
    process.kill(process.pid, 'SIGKILL');
  } catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; process.disconnect?.(); }
});
process.send?.('ready');
