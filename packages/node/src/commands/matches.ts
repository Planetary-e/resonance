/**
 * resonance matches — List pending match notifications.
 */

import { createInterface } from 'node:readline';
import { getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStoreAsync } from '../store.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

export async function matchesCommand(options: { password?: string; status?: string }): Promise<void> {
  const mgr = createIdentityManager();
  if (!mgr.exists()) {
    console.error('No identity found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = await mgr.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

  const matches = store.listMatches(options.status ? { status: options.status } : undefined);
  store.close();

  if (matches.length === 0) {
    console.log('No matches found.');
    return;
  }

  console.log(`\n${matches.length} match(es):\n`);
  for (const m of matches) {
    console.log(`  ${m.id}`);
    console.log(`    Partner:    ${m.partnerDID}`);
    console.log(`    Similarity: ${m.similarity.toFixed(3)}`);
    console.log(`    Status:     ${m.status}`);
    console.log(`    Created:    ${m.createdAt}`);
    console.log('');
  }
}
