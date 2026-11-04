import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { openDesktopStorageAdoptionReview } from '../../relay-storage-adoption.js';
const [raw, home, count] = process.argv.slice(2); os.homedir = () => home; syncBuiltinESMExports();
const handle = await openDesktopStorageAdoptionReview(JSON.parse(raw)), review = handle.review(), rename = fs.renameSync; let seen = 0;
fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith('/reservations.json') && ++seen === Number(count)) process.kill(process.pid, 'SIGKILL'); };
syncBuiltinESMExports(); handle.apply(review.approvalDigest); throw new Error('Expected interrupted adoption');
