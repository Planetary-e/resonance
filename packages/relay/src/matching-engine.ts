/**
 * Matching engine: wraps ComplementaryHammingIndex with relay-specific logic.
 * Generates match IDs, deduplicates DID pairs, tracks stats, handles persistence.
 *
 * Uses LSH binary hashes instead of float vectors — the relay never sees embeddings.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemType } from '@resonance/core';
import { ComplementaryHammingIndex, type HashMetadata } from './hamming-index.js';

export interface MatchNotification {
  matchId: string;
  publisherDID: string;
  publisherItemId: string;
  publisherItemType: ItemType;
  matchedDID: string;
  matchedItemId: string;
  matchedItemType: ItemType;
  similarity: number;
  expiry: number;
}

export interface SearchResult {
  did: string;
  similarity: number;
  itemType: ItemType;
}

export interface MatchingEngineConfig {
  matchExpiryMs?: number;
  matchThreshold?: number;
}

const DEFAULT_HAMMING_THRESHOLD = 0.70;

export class MatchingEngine {
  private index = new ComplementaryHammingIndex();
  private notifiedPairs = new Set<string>();
  private withdrawnItems = new Set<string>();
  private pendingNotifications: MatchNotification[] = [];
  private matchesToday = 0;
  private matchesTodayDate = new Date().toISOString().slice(0, 10);
  private matchExpiryMs: number;
  private matchThreshold: number;

  constructor(config?: MatchingEngineConfig) {
    this.matchExpiryMs = config?.matchExpiryMs ?? 7 * 24 * 60 * 60 * 1000;
    this.matchThreshold = config?.matchThreshold ?? DEFAULT_HAMMING_THRESHOLD;
  }

  initialize(): void {
    // No-op for Hamming index (no HNSW init needed)
  }

  /** Insert a hash and return match notifications for complementary items. */
  insertAndMatch(
    hash: Uint8Array,
    meta: HashMetadata,
    k: number = 10,
    threshold?: number,
  ): MatchNotification[] {
    const t = threshold ?? this.matchThreshold;
    const { matches } = this.index.addAndMatch(hash, meta, k, t);
    const notifications: MatchNotification[] = [];
    const now = Date.now();

    for (const match of matches) {
      const matchedMeta = match.metadata;
      if (!matchedMeta) continue;

      // Skip withdrawn items
      if (this.withdrawnItems.has(matchedMeta.itemId)) continue;

      // Dedup: don't re-notify the same DID pair
      const pairKey = [meta.did, matchedMeta.did].sort().join(':');
      if (this.notifiedPairs.has(pairKey)) continue;
      this.notifiedPairs.add(pairKey);

      const matchId = randomUUID();
      notifications.push({
        matchId,
        publisherDID: meta.did,
        publisherItemId: meta.itemId,
        publisherItemType: meta.itemType,
        matchedDID: matchedMeta.did,
        matchedItemId: matchedMeta.itemId,
        matchedItemType: matchedMeta.itemType,
        similarity: match.similarity,
        expiry: now + this.matchExpiryMs,
      });
    }

    // Track daily stats
    this.updateDayCounter(notifications.length);

    // Queue for offline delivery
    this.pendingNotifications.push(...notifications);

    return notifications;
  }

  /** Get pending notifications for a DID. */
  getPendingForDID(did: string): MatchNotification[] {
    const now = Date.now();
    return this.pendingNotifications.filter(
      n => (n.publisherDID === did || n.matchedDID === did) && n.expiry > now,
    );
  }

  /** Remove a notification from the queue. */
  removeNotification(matchId: string, did: string): void {
    this.pendingNotifications = this.pendingNotifications.filter(
      n => !(n.matchId === matchId && (n.publisherDID === did || n.matchedDID === did)),
    );
  }

  /** Ephemeral search — does NOT index the query. */
  search(
    hash: Uint8Array,
    queryType: ItemType,
    k: number = 10,
    threshold?: number,
  ): SearchResult[] {
    const t = threshold ?? this.matchThreshold;
    const matches = this.index.search(hash, queryType, k, t);
    const results: SearchResult[] = [];

    for (const match of matches) {
      if (this.withdrawnItems.has(match.metadata.itemId)) continue;
      results.push({
        did: match.metadata.did,
        similarity: match.similarity,
        itemType: match.metadata.itemType,
      });
    }

    return results;
  }

  /** Mark an item as withdrawn. */
  withdraw(did: string, itemId: string): boolean {
    this.withdrawnItems.add(itemId);
    return true;
  }

  /** Save index + state to disk. */
  save(dir: string): void {
    mkdirSync(dir, { recursive: true });
    this.index.save(dir);
    writeFileSync(join(dir, 'dedup.json'), JSON.stringify(Array.from(this.notifiedPairs)));
    writeFileSync(join(dir, 'withdrawn.json'), JSON.stringify(Array.from(this.withdrawnItems)));
    writeFileSync(join(dir, 'stats.json'), JSON.stringify({
      matchesToday: this.matchesToday,
      matchesTodayDate: this.matchesTodayDate,
    }));
    writeFileSync(join(dir, 'queue.json'), JSON.stringify(this.pendingNotifications));
  }

  /** Load index + state from disk. */
  load(dir: string): void {
    this.index.load(dir);

    const dedupPath = join(dir, 'dedup.json');
    if (existsSync(dedupPath)) {
      this.notifiedPairs = new Set(JSON.parse(readFileSync(dedupPath, 'utf-8')));
    }

    const withdrawnPath = join(dir, 'withdrawn.json');
    if (existsSync(withdrawnPath)) {
      this.withdrawnItems = new Set(JSON.parse(readFileSync(withdrawnPath, 'utf-8')));
    }

    const statsPath = join(dir, 'stats.json');
    if (existsSync(statsPath)) {
      const stats = JSON.parse(readFileSync(statsPath, 'utf-8'));
      this.matchesToday = stats.matchesToday;
      this.matchesTodayDate = stats.matchesTodayDate;
    }

    const queuePath = join(dir, 'queue.json');
    if (existsSync(queuePath)) {
      this.pendingNotifications = JSON.parse(readFileSync(queuePath, 'utf-8'));
    }
  }

  getStats(): { needs: number; offers: number; total: number; matchesToday: number } {
    const counts = this.index.getCount();
    this.resetDayCounterIfNeeded();
    return { ...counts, matchesToday: this.matchesToday };
  }

  private updateDayCounter(newMatches: number): void {
    this.resetDayCounterIfNeeded();
    this.matchesToday += newMatches;
  }

  private resetDayCounterIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.matchesTodayDate) {
      this.matchesToday = 0;
      this.matchesTodayDate = today;
    }
  }
}
