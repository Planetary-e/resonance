/**
 * resonance status — Show node status summary.
 */

import { createInterface } from 'node:readline';
import { getDataDir, getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStore } from '../store.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

export async function statusCommand(options: { password?: string }): Promise<void> {
  const mgr = createIdentityManager();
  if (!mgr.exists()) {
    console.log('Not initialized. Run "resonance init" first.');
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = mgr.load(password);
  const store = openStore(getDbPath(), deriveStoreKey(identity));

  const items = store.listItems();
  const matches = store.listMatches();

  const localItems = items.filter(i => i.status === 'local').length;
  const publishedItems = items.filter(i => i.status === 'published').length;
  const withdrawnItems = items.filter(i => i.status === 'withdrawn').length;

  const pendingMatches = matches.filter(m => m.status === 'pending').length;
  const consentedMatches = matches.filter(m => m.status === 'consented').length;
  const confirmedMatches = matches.filter(m => m.status === 'confirmed').length;

  store.close();

  console.log(`\nResonance Node Status`);
  console.log(`${'─'.repeat(40)}`);
  console.log(`  DID:        ${identity.did}`);
  console.log(`  Data dir:   ${getDataDir()}`);
  console.log('');
  console.log(`  Items:      ${items.length} total`);
  if (items.length > 0) {
    console.log(`              ${publishedItems} published, ${localItems} local, ${withdrawnItems} withdrawn`);
  }
  console.log(`  Matches:    ${matches.length} total`);
  if (matches.length > 0) {
    console.log(`              ${pendingMatches} pending, ${consentedMatches} consented, ${confirmedMatches} confirmed`);
  }
}
