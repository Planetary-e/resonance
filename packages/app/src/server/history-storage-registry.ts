/** Durable desktop path retention. This does not reserve bytes or authorize history writes. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { canonicalHistorySetupPath, parseStorageDirectories, readOperatorJson, writeOperatorJsonNew } from '@resonance/relay';

export const RELAY_STORAGE_REGISTRY_DIRECTORY = 'relay-storage-locations';
const MANIFEST = 'locations.json', MAXIMUM_BYTES = 1024 * 1024;
const temporaryName = /^\.locations\.[a-f0-9]{16}\.tmp$/;
function present(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function flushDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function registryPath(runtimeDirectory: string) { return join(dirname(runtimeDirectory), RELAY_STORAGE_REGISTRY_DIRECTORY); }
function canonicalDirectories(input: readonly string[]) {
  return parseStorageDirectories(parseStorageDirectories(input).map(canonicalHistorySetupPath));
}
function read(directory: string): string[] {
  const stat = present(directory); if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Retained storage registry must be an ordinary directory');
  // The directory itself fences initialization. Losing its manifest cannot reset it.
  const manifest = join(directory, MANIFEST), file = present(manifest);
  if (!file?.isFile() || file.isSymbolicLink()) throw new Error('Retained storage registry is incomplete; preserve it for recovery');
  const names: string[] = [], entries = opendirSync(directory);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (names.length >= 129 || (entry.name !== MANIFEST && !temporaryName.test(entry.name))) {
        throw new Error('Retained storage registry has unexpected entries or exceeds its bound');
      }
      names.push(entry.name);
    }
  } finally { entries.closeSync(); }
  for (const name of names.filter(name => name !== MANIFEST)) {
    const entry = lstatSync(join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAXIMUM_BYTES) throw new Error('Retained storage registry has an invalid interrupted replacement');
  }
  const value = readOperatorJson(manifest, MAXIMUM_BYTES);
  if (!exactWitnessFields(value, ['version', 'kind', 'directories']) || value.version !== 1 || value.kind !== 'relay-storage-locations') {
    throw new Error('Retained storage registry is invalid; preserve it for recovery');
  }
  const directories = parseStorageDirectories(value.directories);
  if (JSON.stringify(value.directories) !== JSON.stringify(directories)
    || JSON.stringify(directories) !== JSON.stringify(canonicalDirectories(directories))) {
    throw new Error('Retained storage paths changed; preserve the original locations before continuing');
  }
  return directories;
}
export function readRelayStorageRegistry(runtimeDirectory: string): string[] {
  return read(registryPath(runtimeDirectory));
}
/** Called after approval but before creating output. Every earlier committed root
 * survives failed settings saves and later selections; no operation removes roots. */
export function retainRelayStorageRegistry(runtimeDirectory: string, input: readonly string[]): string[] {
  const directory = registryPath(runtimeDirectory), selected = canonicalDirectories(input);
  const release = acquireLocalStateLock(directory);
  try {
    const existed = !!present(directory), previous = read(directory);
    const directories = parseStorageDirectories([...new Set([...previous, ...selected])]);
    if (existed && JSON.stringify(previous) === JSON.stringify(directories)) return directories;
    const value = { version: 1, kind: 'relay-storage-locations', directories };
    if (!existed) {
      // Exclusive creation + parent flush makes an interrupted first initialization
      // distinguishable from a never-used registry. It must not silently restart.
      mkdirSync(directory, { mode: 0o700 }); flushDirectory(dirname(directory));
      writeOperatorJsonNew(join(directory, MANIFEST), value, MAXIMUM_BYTES);
    } else {
      const temporary = join(directory, `.locations.${randomBytes(8).toString('hex')}.tmp`);
      try {
        writeOperatorJsonNew(temporary, value, MAXIMUM_BYTES);
        renameSync(temporary, join(directory, MANIFEST)); flushDirectory(directory);
      } finally { rmSync(temporary, { force: true }); }
    }
    return directories;
  } finally { release(); }
}
