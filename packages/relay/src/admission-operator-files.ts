/** Bounded local operator inputs; secret parse errors never echo file contents. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { reserveManagedStorage, type StorageReservationLease } from '@resonance/core/storage-reservations';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from '@resonance/core/admission-witness';

export function readOperatorFile(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK), bytes = Buffer.alloc(maximum + 1);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Admission history input must be a bounded regular file');
    let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    if (used > maximum) throw new Error('Admission history input exceeds its size limit');
    return bytes.subarray(0, used);
  } catch (error) { bytes.fill(0); throw error; }
  finally { closeSync(fd); }
}
export function readOperatorJson(path: string, maximum: number): unknown {
  const bytes = readOperatorFile(path, maximum);
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw new Error('Admission history input is not valid JSON'); }
  finally { bytes.fill(0); }
}
export function readOperatorSigningKey(path: string) {
  const value = readOperatorJson(path, 4096);
  if (!exactWitnessFields(value, ['publicKey', 'secretKey']) || !witnessBytes(value.publicKey, 32)
    || !witnessBytes(value.secretKey, 64)) throw new Error('Invalid admission history signing key');
  const secretKey = Buffer.from(value.secretKey, 'base64url');
  try { return copyAdmissionSigningKey({ publicKey: Buffer.from(value.publicKey, 'base64url'), secretKey }); }
  finally { secretKey.fill(0); value.secretKey = ''; }
}
export function readOperatorStorageKey(path: string) {
  const bytes = readOperatorFile(path, 128);
  try {
    const hex = bytes.toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Storage key must be 32 bytes in lowercase hex');
    return Buffer.from(hex, 'hex');
  } finally { bytes.fill(0); }
}
/** Exclusive output: a partial file after interruption is refused, never overwritten. Re-export to a new path. */
export function writeOperatorJsonNew(path: string, value: unknown, maximum: number,
  included?: { reservation: StorageReservationLease; replacement?: boolean }): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid operator output byte limit');
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Operator output must encode a JSON value');
  writeEncodedNew(path, Buffer.from(`${encoded}\n`), maximum, included);
}
function writeEncodedNew(path: string, bytes: Buffer, maximum: number,
  included?: { reservation: StorageReservationLease; replacement?: boolean }): void {
  if (bytes.length > maximum) { bytes.fill(0); throw new Error('Operator output exceeds its size limit'); }
  let fd: number | undefined;
  try {
    const reservation = included?.reservation ?? reserveManagedStorage({ path, component: 'operator-output', scope: 'file', maximumBytes: maximum });
    reservation?.assertWritable({ path, maximumBytes: maximum, replacement: included?.replacement });
    fd = openSync(path, 'wx', 0o600);
    for (let at = 0; at < bytes.length;) { const count = writeSync(fd, bytes, at); if (count <= 0) throw new Error('Operator output write stopped'); at += count; }
    fsyncSync(fd);
  } finally { bytes.fill(0); if (fd !== undefined) closeSync(fd); }
  if (process.platform !== 'win32') { const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } }
}

/** Atomic settings replacement with bounded retained interrupted outputs.
 * Eight temporary slots include the currently written replacement. No abandoned
 * output is deleted just because its name matches; a full set needs inspection.
 */
export const OPERATOR_REPLACEMENT_SLOTS = 8;
/** Preflight an entire set of outputs before stopping or replacing a service. */
export function reserveOperatorAtomicOutput(path: string, maximum: number): StorageReservationLease | undefined {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger((OPERATOR_REPLACEMENT_SLOTS + 1) * maximum + 8192)) throw new Error('Invalid operator output byte limit');
  return reserveManagedStorage({ path, component: 'operator-atomic-output', scope: 'file', maximumBytes: (OPERATOR_REPLACEMENT_SLOTS + 1) * maximum + 8192 });
}
export function writeOperatorJsonAtomic(path: string, value: unknown, maximum: number): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Operator output must encode a JSON value');
  writeOperatorTextAtomic(path, encoded + '\n', maximum);
}
/** Bounded UTF-8 configuration output, including XML, service units and launch scripts. */
export function writeOperatorTextAtomic(path: string, text: string, maximum: number, included?: StorageReservationLease): void {
  const bytes = Buffer.from(text, 'utf8');
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger((OPERATOR_REPLACEMENT_SLOTS + 1) * maximum + 8192)) throw new Error('Invalid operator output byte limit');
    if (bytes.length > maximum) throw new Error('Operator output exceeds its size limit');
    const reservation = included ?? reserveOperatorAtomicOutput(path, maximum);
    reservation?.assertWritable({ path, maximumBytes: (OPERATOR_REPLACEMENT_SLOTS + 1) * maximum + 8192 });
    replaceEncoded(path, bytes, maximum, reservation);
  } finally { bytes.fill(0); }
}
function replaceEncoded(path: string, bytes: Buffer, maximum: number, reservation?: StorageReservationLease): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLocalStateLock(path, reservation);
  try {
    const current = (() => { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } })();
    if (current && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size > maximum)) throw new Error('Atomic operator output must be a bounded ordinary file');
    const entries = opendirSync(directory), prefix = basename(path); let seen = 0, temporaries = 0;
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++seen > 4096) throw new Error('Operator output directory inspection exceeded its bound');
        // Include the older desktop naming convention when adopting an interrupted save.
        const suffix = entry.name.startsWith(`.${prefix}.`) ? entry.name.slice(prefix.length + 2)
          : entry.name.startsWith(`${prefix}.`) ? entry.name.slice(prefix.length + 1) : null;
        if (suffix === null || !/^[a-f0-9]{16}\.tmp$/.test(suffix)) continue;
        const stat = lstatSync(join(directory, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Interrupted operator output needs inspection');
        if (++temporaries >= OPERATOR_REPLACEMENT_SLOTS) throw new Error('Interrupted operator output slots are full; retain them for inspection');
      }
    } finally { entries.closeSync(); }
    const temporary = join(directory, `.${prefix}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      writeEncodedNew(temporary, bytes, maximum, reservation ? { reservation, replacement: true } : undefined);
      reservation?.assertWritable(); renameSync(temporary, path);
      if (process.platform !== 'win32') { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    } finally { rmSync(temporary, { force: true }); }
  } finally { release(); }
}
