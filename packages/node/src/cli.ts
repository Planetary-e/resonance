#!/usr/bin/env node

/**
 * Planetary Resonance CLI — Privacy-preserving P2P matching.
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { publishCommand } from './commands/publish.js';
import { searchCommand } from './commands/search.js';
import { matchesCommand } from './commands/matches.js';
import { connectCommand } from './commands/connect.js';
import { channelCommand } from './commands/channel.js';
import { statusCommand } from './commands/status.js';
import { withdrawCommand } from './commands/withdraw.js';
import { inboxCommand } from './commands/inbox.js';
import { upgradeV2Command } from './commands/upgrade-v2.js';

const program = new Command();

program
  .name('resonance')
  .description('Planetary Resonance — Privacy-preserving P2P matching')
  .version('0.2.2');

program
  .command('init')
  .description('Initialize identity, download embedding model, and create local database')
  .option('--password <password>', 'Password to encrypt identity (prompts if omitted)')
  .action(initCommand);

program
  .command('publish')
  .description('Embed text and publish to the relay')
  .argument('<text>', 'Natural language text describing a need or offer')
  .option('--type <type>', 'Item type: need or offer', 'need')
  .option('--privacy <level>', 'Privacy level: low, medium, or high', 'medium')
  .option('--password <password>', 'Password to unlock identity')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .option('--group <id>', 'Matching group', 'public')
  .option('--local-only', 'Store locally without publishing to relay')
  .action(publishCommand);

program
  .command('withdraw')
  .description('Withdraw a publication with its publication-scoped key')
  .argument('<itemId>', 'Local item ID')
  .option('--password <password>', 'Password to unlock identity')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .action(withdrawCommand);

program
  .command('upgrade-v2')
  .description('Back up and upgrade v0.1 local items to fresh protocol v2 identities')
  .option('--password <password>', 'Password to unlock identity')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .option('--group <id>', 'Matching group', 'public')
  .option('--local-only', 'Create v2 records locally without publishing to relay')
  .action(upgradeV2Command);

program
  .command('inbox')
  .description('Process encrypted protocol v2 matches, consent, and channel messages')
  .option('--password <password>', 'Password to unlock identity')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .action(inboxCommand);

program
  .command('search')
  .description('Live search across the relay')
  .argument('<text>', 'Natural language text to search for')
  .option('--type <type>', 'Query type: need or offer (searches complementary)', 'need')
  .option('-k <number>', 'Max results', '5')
  .option('--threshold <number>', 'Min similarity', '0.50')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .option('--group <id>', 'Matching group', 'public')
  .action(searchCommand);

program
  .command('matches')
  .description('List match notifications')
  .option('--password <password>', 'Password to unlock identity')
  .action(matchesCommand);

program
  .command('connect')
  .description('Open a direct channel for a match')
  .argument('<matchId>', 'Match ID to connect to')
  .option('--password <password>', 'Password to unlock identity')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .action(connectCommand);

program
  .command('channel')
  .description('Interactive session on an active channel')
  .argument('<channelId>', 'Channel ID to interact with')
  .option('--password <password>', 'Password to unlock identity')
  .option('--relay <url>', 'Relay server URL', 'ws://localhost:9090')
  .action(channelCommand);

program
  .command('status')
  .description('Show node status: DID, items, matches, channels')
  .option('--password <password>', 'Password to unlock identity')
  .action(statusCommand);

program.parse();
