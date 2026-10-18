import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmbeddingEngine } from '@resonance/core';
import { searchCommand } from '../commands/search.js';
import { publishCommand } from '../commands/publish.js';

const mocks = vi.hoisted(() => ({ search: vi.fn(), submit: vi.fn(), disconnect: vi.fn(),
  insertItem: vi.fn(), insertPublication: vi.fn(), updateItemStatus: vi.fn(), close: vi.fn() }));
vi.mock('../relay-client.js', () => ({ createRelayClient: () => ({ searchV2: mocks.search,
  submitPublicationOperation: mocks.submit, disconnect: mocks.disconnect }) }));
vi.mock('../identity.js', () => ({ createIdentityManager: () => ({ exists: () => true,
  load: async () => ({ secretKey: new Uint8Array(64) }) }) }));
vi.mock('../config.js', () => ({ getDbPath: () => '/not-opened', deriveStoreKey: () => new Uint8Array(32) }));
vi.mock('../store.js', () => ({ openStoreAsync: async () => ({ insertItem: mocks.insertItem,
  insertPublication: mocks.insertPublication, updateItemStatus: mocks.updateItemStatus, close: mocks.close }) }));
const initialExitCode = process.exitCode;
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  vi.spyOn(EmbeddingEngine.prototype, 'embedForMatching').mockResolvedValue(new Float32Array(768));
  vi.spyOn(EmbeddingEngine.prototype, 'dispose').mockResolvedValue();
  mocks.search.mockResolvedValue({ results: [] }); mocks.submit.mockResolvedValue({ status: 'ok' });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = initialExitCode; });
const commands = [
  { name: 'search', run: (text: string) => searchCommand(text, {}) },
  { name: 'publish', run: (text: string) => publishCommand(text, { password: 'fixture-only' }) },
];

it.each(commands)('$name rejects oversized input before allocating a model', async ({ run }) => {
  await expect(run('x'.repeat(8193))).rejects.toThrow('8 KB');
  expect(EmbeddingEngine.prototype.initialize).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
});

it.each(commands)('$name releases native sessions when initialization or inference fails', async ({ run }) => {
  vi.mocked(EmbeddingEngine.prototype.initialize).mockRejectedValueOnce(new Error('initialization failed'));
  await expect(run('A valid description')).rejects.toThrow('initialization failed');
  expect(EmbeddingEngine.prototype.dispose).toHaveBeenCalledTimes(1);
  vi.mocked(EmbeddingEngine.prototype.embedForMatching).mockRejectedValueOnce(new Error('inference failed'));
  await expect(run('A valid description')).rejects.toThrow('inference failed');
  expect(EmbeddingEngine.prototype.dispose).toHaveBeenCalledTimes(2); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
});

it.each(commands)('$name releases the model before relay I/O and disconnects after failure', async ({ run, name }) => {
  (name === 'search' ? mocks.search : mocks.submit).mockImplementationOnce(async () => {
    expect(EmbeddingEngine.prototype.dispose).toHaveBeenCalledTimes(1); throw new Error('offline');
  });
  await run('A valid description'); expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  if (name === 'publish') { expect(mocks.insertPublication).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1); }
});
