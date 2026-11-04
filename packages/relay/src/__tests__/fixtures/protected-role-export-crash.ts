import fs from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { runAdmissionHistoryCommand } from '../../admission-history-command.js';

const [file, boundary, marker] = process.argv.slice(2), args: string[] = JSON.parse(fs.readFileSync(file, 'utf8'));
const plan = await runAdmissionHistoryCommand('owner-role-key-plan', args);
const open = fs.openSync, flush = fs.fsyncSync, output = join(fs.realpathSync(dirname(args[6])), basename(args[6]));
let outputFd: number | undefined;
function stop(at: string) { if (boundary === at) { fs.writeFileSync(marker, at); process.kill(process.pid, 'SIGKILL'); } }
fs.openSync = ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
  if (String(path) === output) stop('before-private');
  const fd = open(path, flags, mode); if (String(path) === output) outputFd = fd; return fd;
}) as typeof fs.openSync;
fs.fsyncSync = fd => { flush(fd); if (fd === outputFd) stop('after-private'); };
syncBuiltinESMExports();
await runAdmissionHistoryCommand('owner-role-key-export', ['--approve', String(plan.result.approvalDigest), ...args]);
throw new Error('Protected role key export crash boundary was not reached');
