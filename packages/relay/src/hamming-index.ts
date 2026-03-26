/**
 * Hamming distance index for LSH-based matching.
 * Brute-force scan over binary hashes — fast for pilot scale (<50K items).
 *
 * Replaces HNSW for privacy: the relay sees only compact binary hashes,
 * not float vectors. XOR + popcount is extremely fast on modern CPUs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemType } from '@resonance/core';

export interface HashMetadata {
  did: string;
  itemType: ItemType;
  itemId: string;
}

export interface HammingMatch {
  id: number;
  similarity: number; // Hamming similarity (0–1)
  metadata: HashMetadata;
}

/**
 * Single Hamming index — stores binary hashes with metadata.
 */
export class HammingIndex {
  private hashes: Uint8Array[] = [];
  private metadata: HashMetadata[] = [];

  addHash(hash: Uint8Array, meta: HashMetadata): number {
    const id = this.hashes.length;
    this.hashes.push(hash);
    this.metadata.push(meta);
    return id;
  }

  search(query: Uint8Array, k: number, threshold: number): HammingMatch[] {
    const results: HammingMatch[] = [];

    for (let i = 0; i < this.hashes.length; i++) {
      const sim = hammingSim(query, this.hashes[i]);
      if (sim >= threshold) {
        results.push({ id: i, similarity: sim, metadata: this.metadata[i] });
      }
    }

    // Sort by similarity descending, limit to k
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, k);
  }

  getMetadata(id: number): HashMetadata | undefined {
    return this.metadata[id];
  }

  getCount(): number {
    return this.hashes.length;
  }

  save(dir: string, prefix: string): void {
    mkdirSync(dir, { recursive: true });
    const data = {
      hashes: this.hashes.map(h => Array.from(h)),
      metadata: this.metadata,
    };
    writeFileSync(join(dir, `${prefix}-hamming.json`), JSON.stringify(data));
  }

  load(dir: string, prefix: string): void {
    const path = join(dir, `${prefix}-hamming.json`);
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    this.hashes = data.hashes.map((h: number[]) => new Uint8Array(h));
    this.metadata = data.metadata;
  }
}

/**
 * Complementary Hamming index: needs only match offers, never same-type.
 */
export class ComplementaryHammingIndex {
  private needsIndex = new HammingIndex();
  private offersIndex = new HammingIndex();

  addAndMatch(
    hash: Uint8Array,
    meta: HashMetadata,
    k: number = 10,
    threshold: number = 0.70,
  ): { id: number; matches: HammingMatch[] } {
    if (meta.itemType === 'need') {
      const id = this.needsIndex.addHash(hash, meta);
      const matches = this.offersIndex.search(hash, k, threshold);
      return { id, matches };
    } else {
      const id = this.offersIndex.addHash(hash, meta);
      const matches = this.needsIndex.search(hash, k, threshold);
      return { id, matches };
    }
  }

  addHash(hash: Uint8Array, meta: HashMetadata): number {
    if (meta.itemType === 'need') {
      return this.needsIndex.addHash(hash, meta);
    } else {
      return this.offersIndex.addHash(hash, meta);
    }
  }

  search(query: Uint8Array, queryType: ItemType, k: number = 10, threshold: number = 0.70): HammingMatch[] {
    if (queryType === 'need') {
      return this.offersIndex.search(query, k, threshold);
    } else {
      return this.needsIndex.search(query, k, threshold);
    }
  }

  getMetadata(id: number, itemType: ItemType): HashMetadata | undefined {
    if (itemType === 'need') return this.needsIndex.getMetadata(id);
    return this.offersIndex.getMetadata(id);
  }

  getCount(): { needs: number; offers: number; total: number } {
    const needs = this.needsIndex.getCount();
    const offers = this.offersIndex.getCount();
    return { needs, offers, total: needs + offers };
  }

  save(dir: string): void {
    this.needsIndex.save(dir, 'needs');
    this.offersIndex.save(dir, 'offers');
  }

  load(dir: string): void {
    this.needsIndex.load(dir, 'needs');
    this.offersIndex.load(dir, 'offers');
  }
}

// --- Internal ---

function hammingSim(a: Uint8Array, b: Uint8Array): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = a[i] ^ b[i];
    while (xor) { dist += xor & 1; xor >>>= 1; }
  }
  return 1 - dist / (a.length * 8);
}
