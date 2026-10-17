import fs from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { writeOperatorJsonAtomic } from '../../admission-operator-files.js';
const [directory, authorityId, target, boundary] = process.argv.slice(2);
const authority = openStorageReservationAuthority({ directory, mode: 'open-existing', authorityId });
const open = fs.openSync, write = fs.writeSync, rename = fs.renameSync;
let temporaryFd: number | undefined;
fs.openSync = (path, flags, mode) => {
  const fd = open(path, flags, mode), selected = String(path);
  if (dirname(selected) === dirname(target) && basename(selected).startsWith(`.${basename(target)}.`) && selected.endsWith('.tmp')) temporaryFd = fd;
  return fd;
};
fs.writeSync = ((fd: number, ...args: unknown[]) => {
  if (fd === temporaryFd && boundary === 'partial-write') { write(fd, Buffer.from('{')); process.kill(process.pid, 'SIGKILL'); }
  return Reflect.apply(write, fs, [fd, ...args]);
}) as typeof fs.writeSync;
fs.renameSync = (from, to) => {
  if (String(to) === target && boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
  rename(from, to);
  if (String(to) === target && boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
withStorageReservationAuthority(authority, () => writeOperatorJsonAtomic(target, { revision: 1 }, 256));
throw new Error('Expected interrupted settings process');
