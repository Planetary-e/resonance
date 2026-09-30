import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openEncryptedLocalState } from '../encrypted-local-state.js';
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), fsyncSync: vi.fn(fs.fsyncSync) };
});
let directory: string;
let options: Parameters<typeof openEncryptedLocalState<{ secret: string }>>[0];
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'encrypted-state-'));
  options = { path: join(directory, 'state'), key: randomBytes(32), domain: 'test', maxBytes: 4096,
    initial: { secret: 'first' }, validate: (value: unknown): value is { secret: string } => !!value && typeof (value as { secret: string }).secret === 'string' };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
it('fails closed after an interrupted replacement; reopening preserves the previous flushed state', () => {
  const state = openEncryptedLocalState(options);
  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => state.write({ secret: 'second' })).toThrow('disk unavailable');
  expect(() => state.read()).toThrow('close and reopen'); state.close();
  const reopened = openEncryptedLocalState(options); expect(reopened.read().secret).toBe('first'); reopened.close();
  expect(fs.readdirSync(directory)).toEqual(['state']);
});
it('does not assume a replacement was lost if flushing its directory failed', () => {
  if (process.platform === 'win32') return;
  const state = openEncryptedLocalState(options);
  vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('directory flush failed'); });
  expect(() => state.write({ secret: 'second' })).toThrow('directory flush failed');
  expect(() => state.read()).toThrow('close and reopen'); state.close();
  const reopened = openEncryptedLocalState(options); expect(reopened.read().secret).toBe('second'); reopened.close();
});
