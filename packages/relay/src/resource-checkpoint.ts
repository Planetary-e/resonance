/** Small local resource counters, protected by the managed runtime's single-writer claim.
 * These checkpoints do not authorize protocol recovery or reserve shared storage. */
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, writeSync, type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';

export const RESOURCE_CHECKPOINT_BYTES = 4096;
function present(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function regular(stat: Stats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > RESOURCE_CHECKPOINT_BYTES) {
    throw new Error('Resource checkpoint must be a bounded ordinary file');
  }
}
function readBytes(path: string): Buffer | undefined {
  const initial = present(path); if (!initial) return undefined; regular(initial);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = fstatSync(fd); regular(stat);
    if (stat.dev !== initial.dev || stat.ino !== initial.ino) throw new Error('Resource checkpoint changed while opening');
    const bytes = Buffer.alloc(RESOURCE_CHECKPOINT_BYTES + 1); let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd), named = present(path);
    if (used > RESOURCE_CHECKPOINT_BYTES || used !== stat.size || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || !named
      || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new Error('Resource checkpoint changed while reading');
    }
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}

/** The previous file remains authoritative if a replacement was interrupted.
 * A partial first write cannot be mistaken for unused/reset counters. */
export function openResourceCheckpoint<T>(path: string, validate: (value: unknown) => value is T) {
  const reservation = reserveManagedStorage({ path, component: 'resource-checkpoint', scope: 'file', maximumBytes: 2 * RESOURCE_CHECKPOINT_BYTES });
  const temporary = `${path}.next`;
  let expected = readBytes(path), value: T | undefined, failed = false;
  const pending = present(temporary);
  if (pending) { regular(pending); if (!expected) throw new Error('Initial resource checkpoint was interrupted; retain it for inspection'); }
  if (expected) {
    let parsed: unknown;
    try { parsed = JSON.parse(expected.toString('utf8')); }
    catch { throw new Error('Resource checkpoint is not valid JSON'); }
    if (!validate(parsed)) throw new Error('Resource checkpoint has invalid counters');
    value = parsed;
  }
  return {
    read() { if (failed) throw new Error('Resource checkpoint write failed; reopen before reading'); return value; },
    write(next: T) {
      if (failed) throw new Error('Resource checkpoint write failed; reopen before granting new work');
      reservation?.assertWritable();
      if (!validate(next)) throw new Error('Resource checkpoint has invalid counters');
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > RESOURCE_CHECKPOINT_BYTES) throw new Error('Resource checkpoint exceeds its byte limit');
      let fd: number | undefined;
      try {
        const directory = dirname(path); mkdirSync(directory, { recursive: true, mode: 0o700 });
        const parent = lstatSync(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Resource checkpoint directory changed');
        const current = readBytes(path);
        if (expected ? !current?.equals(expected) : current !== undefined) throw new Error('Resource checkpoint changed; reopen without resetting counters');
        const oldTemporary = present(temporary);
        if (oldTemporary) {
          regular(oldTemporary);
          if (!expected) throw new Error('Initial resource checkpoint was interrupted; retain it for inspection');
        }
        // Inspect the opened inode before truncating; never follow a link or modify
        // another hard-linked file, including a retained interrupted replacement.
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK
          | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
        const opened = fstatSync(fd), named = lstatSync(temporary); regular(opened); regular(named);
        if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('Resource checkpoint replacement changed');
        ftruncateSync(fd, 0);
        for (let offset = 0; offset < bytes.length;) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          if (count <= 0) throw new Error('Resource checkpoint write stopped'); offset += count;
        }
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, path);
        if (process.platform !== 'win32') {
          const directoryFd = openSync(directory, 'r');
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        }
        expected = bytes; value = next;
      } catch (error) { failed = true; throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
    },
  };
}
