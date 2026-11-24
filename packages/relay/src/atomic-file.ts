import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';

export function writeAtomic(path: string, contents: string): void {
  atomicWrite(path, fd => writeFileSync(fd, contents, 'utf8'));
}

export function writeAtomicJson(path: string, value: unknown): void {
  atomicWrite(path, fd => writeJson(fd, value));
}

function atomicWrite(path: string, write: (fd: number) => void): void {
  const temporary = join(path, '..', `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    write(fd);
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

function writeJson(fd: number, value: unknown): void {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    writeFileSync(fd, JSON.stringify(value), 'utf8');
    return;
  }
  if (typeof value === 'string') {
    writeFileSync(fd, JSON.stringify(value), 'utf8');
    return;
  }
  if (Array.isArray(value)) {
    writeFileSync(fd, '[', 'utf8');
    value.forEach((entry, index) => {
      if (index > 0) writeFileSync(fd, ',', 'utf8');
      writeJson(fd, entry ?? null);
    });
    writeFileSync(fd, ']', 'utf8');
    return;
  }
  if (typeof value === 'object') {
    writeFileSync(fd, '{', 'utf8');
    let written = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      if (written++ > 0) writeFileSync(fd, ',', 'utf8');
      writeFileSync(fd, `${JSON.stringify(key)}:`, 'utf8');
      writeJson(fd, entry);
    }
    writeFileSync(fd, '}', 'utf8');
    return;
  }
  throw new Error('Unsupported atomic JSON value');
}
