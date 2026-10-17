/** Enumerate application-owned roots and exact outputs before stopped adoption.
 * This is a selection, not a byte inventory or approval. Missing retained history
 * is an error; only named future outputs can be proposed as explicitly new. */
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { StorageAdoptionTarget } from '@resonance/core/storage-reservations';
import { relayStorageDirectories, relayStorageOutputFiles } from './history-storage.js';
import { relayStorageRegistryPath } from './history-storage-registry.js';
import { relayServiceOutputPaths } from './relay-supervisor.js';
import { DESKTOP_STORAGE_AUTHORITY_DIRECTORY, DESKTOP_STORAGE_BOOTSTRAP_DIRECTORY } from './relay-storage-bootstrap.js';
import type { RelayConfig } from './session.js';
export const DESKTOP_STORAGE_SELECTION_FILENAME = 'relay-storage-selection.json';
const contains = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\')); };
function present(path: string) { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }

export function collectDesktopRelayStorageScopes(config: RelayConfig, dataDirectory: string,
  options: { platform?: NodeJS.Platform; userDirectory?: string } = {}) {
  const directory = realpathSync(dataDirectory), runtime = join(directory, 'relay-data'), authority = join(directory, DESKTOP_STORAGE_AUTHORITY_DIRECTORY);
  const existing = new Map<string, StorageAdoptionTarget>(), absent = new Map<string, StorageAdoptionTarget>();
  let inspected = 0;
  const checkCount = () => { if (existing.size + absent.size > 256) throw new Error('Desktop storage selection exceeds its target bound'); };
  function retain(path: string, scope: 'file' | 'directory', required = true) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid desktop storage location');
    const stat = present(path);
    if (!stat) {
      if (required) throw new Error('A retained desktop storage location is missing; restore or review its recovery before adoption');
      propose(path, scope); return;
    }
    if (stat.isSymbolicLink() || (scope === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error('Desktop storage locations must be ordinary unaliased files or directories');
    const selected = realpathSync(path);
    if (contains(authority, selected)) throw new Error('Storage authority metadata already has separate control accounting');
    const previous = existing.get(selected);
    if (previous && previous.scope !== scope) throw new Error('Conflicting desktop storage scopes');
    existing.set(selected, { path: selected, scope }); checkCount();
  }
  function propose(path: string, scope: 'file' | 'directory') {
    // A native service parent may not exist yet. Select only the highest absent
    // directory below an existing ordinary parent, never that parent's contents.
    let target = resolve(path), parent = dirname(target), depth = 0;
    while (!present(parent)) {
      if (++depth > 64 || dirname(parent) === parent) throw new Error('New desktop output has no bounded existing parent');
      target = parent; parent = dirname(parent); scope = 'directory';
    }
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('New desktop output needs an ordinary existing parent');
    target = join(realpathSync(parent), basename(target));
    if (contains(authority, target)) throw new Error('New desktop output overlaps authority metadata');
    const previous = absent.get(target);
    if (previous && previous.scope !== scope) throw new Error('Conflicting new desktop storage scopes');
    absent.set(target, { path: target, scope }); checkCount();
  }
  function family(path: string, required: boolean) {
    retain(path, 'file', required);
    const parent = dirname(path); if (!present(parent)) return;
    const name = basename(path), entries = opendirSync(parent);
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++inspected > 16384) throw new Error('Desktop output-family inspection exceeded its bound');
        // Retain every namespaced sidecar, including unrecognized/interrupted
        // candidates. Their contents are never interpreted as recovered state.
        if (!entry.name.startsWith(`${name}.`) && !entry.name.startsWith(`.${name}.`)) continue;
        const file = join(parent, entry.name), stat = lstatSync(file);
        retain(file, stat.isDirectory() ? 'directory' : 'file');
      }
    } finally { entries.closeSync(); }
  }
  for (const path of relayStorageDirectories(config, runtime)) {
    if (contains(path, directory)) throw new Error('Retained relay history must not contain desktop account data; select separate history directories');
    retain(path, 'directory');
  }
  for (const path of relayStorageOutputFiles(config, runtime)) family(path, true);
  retain(join(directory, DESKTOP_STORAGE_BOOTSTRAP_DIRECTORY), 'directory');
  retain(relayStorageRegistryPath(runtime), 'directory', false);
  // Registry ownership sits beside its directory, so it needs an exact scope too.
  family(`${relayStorageRegistryPath(runtime)}.lock`, false);
  const registryRecovery = `${relayStorageRegistryPath(runtime)}.recovery`;
  if (present(registryRecovery)) retain(registryRecovery, 'file');
  family(join(directory, 'relay-config.json'), true);
  family(join(directory, 'relay-desktop-control.lock'), true);
  const controlRecovery = join(directory, 'relay-desktop-control.recovery');
  if (present(controlRecovery)) retain(controlRecovery, 'file');
  const legacyLog = join(directory, 'relay-service.log');
  if (present(legacyLog)) family(legacyLog, true);
  for (const path of relayServiceOutputPaths(directory, options.platform ?? process.platform, options.userDirectory ?? homedir())) family(path, false);
  family(join(directory, DESKTOP_STORAGE_SELECTION_FILENAME), false);
  function minimal(values: Map<string, StorageAdoptionTarget>, covering: StorageAdoptionTarget[] = []) {
    const all = [...values.values()];
    return all.filter(target => ![...all, ...covering].some(other => other !== target && other.scope === 'directory' && contains(other.path, target.path)))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  const retained = minimal(existing), future = minimal(absent, retained);
  if (future.some(target => retained.some(entry => contains(target.path, entry.path)))) throw new Error('New desktop scopes overlap retained files; preserve existing selections');
  return { existing: retained, new: future, authorityDirectory: authority,
    selectionFile: join(directory, DESKTOP_STORAGE_SELECTION_FILENAME), includesFileContents: false as const, activationReady: false as const };
}
