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

it('reads an explicitly supported legacy format without rewriting, then encrypts at the same path on mutation', () => {
  fs.writeFileSync(options.path, 'legacy:first');
  const decodeLegacy = (bytes: Buffer) => bytes.toString() === 'legacy:first' ? { secret: 'first' } : undefined;
  const state = openEncryptedLocalState({ ...options, mode: 'open-existing', decodeLegacy });
  expect(state.read()).toEqual({ secret: 'first' }); expect(fs.readFileSync(options.path, 'utf8')).toBe('legacy:first');
  state.write({ secret: 'second' }); state.close();
  expect(fs.readFileSync(options.path, 'utf8')).not.toContain('second');
  const reopened = openEncryptedLocalState({ ...options, decodeLegacy }); expect(reopened.read()).toEqual({ secret: 'second' }); reopened.close();
});

it('validates decoded legacy data and never uses its initial value as recovery for an unrecognized file', () => {
  fs.writeFileSync(options.path, 'damaged');
  expect(() => openEncryptedLocalState({ ...options, decodeLegacy: () => undefined })).toThrow('Encrypted outbox file is invalid');
  expect(() => openEncryptedLocalState({ ...options, decodeLegacy: () => ({ secret: 42 } as unknown as { secret: string }) })).toThrow('legacy state is invalid');
  expect(fs.readFileSync(options.path, 'utf8')).toBe('damaged');
  fs.writeFileSync(options.path, 'x'.repeat(options.maxBytes + 1));
  const decodeLegacy = vi.fn(() => ({ secret: 'first' }));
  expect(() => openEncryptedLocalState({ ...options, decodeLegacy })).toThrow('capacity');
  expect(decodeLegacy).not.toHaveBeenCalled();
});
