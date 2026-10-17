/** Bounded metadata review of quiescent existing storage, never payload recovery.
 * Callers must exclude all cooperating writers throughout review/apply. Metadata
 * checks detect observed changes; they are not an atomic filesystem snapshot. */
import { lstatSync, opendirSync, realpathSync, type BigIntStats } from 'node:fs';
import { isAbsolute, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
export interface StorageAdoptionTarget { path: string; scope: 'file' | 'directory' }
export interface StorageAdoptionBounds { maximumEntries?: number; maximumDepth?: number; maximumMetadataBytes?: number; timeoutMs?: number }
export const STORAGE_ADOPTION_MAX_TARGETS = 256;
const contains = (parent: string, path: string) => { const suffix = relative(parent, path); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\')); };
const signature = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':');
export function inventoryStorageAdoption(input: readonly StorageAdoptionTarget[], excludedDirectory: string, options: StorageAdoptionBounds = {}) {
  const maximumEntries = options.maximumEntries ?? 100_000, maximumDepth = options.maximumDepth ?? 64;
  const maximumMetadataBytes = options.maximumMetadataBytes ?? 16 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000_000
    || !Number.isSafeInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > 64
    || !Number.isSafeInteger(maximumMetadataBytes) || maximumMetadataBytes < 1 || maximumMetadataBytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid existing-storage review bounds');
  if (!Array.isArray(input) || !input.length || input.length > STORAGE_ADOPTION_MAX_TARGETS) throw new Error('Select bounded existing storage targets');
  const start = performance.now();
  const check = () => { if (performance.now() - start > timeoutMs) throw new Error('Existing-storage review exceeded its deadline'); };
  const resolveTarget = (target: StorageAdoptionTarget) => {
    check();
    if (!target || typeof target.path !== 'string' || !isAbsolute(target.path) || target.path.length > 4096
      || /[\x00-\x1f\x7f]/.test(target.path) || !['file', 'directory'].includes(target.scope)) throw new Error('Invalid existing-storage target');
    const stat = lstatSync(target.path, { bigint: true });
    if (stat.isSymbolicLink() || (target.scope === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) {
      throw new Error('Existing storage requires ordinary unaliased targets');
    }
    const path = realpathSync(target.path);
    if (contains(excludedDirectory, path)) throw new Error('Authority metadata already has reserved control headroom');
    return { path, scope: target.scope };
  };
  try {
    const requested = input.map(target => {
      if (!target || typeof target !== 'object') throw new Error('Invalid existing-storage target');
      return { path: target.path, scope: target.scope };
    }), resolved = requested.map(resolveTarget);
    const unique = [...new Map(resolved.map(target => [target.path, target])).values()];
    const targets = unique.filter(target => !unique.some(other => other !== target && other.scope === 'directory' && contains(other.path, target.path)))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const metadata: Array<{ path: string; signature: string }> = [], hash = createHash('sha256');
    let entries = 0, files = 0, directories = 0, metadataBytes = 0, listingBytes = 0, logicalBytes = 0;
    const safeAdd = (a: number, b: number) => { const sum = a + b; if (!Number.isSafeInteger(sum) || sum < 0) throw new Error('Existing storage exceeds safe counters'); return sum; };
    const size = (value: bigint) => { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Existing storage exceeds safe counters'); return Number(value); };
    const boundedMetadata = () => { if (metadataBytes + listingBytes > maximumMetadataBytes) throw new Error('Existing-storage review exceeds metadata capacity'); };
    function walk(path: string, depth: number): number {
      check();
      // The already bounded authority is charged separately, even if a selected
      // parent directory contains it. Its mutable ledger must not adopt itself.
      if (path === excludedDirectory) return 0;
      if (++entries > maximumEntries || depth > maximumDepth) throw new Error('Existing-storage review exceeds entry or depth capacity');
      const before = lstatSync(path, { bigint: true });
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || (before.isFile() && before.nlink !== 1n)) {
        throw new Error('Existing-storage review refuses links and special files');
      }
      const record = { path, signature: signature(before) }, encoded = JSON.stringify(record);
      metadataBytes += Buffer.byteLength(encoded); boundedMetadata(); metadata.push(record); hash.update(encoded).update('\n');
      let bytes = 0;
      if (before.isFile()) { files++; bytes = size(before.size); logicalBytes = safeAdd(logicalBytes, bytes); }
      else {
        directories++; const directory = opendirSync(path), names: string[] = [];
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            check();
            if (join(path, entry.name) === excludedDirectory) continue;
            if (entries + names.length >= maximumEntries) throw new Error('Existing-storage review exceeds entry capacity');
            listingBytes += Buffer.byteLength(entry.name) + 1; boundedMetadata(); names.push(entry.name);
          }
        } finally { directory.closeSync(); }
        for (const name of names.sort()) bytes = safeAdd(bytes, walk(join(path, name), depth + 1));
      }
      check(); if (signature(lstatSync(path, { bigint: true })) !== record.signature) throw new Error('Existing storage changed during review; pause all writers');
      return bytes;
    }
    const observed = targets.map(target => ({ ...target, observedBytes: walk(target.path, 0) }));
    // Recheck all collected identities after the complete walk, not just after
    // each individual directory. No file payload is read or accepted as history.
    for (const record of metadata) {
      check(); if (signature(lstatSync(record.path, { bigint: true })) !== record.signature) throw new Error('Existing storage changed during review; pause all writers');
    }
    if (JSON.stringify(requested.map(resolveTarget)) !== JSON.stringify(resolved)) throw new Error('Existing-storage selection changed during review');
    check(); hash.update(JSON.stringify(observed));
    return { targets: observed, files, directories, logicalBytes, metadataDigest: hash.digest('hex'), atomicSnapshot: false as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw new Error('Existing storage is missing, unreadable or changed; preserve it for inspection');
    throw error;
  }
}
