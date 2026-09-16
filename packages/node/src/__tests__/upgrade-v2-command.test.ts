import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upgradeV2Command } from '../commands/upgrade-v2.js';
import { deriveStoreKey, getDbPath } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStoreAsync } from '../store.js';

const temporaryDirectories: string[] = [];
const originalDataDirectory = process.env.RESONANCE_DATA_DIR;

afterEach(() => {
  if (originalDataDirectory === undefined) delete process.env.RESONANCE_DATA_DIR;
  else process.env.RESONANCE_DATA_DIR = originalDataDirectory;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('upgrade-v2 command', () => {
  it('backs up the exact pre-upgrade file pair before creating local v2 records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-v2-upgrade-'));
    temporaryDirectories.push(directory);
    process.env.RESONANCE_DATA_DIR = directory;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const manager = createIdentityManager();
    const identity = await manager.create('test-password');
    const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
    store.insertItem({
      id: 'legacy-item',
      type: 'offer',
      rawText: 'private legacy offer',
      embedding: new Float32Array(768).fill(0.25),
      privacyLevel: 'medium',
    });
    store.updateItemStatus('legacy-item', 'published');
    store.close();
    identity.secretKey.fill(0);

    const identityBefore = readFileSync(join(directory, 'identity.json'));
    const databaseBefore = readFileSync(join(directory, 'resonance.db'));

    await upgradeV2Command({ password: 'test-password', localOnly: true });

    const backups = readdirSync(join(directory, 'backups'));
    expect(backups).toHaveLength(1);
    const backupDirectory = join(directory, 'backups', backups[0]);
    expect(readFileSync(join(backupDirectory, 'identity.json'))).toEqual(identityBefore);
    expect(readFileSync(join(backupDirectory, 'resonance.db'))).toEqual(databaseBefore);

    const reopenedIdentity = await manager.load('test-password');
    const reopenedStore = await openStoreAsync(getDbPath(), deriveStoreKey(reopenedIdentity));
    expect(reopenedStore.getItem('legacy-item')?.rawText).toBe('private legacy offer');
    expect(reopenedStore.getItem('legacy-item')?.status).toBe('local');
    expect(reopenedStore.getPublicationForItem('legacy-item')).not.toBeNull();
    reopenedStore.close();
    reopenedIdentity.secretKey.fill(0);
  });
});
