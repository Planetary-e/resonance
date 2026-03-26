/**
 * resonance channel <channelId> — Interactive session on an active channel.
 * Supports: /disclose, /accept, /reject, /close, /status
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
  const identity = mgr.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

  const storedChannel = store.getChannel(channelId);
  if (!storedChannel) {
    console.error(`Channel "${channelId}" not found.`);
    store.close();
    process.exitCode = 1;
    return;
  }

  const relayUrl = options.relay ?? 'ws://localhost:9090';
  const client = createRelayClient({ relayUrl, identity });
  const channelMgr = createChannelManager({ identity, store, relayClient: client });

  // Wire events
  channelMgr.on({
    onDisclosure(id, text, level) {
      console.log(`\n  [${level}] ${text}`);
      process.stdout.write('> ');
    },
    onAccept(id, message) {
      console.log(`\n  Partner accepted${message ? ': ' + message : ''}`);
      process.stdout.write('> ');
    },
    onReject(id, reason) {
      console.log(`\n  Partner rejected${reason ? ': ' + reason : ''}`);
      console.log('Channel closed.');
      process.exit(0);
    },
    onClose(id) {
      console.log('\n  Partner closed the channel.');
      process.exit(0);
    },
  });

  client.on({
    onChannelForward: (payload) => channelMgr.handleChannelForward(payload),
  });

  try {
    await client.connect();
  } catch {
    console.error('Could not connect to relay.');
    store.close();
    process.exitCode = 1;
    return;
  }

  console.log(`Channel ${channelId} — interactive session`);
  console.log('Commands: /disclose <level> <text>, /accept [msg], /reject [reason], /close, /status\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('> ');
  rl.prompt();

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    if (trimmed.startsWith('/disclose ')) {
      const parts = trimmed.slice(10).split(' ');
      const level = parts[0] as 'category' | 'detail' | 'contact';
      const text = parts.slice(1).join(' ');
      if (!['category', 'detail', 'contact'].includes(level) || !text) {
        console.log('Usage: /disclose <category|detail|contact> <text>');
      } else {
        await channelMgr.sendDisclosure(channelId, text, level);
        console.log(`  Sent [${level}]: ${text}`);
      }
    } else if (trimmed.startsWith('/accept')) {
      const msg = trimmed.slice(7).trim() || undefined;
      await channelMgr.sendAccept(channelId, msg);
      console.log('  Accepted.');
    } else if (trimmed.startsWith('/reject')) {
      const reason = trimmed.slice(7).trim() || undefined;
      await channelMgr.sendReject(channelId, reason);
      console.log('  Rejected. Channel closed.');
      rl.close();
      client.disconnect();
      store.close();
      return;
    } else if (trimmed === '/close') {
      await channelMgr.sendClose(channelId);
      console.log('  Channel closed.');
      rl.close();
      client.disconnect();
      store.close();
      return;
    } else if (trimmed === '/status') {
      const info = channelMgr.getChannel(channelId);
      if (info) {
        console.log(`  State: ${info.state}, Similarity: ${info.similarity?.toFixed(3) ?? 'n/a'}, Confirmed: ${info.confirmed ?? 'n/a'}`);
      }
    } else {
      console.log('Unknown command. Use /disclose, /accept, /reject, /close, or /status');
    }
    rl.prompt();
  });

  rl.on('close', () => {
    client.disconnect();
    store.close();
  });
}
