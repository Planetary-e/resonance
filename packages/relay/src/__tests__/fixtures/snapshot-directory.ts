/** Test-only retained-tree comparison, including directory ownership markers. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export function snapshotDirectory(directory: string) {
  const entries: Array<{ path: string; kind: 'directory' } | { path: string; kind: 'file'; bytes: Buffer }> = [];
  function visit(relative: string) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) { entries.push({ path, kind: 'directory' }); visit(path); }
      else if (entry.isFile()) entries.push({ path, kind: 'file', bytes: readFileSync(join(directory, path)) });
      else throw new Error('Unexpected non-ordinary fixture entry');
    }
  }
  visit(''); return entries;
}
