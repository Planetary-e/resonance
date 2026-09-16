/**
 * resonance publish — Embed text, store locally, and publish to relay.
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  EmbeddingEngine,
  perturbWithLevel,
  hashEmbedding,
  getSharedProjectionMatrix,
  createPublicationRecord,
  generatePublicationKeyMaterial,
  type ItemType,
  type PrivacyLevel,
} from '@resonance/core';
import { getDbPath, deriveStoreKey } from '../config.js';
import { createIdentityManager } from '../identity.js';
import { openStoreAsync } from '../store.js';
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
  options: {
    type?: string;
    privacy?: string;
    password?: string;
    relay?: string;
    group?: string;
    localOnly?: boolean;
  },
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
  const identity = await mgr.load(password);

  // Initialize embedding engine
  const engine = new EmbeddingEngine();
  await engine.initialize();

  // Embed with matching-aware rewriting
  const embedding = await engine.embedForMatching(text, itemType);

  // Perturb
  const { perturbed, epsilon } = perturbWithLevel(embedding, privacyLevel);

  // Store locally
  const id = randomUUID();
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
  store.insertItem({
    id,
    type: itemType,
    rawText: text,
    embedding,
    privacyLevel,
    perturbed,
    epsilon,
  });

  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  const record = createPublicationRecord({
    groupId: options.group ?? 'public',
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: hashEmbedding(embedding, getSharedProjectionMatrix()),
    itemType,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
  }, keys);
  store.insertPublication(id, record, keys);

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
      const ack = await client.submitPublicationOperation(record);
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected publication');
      store.updateItemStatus(id, 'published');
      console.log(`  Status:   published (relay: ${relayUrl})`);
    } catch (err) {
      console.log(`  Status:   local (relay unavailable)`);
    }
  } else {
    console.log(`  Status:   local`);
  }

  store.close();
}
