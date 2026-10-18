import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOperatorJson } from '../admission-operator-files.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
it('refuses malformed UTF-8 before it can become a different configuration path and preserves its input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-json-')); directories.push(directory); const path = join(directory, 'input');
  const bytes = Buffer.concat([Buffer.from('{"directory":"private-'), Buffer.from([0xff]), Buffer.from('"}')]); writeFileSync(path, bytes);
  let message = ''; try { readOperatorJson(path, 4096); } catch (error) { message = String(error); }
  expect(message).toContain('not valid JSON'); expect(message).not.toContain('private-'); expect(readFileSync(path)).toEqual(bytes);
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])); expect(() => readOperatorJson(path, 4096)).toThrow('not valid JSON');
  writeFileSync(path, JSON.stringify({ directory: 'Español 🌍 \uFFFD' })); expect(readOperatorJson(path, 4096)).toEqual({ directory: 'Español 🌍 \uFFFD' });
});
