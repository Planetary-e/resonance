/** Bounded, disposable diagnostics. These files never authorize protocol recovery. */
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';

export const DIAGNOSTIC_FILE_BYTES = 1024 * 1024;
export function openBoundedDiagnostics(directory: string, maximumFileBytes = DIAGNOSTIC_FILE_BYTES) {
  if (!isAbsolute(directory) || !Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 256 || maximumFileBytes > DIAGNOSTIC_FILE_BYTES) throw new Error('Invalid diagnostic storage bounds');
  const reservation = reserveManagedStorage({ path: directory, component: 'relay-diagnostics', scope: 'directory', maximumBytes: 2 * maximumFileBytes + 8192 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Diagnostic storage must be an ordinary directory');
  const names = new Set(['current.ndjson', 'previous.ndjson', 'writer.lock', 'writer.recovery']);
  const entries = opendirSync(directory);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (!names.has(entry.name)) throw new Error('Diagnostic storage contains unexpected files');
      const stat = lstatSync(join(directory, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > (entry.name.endsWith('.ndjson') ? maximumFileBytes : 4096)) {
        throw new Error('Diagnostic storage contains an unsafe or oversized file');
      }
    }
  } finally { entries.closeSync(); }
  const release = acquireLocalStateLock(join(directory, 'writer'));
  const current = join(directory, 'current.ndjson'), previous = join(directory, 'previous.ndjson');
  let fd: number | undefined, length = 0, failed = false, closed = false, droppedRecords = 0;
  function open() {
    fd = openSync(current, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumFileBytes) throw new Error('Diagnostic output is unsafe or exceeds its bound');
    length = stat.size;
    if (length) {
      const bytes = Buffer.alloc(length); let offset = 0;
      while (offset < length) { const count = readSync(fd, bytes, offset, length - offset, offset); if (!count) throw new Error('Diagnostic output changed while reopening'); offset += count; }
      const complete = bytes.lastIndexOf(10) + 1;
      if (complete !== length) { ftruncateSync(fd, complete); length = complete; }
    }
  }
  function close() {
    if (closed) return; closed = true;
    try { if (fd !== undefined) { const descriptor = fd; fd = undefined; closeSync(descriptor); } } finally { release(); }
  }
  try { open(); } catch (error) { close(); throw error; }
  return {
    write(line: string) {
      if (closed || failed) { droppedRecords++; return; }
      let bytes = Buffer.from(line.endsWith('\n') ? line : line + '\n');
      // Oversized/untrusted diagnostic content must never grow a log past its cap.
      if (bytes.length > Math.min(16384, maximumFileBytes)) {
        droppedRecords++;
        bytes = Buffer.from(JSON.stringify({ event: 'diagnostic_record_dropped', originalBytes: bytes.length }) + '\n');
      }
      try {
        reservation?.assertWritable();
        const stat = fstatSync(fd!), path = lstatSync(current);
        if (stat.size !== length || stat.nlink !== 1 || path.isSymbolicLink() || path.dev !== stat.dev || path.ino !== stat.ino) throw new Error('Diagnostic output changed');
        if (length + bytes.length > maximumFileBytes) {
          try {
            const old = lstatSync(previous);
            if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1 || old.size > maximumFileBytes) throw new Error('Previous diagnostic output changed');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const descriptor = fd!; fd = undefined; closeSync(descriptor);
          renameSync(current, previous); open();
        }
        for (let offset = 0; offset < bytes.length;) {
          const written = writeSync(fd!, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('Diagnostic output write stopped');
          offset += written;
        }
        length += bytes.length;
      } catch {
        // Diagnostics are disposable: never turn an accepted protocol write into
        // a failure or retry indefinitely because its diagnostic sink is unavailable.
        failed = true; droppedRecords++;
      }
    },
    status() { return { available: !failed && !closed, maximumBytes: 2 * maximumFileBytes, droppedRecords }; },
    close,
  };
}
