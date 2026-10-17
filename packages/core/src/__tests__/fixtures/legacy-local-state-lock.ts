/** Frozen pre-directory ownership behavior, used only for cross-version tests. */
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
export function acquireLegacyLocalStateLock(path: string) {
  const lock = `${path}.lock`, recovery = `${path}.recovery`, owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });
  const read = () => {
    const stat = lstatSync(lock);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Local owner lock must be a bounded ordinary file');
    return readFileSync(lock, 'utf8');
  };
  const claim = () => {
    const fd = openSync(lock, 'wx', 0o600);
    try { const bytes = Buffer.from(owner); for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset); fsyncSync(fd); }
    catch (error) { rmSync(lock, { force: true }); throw error; } finally { closeSync(fd); }
  };
  if (existsSync(recovery)) throw new Error('Legacy recovery needs inspection');
  try { claim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const guard = openSync(recovery, 'wx', 0o600);
    try {
      if (existsSync(lock)) {
        const previous = JSON.parse(read()); if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid legacy owner');
        let dead = false; try { process.kill(previous.pid, 0); } catch (cause) { dead = (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new Error('Legacy owner is already open'); rmSync(lock);
      }
      claim();
    } finally { closeSync(guard); rmSync(recovery, { force: true }); }
  }
  return () => { if (existsSync(lock) && read() === owner) rmSync(lock); };
}
