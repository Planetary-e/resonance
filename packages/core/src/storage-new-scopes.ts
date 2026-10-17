/** Explicit absence review for new output scopes. Never reinterpret a missing
 * existing selection as empty storage. Callers still exclude cooperating writers. */
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { STORAGE_ADOPTION_MAX_TARGETS, type StorageAdoptionTarget } from './storage-adoption-inventory.js';
const contains = (parent: string, path: string) => { const suffix = relative(parent, path); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\')); };
const signature = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String).join(':');
export function reviewAbsentStorageScopes(input: readonly StorageAdoptionTarget[], excludedDirectory: string) {
  if (!Array.isArray(input) || !input.length || input.length > STORAGE_ADOPTION_MAX_TARGETS) throw new Error('Select bounded new storage scopes');
  const started = performance.now();
  const check = () => { if (performance.now() - started > 30000) throw new Error('New storage scope review exceeded its deadline'); };
  function absent(path: string) {
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('A new storage scope must not already exist; review its existing files instead');
  }
  function inspect(target: StorageAdoptionTarget) {
    check();
    if (!target || typeof target.path !== 'string' || !isAbsolute(target.path) || target.path.length > 4096
      || /[\x00-\x1f\x7f]/.test(target.path) || !['file', 'directory'].includes(target.scope)) throw new Error('Invalid new storage scope');
    const supplied = resolve(target.path), parent = dirname(supplied), before = lstatSync(parent, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('A new storage scope needs an ordinary existing parent');
    const resolvedParent = realpathSync(parent), path = join(resolvedParent, basename(supplied));
    if (contains(excludedDirectory, path)) throw new Error('Authority metadata already has reserved control headroom');
    absent(supplied); absent(path);
    if (signature(lstatSync(parent, { bigint: true })) !== signature(before) || realpathSync(parent) !== resolvedParent) throw new Error('New storage parent changed during review');
    return { path, scope: target.scope, parent: resolvedParent, parentSignature: signature(before) };
  }
  try {
    const requested = input.map(target => ({ path: target?.path, scope: target?.scope })), observed = requested.map(inspect);
    const selected = new Map<string, StorageAdoptionTarget>();
    for (const target of observed) {
      const previous = selected.get(target.path);
      if (previous && previous.scope !== target.scope) throw new Error('New storage scope has conflicting target types');
      selected.set(target.path, { path: target.path, scope: target.scope });
    }
    const targets = [...selected.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (targets.some(target => targets.some(other => other !== target && other.scope === 'directory' && contains(other.path, target.path)))) {
      throw new Error('Select distinct new storage scopes with existing parents');
    }
    if (JSON.stringify(requested.map(inspect)) !== JSON.stringify(observed)) throw new Error('New storage selection changed during review');
    check();
    return { targets, metadataDigest: createHash('sha256').update(JSON.stringify(observed)).digest('hex'), atomicSnapshot: false as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw new Error('New storage parent or selection is unavailable or changed; preserve existing files');
    throw error;
  }
}
