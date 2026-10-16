/** Bounded local operator inputs; secret parse errors never echo file contents. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
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
  try { return JSON.parse(bytes.toString('utf8')); }
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
export function writeOperatorJsonNew(path: string, value: unknown, maximum: number): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > maximum) throw new Error('Operator output exceeds its size limit');
  const fd = openSync(path, 'wx', 0o600);
  try {
    for (let at = 0; at < bytes.length;) { const count = writeSync(fd, bytes, at); if (!count) throw new Error('Operator output write stopped'); at += count; }
    fsyncSync(fd);
  } finally { bytes.fill(0); closeSync(fd); }
  if (process.platform !== 'win32') { const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } }
}
