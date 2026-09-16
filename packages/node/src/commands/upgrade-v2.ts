/**
 * resonance upgrade-v2 — Back up local state and assign fresh scoped identities
 * to v0.1 items.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  deriveStoreKey,
  getDataDir,
  getDbPath,
  getIdentityPath,
} from '../config.js';
import { createIdentityManager } from '../identity.js';
import { createRelayClient } from '../relay-client.js';
import { openStoreAsync, type LocalStore } from '../store.js';
import { upgradeLegacyItemsToV2 } from '../upgrade-v2.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function backupLocalState(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(getDataDir(), 'backups', `pre-v2-${stamp}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  for (const source of [getIdentityPath(), getDbPath()]) {
    const destination = join(directory, basename(source));
    copyFileSync(source, destination);
    if (process.platform !== 'win32') chmodSync(destination, 0o600);
  }

  return directory;
}

export async function upgradeV2Command(options: {
  password?: string;
  relay?: string;
  group?: string;
  localOnly?: boolean;
}): Promise<void> {
  const manager = createIdentityManager();
  if (!manager.exists() || !existsSync(getDbPath())) {
    console.error('No complete local state found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = await manager.load(password);
  let store: LocalStore | null = null;

  try {
    // Copy both files before opening the database, because opening performs the
    // structural schema migration from v0.1 to the current schema.
    const backupDirectory = backupLocalState();
    store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

    const relayUrl = options.relay ?? 'ws://localhost:9090';
    const client = options.localOnly ? null : createRelayClient({ relayUrl });
    const report = await upgradeLegacyItemsToV2(store, {
      groupId: options.group ?? 'public',
      submit: client
        ? (record) => client.submitPublicationOperation(record)
        : undefined,
    });

    console.log('\nProtocol v2 local-data upgrade complete.');
    console.log(`  Backup:            ${backupDirectory}`);
    console.log(`  Legacy items:       ${report.discovered}`);
    console.log(`  Fresh identities:   ${report.created}`);
    console.log(`  Already v2:         ${report.alreadyV2}`);
    console.log(`  Published now:      ${report.published}`);
    console.log(`  Pending publication: ${report.pending}`);
    console.log(`  Withdrawn skipped:  ${report.withdrawnSkipped}`);

    if (report.errors.length > 0) {
      console.error('\nItems requiring retry:');
      for (const error of report.errors) {
        console.error(`  ${error.itemId}: ${error.message}`);
      }
      process.exitCode = 1;
    }
  } finally {
    store?.close();
    identity.secretKey.fill(0);
  }
}
