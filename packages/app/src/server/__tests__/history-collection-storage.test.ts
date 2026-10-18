import { afterEach, expect, it } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { relayStorageDirectories, retainRelayStorageDirectories } from '../history-storage.js';
import type { RelayConfig } from '../session.js';
import { historyVolunteerCollectionFixture } from '../../../../relay/src/__tests__/fixtures/history-volunteer-collection-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('keeps every enrolled collection directory in storage inventory after the role is disabled', async () => {
  const n = await historyVolunteerCollectionFixture(close => cleanup.push(close));
  const runtimeDirectory = join(n.directory, 'relay-data'); mkdirSync(runtimeDirectory);
  const configured: RelayConfig = { enabled: false, port: 9091, runtime: { nodePath: process.execPath, entryPath: '/test/main.js', workingDirectory: n.directory,
    historyVolunteerCollectionFile: n.paths[0] } };
  const directories = relayStorageDirectories(configured, runtimeDirectory);
  for (const history of n.configs[0].histories) expect(directories).toContain(realpathSync(join(n.directory, history.directory)));
  expect(directories).toHaveLength(6);
  const disabled = retainRelayStorageDirectories({ enabled: false, port: 9091 }, configured, runtimeDirectory);
  expect(relayStorageDirectories(disabled, runtimeDirectory).sort()).toEqual(directories.sort());
});
