/**
 * resonance search "<text>" — Live search across the relay.
 * Query is ephemeral (not indexed). Returns top matches.
 */

import { createInterface } from 'node:readline';
import { EmbeddingEngine, hashEmbedding, getSharedProjectionMatrix, encodeBase64, type ItemType } from '@resonance/core';
import { createIdentityManager } from '../identity.js';
import { createRelayClient } from '../relay-client.js';

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

export async function searchCommand(
  text: string,
  options: { type?: string; k?: string; threshold?: string; password?: string; relay?: string },
): Promise<void> {
  const queryType = (options.type ?? 'need') as ItemType;
  const k = parseInt(options.k ?? '5');
  const threshold = parseFloat(options.threshold ?? '0.50');

  if (!['need', 'offer'].includes(queryType)) {
    console.error(`Invalid type "${queryType}". Must be "need" or "offer".`);
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

  // Embed query and hash (relay only sees binary hash — not the embedding)
  const engine = new EmbeddingEngine();
  await engine.initialize();
  const embedding = await engine.embedForMatching(text, queryType);
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());

  const relayUrl = options.relay ?? 'ws://localhost:9090';
  const client = createRelayClient({ relayUrl, identity });

  try {
    await client.connect();
    const results = await client.search({
      hash: encodeBase64(hash),
      k,
      threshold: Math.max(threshold, 0.65), // Hamming similarity threshold
    });

    if (results.results.length === 0) {
      console.log('\nNo matches found.');
    } else {
      console.log(`\n${results.results.length} result(s):\n`);
      for (const r of results.results) {
        console.log(`  ${r.did}`);
        console.log(`    Type:       ${r.itemType}`);
        console.log(`    Similarity: ${r.similarity.toFixed(3)}`);
        console.log('');
      }
    }
  } catch (err) {
    console.error(`Search failed: ${err}`);
    process.exitCode = 1;
  } finally {
    client.disconnect();
  }
}
