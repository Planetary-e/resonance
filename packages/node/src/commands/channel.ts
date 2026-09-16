/**
 * resonance channel <channelId> — Interactive session on an active channel.
 * Supports protocol v2 disclosure, synchronization, close, and status.
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

export async function channelCommand(
  channelId: string,
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

  const relayUrl = options.relay ?? 'ws://localhost:9090';
  const client = createRelayClient({ relayUrl, identity });
  const pairwise = createPairwiseChannelManagerV2(store, client);
  const pairwiseChannel = pairwise.getByChannelId(channelId);
  if (!pairwiseChannel) {
    console.error(`Protocol v2 channel "${channelId}" not found.`);
    store.close();
    process.exitCode = 1;
    return;
  }
  {
    try {
      await pairwise.syncMailboxes();
    } catch (error) {
      console.error(`Mailbox sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`Channel ${channelId} — protocol v2 encrypted mailbox`);
    for (const message of pairwise.listMessages(channelId)) {
      if (message.kind === 'close') {
        console.log(`  ${message.direction === 'sent' ? 'You' : 'Partner'} closed the channel.`);
      } else {
        console.log(`  ${message.direction === 'sent' ? 'You' : 'Partner'} [${message.content!.level}]: ${message.content!.text}`);
      }
    }
    console.log('Commands: /disclose <general|specific|identifying> <text>, /sync, /close, /status\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt('> ');
    rl.prompt();
    rl.on('line', async (line: string) => {
      try {
        const trimmed = line.trim();
        if (trimmed.startsWith('/disclose ')) {
          const parts = trimmed.slice(10).split(' ');
          const level = parts[0] as 'general' | 'specific' | 'identifying';
          const text = parts.slice(1).join(' ');
          if (!['general', 'specific', 'identifying'].includes(level) || !text) {
            console.log('Usage: /disclose <general|specific|identifying> <text>');
          } else {
            await pairwise.sendDisclosure(channelId, text, level);
            console.log(`  Sent [${level}]: ${text}`);
          }
        } else if (trimmed === '/sync') {
          const result = await pairwise.syncMailboxes();
          console.log(`  Processed ${result.channelOperationsProcessed} channel operation(s).`);
        } else if (trimmed === '/close') {
          await pairwise.close(channelId);
          console.log('  Channel closed.');
          rl.close();
          return;
        } else if (trimmed === '/status') {
          console.log(`  State: ${pairwise.getByChannelId(channelId)?.status ?? 'unknown'}`);
        } else if (trimmed) {
          console.log('Unknown command. Use /disclose, /sync, /close, or /status');
        }
      } catch (error) {
        console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      rl.prompt();
    });
    rl.on('close', () => store.close());
    return;
  }
}
