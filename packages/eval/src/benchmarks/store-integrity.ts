import type { BenchmarkResult } from '@resonance/core';
import {
  EmbeddingEngine,
  generateIdentity,
  perturbWithLevel,
  cosineSimilarity,
} from '@resonance/core';
import { openStore, deriveStoreKey } from '@resonance/node';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import Database from 'better-sqlite3';
import { timeSync, formatMs } from '../utils.js';

/** Benchmark: store encryption integrity and embedding fidelity */
export async function benchmarkStoreIntegrity(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const identity = generateIdentity();
  const key = deriveStoreKey(identity);

  // --- Embedding round-trip fidelity ---
  {
    const texts = [
      'I need a freelance Python developer for a Django project',
      'Looking for a room in Gracia, Barcelona',
      'Offering guitar lessons for beginners',
      'Seeking a data analyst who can work with SQL and Tableau',
      'Available as a personal trainer for home workouts',
    ];

    let allPerfect = true;
    let maxDrift = 0;
    const store = openStore(':memory:', key);

    for (const text of texts) {
      const embedding = await engine.embedForMatching(text, 'need');
      const { perturbed, epsilon } = perturbWithLevel(embedding, 'medium');
      const id = randomUUID();

      store.insertItem({ id, type: 'need', rawText: text, embedding, privacyLevel: 'medium', perturbed, epsilon });
      const item = store.getItem(id)!;

      // Compare embeddings element-by-element
      const sim = cosineSimilarity(embedding, item.embedding);
      const drift = 1 - sim;
      if (drift > maxDrift) maxDrift = drift;
      if (sim < 0.999999) allPerfect = false;

      // Verify raw text
      if (item.rawText !== text) allPerfect = false;

      // Verify perturbed round-trip
      const perturbedSim = cosineSimilarity(perturbed, item.perturbed!);
      if (perturbedSim < 0.999999) allPerfect = false;
    }
    store.close();

    results.push({
      name: 'Store embedding round-trip fidelity',
      target: 'cosine similarity = 1.0',
      actual: allPerfect
        ? `PASS (${texts.length} items, max drift=${maxDrift.toExponential(2)})`
        : `FAIL (max drift=${maxDrift.toExponential(2)})`,
      value: maxDrift,
      passed: allPerfect,
    });
  }

  // --- Encryption at rest verification ---
  {
    const store = openStore(':memory:', key);
    const text = 'This is highly sensitive private text that must be encrypted';
    const embedding = await engine.embed(text);
    store.insertItem({ id: 'enc-check', type: 'offer', rawText: text, embedding, privacyLevel: 'high' });
    store.close();

    // Cannot easily inspect :memory: DB from outside, so use a temp file
    const tmpPath = `/tmp/resonance-eval-${Date.now()}.db`;
    const fileStore = openStore(tmpPath, key);
    fileStore.insertItem({ id: 'enc-check', type: 'offer', rawText: text, embedding, privacyLevel: 'high' });
    fileStore.close();

    // Open raw database and check that encrypted columns are not plaintext
    const rawDb = new Database(tmpPath);
    const row = rawDb.prepare('SELECT raw_text_encrypted, embedding_encrypted FROM items WHERE id = ?').get('enc-check') as {
      raw_text_encrypted: Buffer;
      embedding_encrypted: Buffer;
    };
    rawDb.close();

    const rawBytes = row.raw_text_encrypted;
    const containsPlaintext = rawBytes.toString('utf-8').includes(text);

    // Cleanup
    try { (await import('node:fs')).unlinkSync(tmpPath); } catch { /* ignore */ }
    // Also remove WAL/SHM files
    try { (await import('node:fs')).unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
    try { (await import('node:fs')).unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }

    results.push({
      name: 'Store encryption at rest',
      target: 'raw_text not readable in DB',
      actual: !containsPlaintext ? 'PASS (ciphertext verified opaque)' : 'FAIL (plaintext found in DB)',
      value: containsPlaintext ? 0 : 1,
      passed: !containsPlaintext,
    });
  }

  // --- Wrong key rejection ---
  {
    const tmpPath = `/tmp/resonance-eval-wk-${Date.now()}.db`;
    const store = openStore(tmpPath, key);
    const embedding = await engine.embed('Test text');
    store.insertItem({ id: 'wk-1', type: 'need', rawText: 'Secret', embedding, privacyLevel: 'medium' });
    store.close();

    const wrongKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const wrongStore = openStore(tmpPath, wrongKey);
    let rejected = false;
    try {
      wrongStore.getItem('wk-1');
    } catch {
      rejected = true;
    }
    wrongStore.close();

    // Cleanup
    try { (await import('node:fs')).unlinkSync(tmpPath); } catch { /* ignore */ }
    try { (await import('node:fs')).unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
    try { (await import('node:fs')).unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }

    results.push({
      name: 'Store wrong key rejection',
      target: 'decryption fails with wrong key',
      actual: rejected ? 'PASS (decryption rejected)' : 'FAIL (decryption succeeded with wrong key)',
      value: rejected ? 1 : 0,
      passed: rejected,
    });
  }

  // --- Store CRUD performance ---
  {
    const store = openStore(':memory:', key);
    const embedding = await engine.embed('Performance test');
    const { perturbed, epsilon } = perturbWithLevel(embedding, 'medium');
    const count = 100;

    // Insert
    const { durationMs: insertMs } = timeSync(() => {
      for (let i = 0; i < count; i++) {
        store.insertItem({
          id: randomUUID(),
          type: i % 2 === 0 ? 'need' : 'offer',
          rawText: `Performance test item #${i}`,
          embedding,
          privacyLevel: 'medium',
          perturbed,
          epsilon,
        });
      }
    });

    // List all
    const { durationMs: listMs } = timeSync(() => {
      store.listItems();
    });

    // Get single
    const items = store.listItems();
    const { durationMs: getMs } = timeSync(() => {
      for (let i = 0; i < count; i++) {
        store.getItem(items[i % items.length].id);
      }
    });

    store.close();

    results.push({
      name: `Store insert (×${count})`,
      target: 'info',
      actual: `${formatMs(insertMs)} total (${formatMs(insertMs / count)}/op)`,
      value: insertMs / count,
      passed: true,
    });

    results.push({
      name: `Store list (${count} items, decrypt all)`,
      target: 'info',
      actual: formatMs(listMs),
      value: listMs,
      passed: true,
    });

    results.push({
      name: `Store get+decrypt (×${count})`,
      target: 'info',
      actual: `${formatMs(getMs)} total (${formatMs(getMs / count)}/op)`,
      value: getMs / count,
      passed: true,
    });
  }

  return results;
}
