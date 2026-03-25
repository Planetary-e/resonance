/**
 * resonance serve — Long-running listener for match notifications.
 * Stays connected to the relay, stores matches, handles consent handshakes.
 */

import { createInterface } from 'node:readline';
import { getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStore } from '../store.js';
import { createRelayClient } from '../relay-client.js';
import { createChannelManager } from '../channel.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

export async function serveCommand(options: { password?: string; relay?: string }): Promise<void> {
  const mgr = createIdentityManager();
  if (!mgr.exists()) {
    console.error('No identity found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = mgr.load(password);
  const store = openStore(getDbPath(), deriveStoreKey(identity));
  const relayUrl = options.relay ?? 'ws://localhost:9090';

  const client = createRelayClient({ relayUrl, identity });
  const channelMgr = createChannelManager({ identity, store, relayClient: client });

  // Wire relay events
  client.on({
    onMatch(payload) {
      // Store match in local DB
      store.insertMatch({
        id: payload.matchId,
        itemId: payload.yourItemId,
        partnerDID: payload.partnerDID,
        similarity: payload.similarity,
      });
      console.log(`[match] ${payload.matchId} — partner: ${payload.partnerDID.slice(0, 30)}... sim: ${payload.similarity.toFixed(3)}`);
    },
    onConsentForward(payload) {
      console.log(`[consent] from ${payload.fromDID.slice(0, 30)}... match: ${payload.matchId}`);
      channelMgr.handleConsentForward(payload);
    },
    onChannelForward(payload) {
      channelMgr.handleChannelForward(payload);
    },
    onDisconnect(reason) {
      console.log(`[disconnected] ${reason}`);
    },
  });

  channelMgr.on({
    onChannelReady(channelId, matchId) {
      console.log(`[channel] ready: ${channelId} (match: ${matchId})`);
    },
    onConfirmResult(channelId, similarity, confirmed) {
      console.log(`[confirm] channel ${channelId}: sim=${similarity.toFixed(3)} confirmed=${confirmed}`);
    },
    onDisclosure(channelId, text, level) {
      console.log(`[disclosure] channel ${channelId} [${level}]: ${text}`);
    },
    onAccept(channelId, message) {
      console.log(`[accept] channel ${channelId}${message ? ': ' + message : ''}`);
    },
    onReject(channelId, reason) {
      console.log(`[reject] channel ${channelId}${reason ? ': ' + reason : ''}`);
    },
    onClose(channelId) {
      console.log(`[close] channel ${channelId}`);
    },
  });

  try {
    await client.connect();
    console.log(`Resonance node listening on ${relayUrl}`);
    console.log(`DID: ${identity.did}`);
    console.log(`Press Ctrl+C to stop.\n`);
  } catch (err) {
    console.error(`Failed to connect to relay: ${err}`);
    store.close();
    process.exitCode = 1;
    return;
  }

  // Keep running until SIGTERM/SIGINT
  const shutdown = () => {
    console.log('\nShutting down...');
    client.disconnect();
    store.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
