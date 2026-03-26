/**
 * resonance connect <matchId> — Open a direct channel for a match.
 * Performs consent handshake, key exchange, and embedding confirmation.
 */

import { createInterface } from 'node:readline';
import { getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStoreAsync } from '../store.js';
import { createRelayClient } from '../relay-client.js';
import { createChannelManager } from '../channel.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

export async function connectCommand(
  matchId: string,
  options: { password?: string; relay?: string },
): Promise<void> {
  const mgr = createIdentityManager();
  if (!mgr.exists()) {
    console.error('No identity found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = mgr.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

  const match = store.getMatch(matchId);
  if (!match) {
    console.error(`Match "${matchId}" not found.`);
    store.close();
    process.exitCode = 1;
    return;
  }

  const relayUrl = options.relay ?? 'ws://localhost:9090';
  const client = createRelayClient({ relayUrl, identity });
  const channelMgr = createChannelManager({ identity, store, relayClient: client });

  // Set up channel event handlers
  let channelId: string | null = null;
  const done = new Promise<void>((resolve) => {
    channelMgr.on({
      onChannelReady(id, mId) {
        channelId = id;
        console.log(`Channel ready: ${id}`);

        // Auto-send confirm embedding
        const item = store.getItem(match.itemId);
        if (item) {
          console.log('Sending true embedding for confirmation...');
          channelMgr.sendConfirmEmbedding(id, item.embedding);
        }
      },
      onConfirmResult(id, similarity, confirmed) {
        if (confirmed) {
          console.log(`\nMatch confirmed! True similarity: ${similarity.toFixed(3)}`);
          console.log(`\nChannel active. Run: resonance channel ${id}`);
        } else {
          console.log(`\nMatch rejected. True similarity: ${similarity.toFixed(3)} (below ${0.55} threshold)`);
        }
        resolve();
      },
    });
  });

  // Wire relay events to channel manager
  client.on({
    onConsentForward: (payload) => channelMgr.handleConsentForward(payload),
    onChannelForward: (payload) => channelMgr.handleChannelForward(payload),
  });

  try {
    await client.connect();
    console.log(`Connected to relay: ${relayUrl}`);
    console.log(`Initiating channel for match ${matchId}...`);

    await channelMgr.initiateChannel(matchId, match.partnerDID);
    console.log('Consent sent. Waiting for partner...');

    // Wait for confirmation (with timeout)
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout waiting for partner')), 60_000),
    );

    await Promise.race([done, timeout]);
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exitCode = 1;
  } finally {
    client.disconnect();
    store.close();
  }
}
