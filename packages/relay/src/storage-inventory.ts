/** Read-only, bounded metadata inventory. This is not a reservation or disk quota. */
import { lstat, opendir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface StorageInventory {
  kind: 'storage-inventory'; selectedDirectories: number; scannedRoots: number; directories: number; files: number;
  logicalBytes: number; allocatedBytes: number | null; startedAt: number; completedAt: number;
  atomicSnapshot: false; enforcesQuota: false;
}
export const STORAGE_INVENTORY_MAX_ROOTS = 128;
export function parseStorageDirectories(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > STORAGE_INVENTORY_MAX_ROOTS
    || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error('Select between one and 128 absolute storage directories');
  }
  return [...new Set((value as string[]).map(path => resolve(path)))].sort();
}
const contains = (parent: string, child: string) => {
  const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'));
};
const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;
const signature = (stat: BigIntStats) => `${identity(stat)}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}:${stat.blocks}`;

export async function measureStorageDirectories(input: readonly string[], options: {
  signal?: AbortSignal; maximumEntries?: number; maximumDepth?: number; timeoutMs?: number;
} = {}): Promise<StorageInventory> {
  const selected = parseStorageDirectories(input), maximumEntries = options.maximumEntries ?? 1000000;
  const maximumDepth = options.maximumDepth ?? 64, timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1000000
    || !Number.isSafeInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > 64
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid storage inventory bounds');
  const startedAt = Date.now(), start = performance.now();
  const check = () => { options.signal?.throwIfAborted(); if (performance.now() - start > timeoutMs) throw new Error('Storage inventory exceeded its scan deadline'); };
  const safeNumber = (value: bigint) => { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Storage inventory exceeds safe counters'); return Number(value); };
  const canonical = async () => {
    const roots: string[] = [];
    for (const path of selected) { check(); const root = await realpath(path), stat = await lstat(root, { bigint: true });
      if (!stat.isDirectory()) throw new Error('Storage selection must contain existing directories'); roots.push(root); }
    return roots;
  };
  try {
    check(); const selectedRoots = await canonical(), unique = [...new Set(selectedRoots)];
    const roots = unique.filter(path => !unique.some(other => path !== other && contains(other, path)));
    let entries = 0, directories = 0, files = 0, logical = 0n, allocated = 0n, allocationKnown = true;
    const seenFiles = new Set<string>();
    const countAllocation = (stat: BigIntStats) => {
      if (typeof stat.blocks !== 'bigint' || stat.blocks < 0n) allocationKnown = false;
      else { allocated += stat.blocks * 512n; safeNumber(allocated); }
    };
    // Incremental traversal avoids loading an entire directory listing or any payload.
    async function walk(path: string, depth: number): Promise<void> {
      check(); if (++entries > maximumEntries || depth > maximumDepth) throw new Error('Storage inventory exceeds entry or depth bounds');
      const before = await lstat(path, { bigint: true }); check();
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw new Error('Storage inventory refuses links and special files inside selected directories');
      if (before.isDirectory()) {
        directories++; countAllocation(before); const directory = await opendir(path);
        for await (const entry of directory) await walk(join(path, entry.name), depth + 1);
      } else {
        // Count a hard-linked file once when the filesystem supplies a stable inode.
        const key = before.ino > 0n ? identity(before) : path;
        if (!seenFiles.has(key)) {
          seenFiles.add(key); files++; logical += before.size; safeNumber(logical);
          countAllocation(before);
        }
      }
      const after = await lstat(path, { bigint: true }); check();
      if (signature(before) !== signature(after)) throw new Error('Storage changed during inventory; retry while all writers are paused');
    }
    for (const root of roots) await walk(root, 0);
    if (JSON.stringify(selectedRoots) !== JSON.stringify(await canonical())) throw new Error('Storage selection changed during inventory');
    check(); return { kind: 'storage-inventory', selectedDirectories: selected.length, scannedRoots: roots.length, directories, files,
      logicalBytes: safeNumber(logical), allocatedBytes: allocationKnown ? safeNumber(allocated) : null,
      startedAt, completedAt: Date.now(), atomicSnapshot: false, enforcesQuota: false };
  } catch (error) {
    options.signal?.throwIfAborted();
    // Paths and filenames are deliberately excluded from aggregate API errors.
    if ((error as NodeJS.ErrnoException).code) throw new Error('Storage inventory unavailable: a selected directory or entry is missing, unreadable or changed');
    throw error;
  }
}
