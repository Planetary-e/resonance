/**
 * resonance search "<text>" — Live search across the relay.
 * Query is ephemeral (not indexed). Returns top matches.
 */

import { EmbeddingEngine, hashEmbedding, getSharedProjectionMatrix, type ItemType } from '@resonance/core';
import { createRelayClient } from '../relay-client.js';

export async function searchCommand(
  text: string,
  options: { type?: string; k?: string; threshold?: string; relay?: string; group?: string },
): Promise<void> {
  const queryType = (options.type ?? 'need') as ItemType;
  const k = parseInt(options.k ?? '5');
  const threshold = parseFloat(options.threshold ?? '0.50');

  if (!['need', 'offer'].includes(queryType)) {
    console.error(`Invalid type "${queryType}". Must be "need" or "offer".`);
    process.exitCode = 1;
    return;
  }

  // Embed query and hash (relay only sees binary hash — not the embedding)
  const engine = new EmbeddingEngine();
  await engine.initialize();
  const embedding = await engine.embedForMatching(text, queryType);
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());

  const relayUrl = options.relay ?? 'ws://localhost:9090';
  const client = createRelayClient({ relayUrl });

  try {
    const results = await client.searchV2({
      groupId: options.group ?? 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: hash,
      itemType: queryType,
      k,
      threshold: Math.max(threshold, 0.65), // Hamming similarity threshold
    });

    if (results.results.length === 0) {
      console.log('\nNo matches found.');
    } else {
      console.log(`\n${results.results.length} result(s):\n`);
      for (const r of results.results) {
        console.log(`  ${r.publicationId}`);
        console.log(`    Type:       ${r.itemType}`);
        console.log(`    Similarity: ${r.similarity.toFixed(3)}`);
        console.log('');
      }
    }
  } catch (err) {
    console.error(`Search failed: ${err}`);
    process.exitCode = 1;
  } finally { client.disconnect(); }
}
