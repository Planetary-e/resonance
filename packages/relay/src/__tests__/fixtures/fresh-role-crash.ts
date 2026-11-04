import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openAdmissionRoleSetup } from '../../admission-role-setup.js';

const [inputFile, boundary, marker] = process.argv.slice(2), input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const preparation = openAdmissionRoleSetup(input), rename = fs.renameSync, open = fs.openSync, flush = fs.fsyncSync;
const directory = join(fs.realpathSync(join(input.directory, '..')), 'role'), output = join(fs.realpathSync(join(input.output, '..')), 'public.json');
let journalWrites = 0, outputFd: number | undefined;
function stop(at: string) { if (boundary === at) { fs.writeFileSync(marker, at); process.kill(process.pid, 'SIGKILL'); } }
fs.renameSync = (from, to) => {
  rename(from, to);
  if (String(to) === join(directory, 'admission-role-preparation.json')) { journalWrites++; stop(journalWrites === 1 ? 'after-journal' : 'after-prepared'); }
  if (String(to) === join(directory, 'admission-witness-votes.json')) stop('after-role');
};
fs.openSync = ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
  if (String(path) === output) stop('before-public');
  const fd = open(path, flags, mode); if (String(path) === output) outputFd = fd; return fd;
}) as typeof fs.openSync;
fs.fsyncSync = fd => { flush(fd); if (fd === outputFd) stop('after-public'); };
syncBuiltinESMExports();
preparation.apply(preparation.review.approvalDigest); preparation.close();
throw new Error('Fresh role crash boundary was not reached');
