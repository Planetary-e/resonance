import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '../../storage-reservations.js';
const [directory, authorityId, boundary, target] = process.argv.slice(2);
if (boundary === 'competing') {
  try { const authority = openStorageReservationAuthority({ directory, mode: 'open-existing', authorityId }); authority.close(); process.exitCode = 2; }
  catch (error) { if (!String(error).includes('already open')) throw error; }
} else {
  const authority = authorityId === 'new' ? undefined : openStorageReservationAuthority({ directory, mode: 'open-existing', authorityId });
  const rename = fs.renameSync, write = fs.writeSync, open = fs.openSync;
  let pendingFd: number | undefined;
  fs.openSync = (path, flags, mode) => { const fd = open(path, flags, mode); if (String(path).endsWith('/reservations.json.next')) pendingFd = fd; return fd; };
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/reservations.json') && boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
    rename(from, to);
    if (String(to).endsWith('/reservations.json') && boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
  };
  if (boundary === 'partial-initial') fs.writeSync = ((fd: number, ...args: unknown[]) => {
    if (fd === pendingFd) { write(fd, Buffer.from('{')); process.kill(process.pid, 'SIGKILL'); }
    return Reflect.apply(write, fs, [fd, ...args]);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  const opened = authority ?? openStorageReservationAuthority({ directory, mode: 'create-new', limitBytes: CONTROL + 100 });
  const lease = opened.reserve({ path: target, component: 'test:child', scope: 'file', maximumBytes: 100 });
  if (boundary === 'reserved') process.kill(process.pid, 'SIGKILL');
  lease.assertWritable(); fs.writeFileSync(target, 'reserved payload'); process.kill(process.pid, 'SIGKILL');
  throw new Error('Expected interrupted process');
}
