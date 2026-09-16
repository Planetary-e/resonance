/**
 * resonance connect <matchId> — Open a direct channel for a match.
 * Performs the protocol v2 consent handshake and pairwise key exchange.
 */

import { createInterface } from 'node:readline';
import { getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStoreAsync } from '../store.js';
import { createRelayClient } from '../relay-client.js';
import { createPairwiseChannelManagerV2 } from '../pairwise-channel-v2.js';

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
  const identity = await mgr.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

  const mailboxMatch = store.listMailboxMatches().find((candidate) => candidate.matchId === matchId);
  if (!mailboxMatch) {
    console.error(`Protocol v2 mailbox match "${matchId}" not found. Run "resonance inbox" first.`);
    store.close();
    process.exitCode = 1;
    return;
  }

  const relayUrl = options.relay ?? 'ws://localhost:9090';
  const client = createRelayClient({ relayUrl, identity });

  try {
    const pairwise = createPairwiseChannelManagerV2(store, client);
    const channel = await pairwise.initiate(matchId);
    console.log('Consent sent through the encrypted mailbox.');
    console.log(`Channel: ${channel.channelId ?? channel.localKeys.relationshipId} (${channel.status})`);
    console.log('Run "resonance inbox" to process the partner response.');
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
