import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';

export function writeAtomic(path: string, contents: string): void {
  const temporary = join(path, '..', `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const bytes = Buffer.from(contents);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      const directoryFd = openSync(join(path, '..'), 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
