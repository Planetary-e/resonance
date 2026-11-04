import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openResourceCheckpoint } from '../../resource-checkpoint.js';
const [path, boundary] = process.argv.slice(2);
const file = openResourceCheckpoint(path, (value): value is { total: number } => !!value && typeof value === 'object'
  && Number.isSafeInteger((value as { total: number }).total));
const originalWrite = fs.writeSync, originalRename = fs.renameSync;
if (boundary === 'partial') {
  fs.writeSync = ((fd: number) => { originalWrite(fd, Buffer.from('{')); process.kill(process.pid, 'SIGKILL'); return 1; }) as typeof fs.writeSync;
} else {
  fs.renameSync = (from, to) => {
    if (String(to) === path && boundary === 'before-rename') process.kill(process.pid, 'SIGKILL');
    originalRename(from, to);
    if (String(to) === path && boundary === 'after-rename') process.kill(process.pid, 'SIGKILL');
  };
}
syncBuiltinESMExports(); file.write({ total: 20 }); throw new Error('Expected process interruption');
