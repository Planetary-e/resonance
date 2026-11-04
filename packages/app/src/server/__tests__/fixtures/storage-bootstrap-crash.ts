import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openDesktopStorageBootstrapReview } from '../../relay-storage-bootstrap.js';
const [raw, boundary] = process.argv.slice(2), options = JSON.parse(raw);
const h = await openDesktopStorageBootstrapReview(options), review = h.review();
const mkdir = fs.mkdirSync, close = fs.closeSync, open = fs.openSync, rename = fs.renameSync;
const files = new Map<number, string>();
fs.mkdirSync = ((path, opts) => { const result = mkdir(path, opts); if (String(path).endsWith('/relay-storage-bootstrap') && boundary === 'directory') process.kill(process.pid, 'SIGKILL'); return result; }) as typeof fs.mkdirSync;
fs.openSync = (path, flags, mode) => { const fd = open(path, flags, mode); files.set(fd, String(path)); return fd; };
fs.closeSync = fd => {
  const path = files.get(fd); files.delete(fd); close(fd);
  if (path?.endsWith('/intent.json') && boundary === 'intent' || path?.endsWith('/attempt.json') && boundary === 'attempt') process.kill(process.pid, 'SIGKILL');
};
fs.renameSync = (from, to) => {
  if (String(to).endsWith('/reservations.json') && boundary === 'before-primary') process.kill(process.pid, 'SIGKILL');
  rename(from, to);
  if (String(to).endsWith('/reservations.json') && boundary === 'after-primary') process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports(); h.apply(review.approvalDigest); process.kill(process.pid, 'SIGKILL');
