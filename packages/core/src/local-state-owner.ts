/** Single-host ownership published as a nonempty directory. The complete PID
 * and nonce are names, so no partially written JSON can become authoritative.
 * rename cannot replace a nonempty directory. rmdir removes only the observed
 * owner's empty marker or an empty released container, never another owner.
 * This requires a local filesystem and cooperating processes on the same host. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, renameSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ownerPattern = /^owner-([1-9][0-9]{0,15})-([a-f0-9]{32})$/;
const candidatePattern = /^([1-9][0-9]{0,15})-([a-f0-9]{32})$/;
function present(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function entries(path: string, maximum: number) {
  const directory = opendirSync(path), names: string[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (names.length === maximum) throw new Error('Local ownership metadata exceeds its entry bound'); names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names;
}
function flush(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function dead(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function parseName(name: string) {
  const match = ownerPattern.exec(name), pid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid local ownership marker');
  return { pid, token: match[2], name };
}
function inspectDirectory(path: string) {
  if (!lstatSync(path).isDirectory()) throw new Error('Local ownership needs an ordinary directory');
  const names = entries(path, 1);
  if (!names.length) return null;
  const owner = parseName(names[0]), marker = join(path, owner.name);
  if (!lstatSync(marker).isDirectory() || entries(marker, 0).length) throw new Error('Local ownership marker must be an empty ordinary directory');
  return owner;
}

/** Recognize only this resource's ownership sidecars, not snapshot temporaries. */
export function isLocalStateOwnershipName(resource: string, name: string) {
  const base = basename(resource);
  for (const suffix of ['lock', 'recovery']) {
    if (name === `${base}.${suffix}`) return true;
    const prefix = `.${base}.${suffix}.claim-`;
    if (name.startsWith(prefix) && candidatePattern.test(name.slice(prefix.length))) return true;
  }
  return false;
}

/** Bounded layout inspection for quiescent storage and authorized retirement.
 * It does not acquire ownership or authorize deletion of a live writer's claim. */
export function inspectLocalStateOwnership(path: string) {
  const stat = lstatSync(path);
  if (stat.isFile() && stat.nlink === 1 && stat.size <= 4096) return { files: [{ path, bytes: stat.size, stat }], directories: [] as string[] };
  const owner = inspectDirectory(path), candidate = /\.claim-([1-9][0-9]{0,15})-([a-f0-9]{32})$/.exec(basename(path));
  if (candidate && !Number.isSafeInteger(Number(candidate[1]))) throw new Error('Invalid local ownership candidate');
  if (candidate && owner && owner.name !== `owner-${candidate[1]}-${candidate[2]}`) throw new Error('Local ownership candidate differs from its marker');
  return { files: [] as Array<{ path: string; bytes: number; stat: Stats }>, directories: [path, ...(owner ? [join(path, owner.name)] : [])] };
}

function removeEmpty(path: string) {
  try { rmdirSync(path); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

function cleanCandidates(path: string) {
  const parent = dirname(path), prefix = `.${basename(path)}.claim-`;
  // The shared parent may hold bounded history payloads. Limit the scan itself,
  // as well as candidates, without interpreting arbitrary files as ownership.
  const names = entries(parent, 100_000).filter(name => name.startsWith(prefix));
  if (names.length > 128) throw new Error('Too many interrupted local ownership candidates; inspect them');
  for (const name of names) {
    const match = candidatePattern.exec(name.slice(prefix.length));
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Invalid local ownership candidate');
    const candidate = join(parent, name), owner = inspectDirectory(candidate);
    if (owner && owner.name !== `owner-${match[1]}-${match[2]}`) throw new Error('Local ownership candidate differs from its marker');
    if (!dead(Number(match[1]))) continue;
    if (owner) removeEmpty(join(candidate, owner.name));
    removeEmpty(candidate);
  }
}

function directoryClaim(path: string, owner: string) {
  const parent = dirname(path);
  if (!lstatSync(parent).isDirectory()) throw new Error('Local ownership parent must be an ordinary directory');
  cleanCandidates(path);
  const candidate = join(parent, `.${basename(path)}.claim-${owner.slice(6)}`), marker = join(candidate, owner);
  let published = false, created = false;
  try {
    mkdirSync(candidate, { mode: 0o700 }); created = true; mkdirSync(marker, { mode: 0o700 }); flush(candidate);
    for (let attempt = 0; attempt < 8; attempt++) {
      try { renameSync(candidate, path); published = true; break; }
      catch (error) { if (!present(path)) throw error; }
      const previous = inspectDirectory(path);
      if (previous && !dead(previous.pid)) throw new Error('Encrypted outbox is already open');
      // An observed marker has a unique nonce. If another contender already
      // replaced it, removing this exact name cannot touch the new owner.
      if (previous) removeEmpty(join(path, previous.name));
      removeEmpty(path); // A concurrently published nonempty claim cannot be removed.
    }
    if (!published) throw new Error('Local ownership is contended; retry after the other process settles');
    flush(parent);
  } catch (error) {
    if (published) { removeEmpty(join(path, owner)); removeEmpty(path); }
    throw error;
  } finally {
    if (!published && created && present(candidate)) { removeEmpty(marker); removeEmpty(candidate); }
  }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (!removeEmpty(join(path, owner))) throw new Error('Local ownership marker changed; preserve it for inspection');
    // A different valid owner may have replaced our now-empty container. Its
    // claim must remain; unexpected contents instead signal damaged ownership.
    if (!removeEmpty(path)) {
      try { inspectDirectory(path); }
      catch (error) {
        // Our marker is already gone. A subsequent owner may publish and then
        // release its claim before this validation reaches the directory or
        // marker. Its disappearance cannot revoke the lock we just acquired.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
}

function readLegacyOwner(path: string) {
  const ordinary = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.size <= 4096;
  const before = lstatSync(path); if (!ordinary(before)) throw new Error('Local owner lock must be a bounded ordinary file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = fstatSync(fd); if (!ordinary(stat) || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Local owner lock changed');
    const bytes = Buffer.alloc(4097); let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd), named = lstatSync(path);
    if (used !== stat.size || used > 4096 || !ordinary(after) || !ordinary(named) || stat.size !== after.size
      || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('Local owner lock changed');
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, used).toString('utf8')); } catch { throw new Error('Legacy local ownership is incomplete; preserve it for inspection'); }
    if (!value || typeof value !== 'object' || !('pid' in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1) throw new Error('Invalid legacy local ownership');
    return Number(value.pid);
  } finally { closeSync(fd); }
}

/** The recovery directory excludes legacy file-lock recovery too: old writers
 * refuse its existence or cannot exclusively create a file at that location.
 * Legacy incomplete files still require inspection; no PID can be invented. */
export function acquireLocalDirectoryOwnership(resource: string) {
  const owner = `owner-${process.pid}-${randomBytes(16).toString('hex')}`;
  const lock = `${resource}.lock`, recovery = `${resource}.recovery`;
  const previousRecovery = present(recovery);
  if (previousRecovery && !previousRecovery.isDirectory()) throw new Error('Outbox lock recovery is active or was interrupted; inspect the recovery file before reopening');
  const releaseRecovery = directoryClaim(recovery, owner);
  try {
    const previous = present(lock);
    if (previous && !previous.isDirectory()) {
      const pid = readLegacyOwner(lock);
      if (!dead(pid)) throw new Error('Encrypted outbox is already open');
      unlinkSync(lock); // File-only removal cannot erase a newly published directory claim.
    }
    return directoryClaim(lock, owner);
  } finally { releaseRecovery(); }
}
