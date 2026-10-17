import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openStorageReservationAuthority } from '../../storage-reservations.js';
const [directory, authorityId, path, boundary] = process.argv.slice(2);
const authority = openStorageReservationAuthority({ directory, authorityId, mode: 'open-existing' });
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const selected = String(to).replaceAll('\\', '/').endsWith('/reservations.json');
  if (selected && boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
  rename(from, to);
  if (selected && boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
const targets = [{ path, scope: 'directory' as const }], review = authority.reviewNewScopes(targets);
authority.approveNewScopes(targets, review.approvalDigest);
if (boundary === 'approved') process.kill(process.pid, 'SIGKILL');
throw new Error('Expected new-scope interruption');
