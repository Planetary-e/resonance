/**
 * HNSW index wrapper for approximate nearest neighbor search.
 * Wraps hnswlib-node with Resonance-specific types and cosine similarity threshold.
 */

import HnswLib from 'hnswlib-node';
const { HierarchicalNSW } = HnswLib;

import type { MatchResult, ItemType } from '@resonance/core';
import { HNSW_DEFAULTS } from '@resonance/core';

export interface HnswIndexConfig {
  dimensions: number;
  maxElements: number;
  m: number;
  efConstruction: number;
  efSearch: number;
}

export interface VectorMetadata {
  did: string;
  itemType: ItemType;
  itemId: string;
}

/**
 * Single HNSW index (used internally by MatchingIndex).
 */
export class HnswIndex {
  private index: InstanceType<typeof HierarchicalNSW> | null = null;
  private config: HnswIndexConfig;
  private labelCount = 0;
  private metadata = new Map<number, VectorMetadata>();

  constructor(config?: Partial<HnswIndexConfig>) {
    this.config = {
      dimensions: config?.dimensions ?? HNSW_DEFAULTS.dimensions,
      maxElements: config?.maxElements ?? HNSW_DEFAULTS.maxElements,
      m: config?.m ?? HNSW_DEFAULTS.m,
      efConstruction: config?.efConstruction ?? HNSW_DEFAULTS.efConstruction,
      efSearch: config?.efSearch ?? HNSW_DEFAULTS.efSearch,
    };
  }

  initialize(): void {
    this.index = new HierarchicalNSW('cosine', this.config.dimensions);
    this.index.initIndex(
      this.config.maxElements,
      this.config.m,
      this.config.efConstruction
    );
    this.index.setEf(this.config.efSearch);
  }

  addVector(vector: Float32Array | number[], meta: VectorMetadata): number {
    if (!this.index) throw new Error('Index not initialized');
    const label = this.labelCount++;
    this.index.addPoint(Array.from(vector), label);
    this.metadata.set(label, meta);
    return label;
  }

  search(
    query: Float32Array | number[],
    k: number = 5,
    threshold: number = HNSW_DEFAULTS.similarityThreshold
  ): MatchResult[] {
    if (!this.index) throw new Error('Index not initialized');
    if (this.labelCount === 0) return [];

    const actualK = Math.min(k, this.labelCount);
    const result = this.index.searchKnn(Array.from(query), actualK);

    const matches: MatchResult[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const distance = result.distances[i];
      const similarity = 1 - distance;
      if (similarity >= threshold) {
        matches.push({
          label: result.neighbors[i],
          distance,
          similarity,
        });
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    return matches;
  }

  getMetadata(label: number): VectorMetadata | undefined {
    return this.metadata.get(label);
  }

  getCount(): number {
    return this.labelCount;
  }

  save(path: string): void {
    if (!this.index) throw new Error('Index not initialized');
    this.index.writeIndexSync(path);
  }

  load(path: string): void {
    if (!this.index) throw new Error('Index not initialized');
    this.index.readIndexSync(path);
  }

  resize(newMaxElements: number): void {
    if (!this.index) throw new Error('Index not initialized');
    this.index.resizeIndex(newMaxElements);
    this.config.maxElements = newMaxElements;
  }
}

/**
 * Complementary matching index: needs only match against offers, never same-type.
 *
 * Maintains two separate HNSW indexes:
 * - needsIndex: stores need embeddings, searched by incoming offers
 * - offersIndex: stores offer embeddings, searched by incoming needs
 *
 * When a need is published → indexed in needsIndex, searched against offersIndex
 * When an offer is published → indexed in offersIndex, searched against needsIndex
 */
export class MatchingIndex {
  private needsIndex: HnswIndex;
  private offersIndex: HnswIndex;

  constructor(config?: Partial<HnswIndexConfig>) {
    this.needsIndex = new HnswIndex(config);
    this.offersIndex = new HnswIndex(config);
  }

  initialize(): void {
    this.needsIndex.initialize();
    this.offersIndex.initialize();
  }

  /** Add a vector and get matches from the complementary index */
  addAndMatch(
    vector: Float32Array | number[],
    meta: VectorMetadata,
    k: number = 5,
    threshold: number = HNSW_DEFAULTS.similarityThreshold,
  ): { label: number; matches: MatchResult[] } {
    if (meta.itemType === 'need') {
      const label = this.needsIndex.addVector(vector, meta);
      const matches = this.offersIndex.search(vector, k, threshold);
      return { label, matches };
    } else {
      const label = this.offersIndex.addVector(vector, meta);
      const matches = this.needsIndex.search(vector, k, threshold);
      return { label, matches };
    }
  }

  /** Add a vector without searching (for batch index building) */
  addVector(vector: Float32Array | number[], meta: VectorMetadata): number {
    if (meta.itemType === 'need') {
      return this.needsIndex.addVector(vector, meta);
    } else {
      return this.offersIndex.addVector(vector, meta);
    }
  }

  /** Search the complementary index for a given item type */
  search(
    query: Float32Array | number[],
    queryType: ItemType,
    k: number = 5,
    threshold: number = HNSW_DEFAULTS.similarityThreshold,
  ): MatchResult[] {
    // Needs search the offers index, offers search the needs index
    if (queryType === 'need') {
      return this.offersIndex.search(query, k, threshold);
    } else {
      return this.needsIndex.search(query, k, threshold);
    }
  }

  /** Get metadata from either index */
  getMetadata(label: number, itemType: ItemType): VectorMetadata | undefined {
    if (itemType === 'need') {
      return this.needsIndex.getMetadata(label);
    } else {
      return this.offersIndex.getMetadata(label);
    }
  }

  getCount(): { needs: number; offers: number; total: number } {
    const needs = this.needsIndex.getCount();
    const offers = this.offersIndex.getCount();
    return { needs, offers, total: needs + offers };
  }
}
