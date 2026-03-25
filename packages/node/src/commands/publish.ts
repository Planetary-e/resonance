/**
 * resonance publish — Embed text, store locally, and publish to relay.
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  EmbeddingEngine,
  perturbWithLevel,
  type ItemType,
  type PrivacyLevel,
} from '@resonance/core';
import { getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStore } from '../store.js';
import { createRelayClient } from '../relay-client.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function publishCommand(
  text: string,
  options: { type?: string; privacy?: string; password?: string; relay?: string; localOnly?: boolean },
): Promise<void> {
  const itemType = (options.type ?? 'need') as ItemType;
  const privacyLevel = (options.privacy ?? 'medium') as PrivacyLevel;

  if (!['need', 'offer'].includes(itemType)) {
    console.error(`Invalid type "${itemType}". Must be "need" or "offer".`);
    process.exitCode = 1;
    return;
  }
  if (!['low', 'medium', 'high'].includes(privacyLevel)) {
    console.error(`Invalid privacy level "${privacyLevel}". Must be "low", "medium", or "high".`);
    process.exitCode = 1;
    return;
  }

  const mgr = createIdentityManager();
  if (!mgr.exists()) {
    console.error('No identity found. Run "resonance init" first.');
    process.exitCode = 1;
    return;
  }

  const password = options.password ?? await promptPassword('Password: ');
  const identity = mgr.load(password);

  // Initialize embedding engine
  const engine = new EmbeddingEngine();
  await engine.initialize();

  // Embed with matching-aware rewriting
  const embedding = await engine.embedForMatching(text, itemType);

  // Perturb
  const { perturbed, epsilon } = perturbWithLevel(embedding, privacyLevel);

  // Store locally
  const id = randomUUID();
  const store = openStore(getDbPath(), deriveStoreKey(identity));
  store.insertItem({
    id,
    type: itemType,
    rawText: text,
    embedding,
    privacyLevel,
    perturbed,
    epsilon,
  });

  console.log(`\nItem stored locally.`);
  console.log(`  ID:       ${id}`);
  console.log(`  Type:     ${itemType}`);
  console.log(`  Privacy:  ${privacyLevel} (ε=${epsilon.toFixed(2)})`);
  console.log(`  Dims:     ${embedding.length}`);

  // Publish to relay unless --local-only
  if (!options.localOnly) {
    const relayUrl = options.relay ?? 'ws://localhost:9090';
    try {
      const client = createRelayClient({ relayUrl, identity });
      await client.connect();
      await client.publish({
        itemId: id,
        vector: Array.from(perturbed),
        itemType,
        ttl: 604800,
      });
      store.updateItemStatus(id, 'published');
      client.disconnect();
      console.log(`  Status:   published (relay: ${relayUrl})`);
    } catch (err) {
      console.log(`  Status:   local (relay unavailable)`);
    }
  } else {
    console.log(`  Status:   local`);
  }

  store.close();
}
