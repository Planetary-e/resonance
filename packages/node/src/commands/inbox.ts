/** Fetch, persist, and acknowledge encrypted protocol v2 match notices. */

import { createInterface } from 'node:readline';
import { deriveStoreKey, getDbPath } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { createRelayClient } from '../relay-client.js';
import { openStoreAsync } from '../store.js';
import { createPairwiseChannelManagerV2 } from '../pairwise-channel-v2.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

export async function inboxCommand(options: { password?: string; relay?: string }): Promise<void> {
  const manager = createIdentityManager();
  if (!manager.exists()) {
    console.error('No identity found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = await manager.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
  const client = createRelayClient({
    relayUrl: options.relay ?? 'ws://localhost:9090',
    identity,
  });

  try {
    const pairwise = createPairwiseChannelManagerV2(store, client);
    const result = await pairwise.syncMailboxes();

    const matches = store.listMailboxMatches();
    console.log(`Mailbox sync complete: ${result.matchesAdded} new match${result.matchesAdded === 1 ? '' : 'es'}, ${result.messagesProcessed} consent message${result.messagesProcessed === 1 ? '' : 's'} and ${result.channelOperationsProcessed} channel operation${result.channelOperationsProcessed === 1 ? '' : 's'} processed.`);
    for (const match of matches) {
      console.log(`  ${match.matchId}  ${(match.similarity * 100).toFixed(1)}%  partner ${match.partnerPublicationId}`);
    }
    for (const channel of pairwise.list()) {
      console.log(`  channel ${channel.channelId ?? channel.localKeys.relationshipId}  ${channel.status}`);
    }
  } catch (error) {
    console.error(`Mailbox sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
