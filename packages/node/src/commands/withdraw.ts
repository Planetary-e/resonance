/** Withdraw a protocol v2 publication with its publication-scoped key. */

import { createInterface } from 'node:readline';
import { createPublicationTombstone } from '@resonance/core';
import { deriveStoreKey, getDbPath } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { createRelayClient } from '../relay-client.js';
import { openStoreAsync } from '../store.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

export async function withdrawCommand(
  itemId: string,
  options: { password?: string; relay?: string },
): Promise<void> {
  const manager = createIdentityManager();
  if (!manager.exists()) {
    console.error('No identity found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = await manager.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
  try {
    const publication = store.getPublicationForItem(itemId);
    if (!publication) {
      console.error(`No protocol v2 publication found for item ${itemId}.`);
      process.exitCode = 1;
      return;
    }

    const tombstone = publication.tombstone ?? createPublicationTombstone(
      publication.record,
      'withdrawn',
      publication.keys.signingKeyPair,
      Date.now(),
    );
    if (!publication.tombstone) store.setPublicationTombstone(itemId, tombstone);
    store.updateItemStatus(itemId, 'withdrawn');

    const relayUrl = options.relay ?? 'ws://localhost:9090';
    const client = createRelayClient({ relayUrl, identity });
    const ack = await client.submitPublicationOperation(tombstone);
    if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected tombstone');
    console.log(`Publication withdrawn (relay: ${relayUrl}).`);
  } catch (error) {
    console.error(`Withdrawal stored locally; relay submission failed: ${String(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
