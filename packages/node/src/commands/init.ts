/**
 * resonance init — Initialize identity, download model, create local database.
 */

import { createInterface } from 'node:readline';
import { EmbeddingEngine } from '@resonance/core';
import { ensureDataDir, getDataDir, getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStoreAsync } from '../store.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function initCommand(options: { password?: string }): Promise<void> {
  const mgr = createIdentityManager();

  if (mgr.exists()) {
    console.log('An identity or interrupted identity creation already exists. Unlock the existing account; preserve its files if recovery is needed.');
    return;
  }

  const password = options.password ?? await promptPassword('Set a password for your identity: ');
  if (!password) {
    console.error('Password cannot be empty.');
    process.exitCode = 1;
    return;
  }

  // 1. Create data directory
  ensureDataDir();
  console.log(`Data directory: ${getDataDir()}`);

  // 2. Generate and save identity
  const identity = await mgr.create(password);
  try {
    console.log(`Identity created: ${identity.did}`);

    // 3. Initialize embedding engine (downloads model on first run)
    console.log('Initializing embedding model (first run downloads ~90MB)...');
    const engine = new EmbeddingEngine();
    await engine.initialize();
    console.log('Embedding model ready.');

    // 4. Create database with schema
    const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
    store.close();
    console.log('Local database created.');

    console.log('\nResonance initialized successfully.');
    console.log(`  DID: ${identity.did}`);
    console.log(`  Data: ${getDataDir()}`);
  } finally {
    identity.secretKey.fill(0);
  }
}
