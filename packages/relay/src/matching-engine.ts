/**
 * Matching engine: wraps MatchingIndex with relay-specific logic.
 * Generates match IDs, deduplicates DID pairs, tracks stats, handles persistence.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemType, MatchResult } from '@resonance/core';
import { HNSW_DEFAULTS } from '@resonance/core';
import { MatchingIndex, type HnswIndexConfig, type VectorMetadata } from './hnsw.js';

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

export class MatchingEngine {
  private index: MatchingIndex;
  private notifiedPairs = new Set<string>();
  private withdrawnItems = new Set<string>();
  private pendingNotifications: MatchNotification[] = [];
  private matchesToday = 0;
  private matchesTodayDate = new Date().toISOString().slice(0, 10);
  private matchExpiryMs: number;

  constructor(config?: Partial<HnswIndexConfig> & { matchExpiryMs?: number }) {
    this.index = new MatchingIndex(config);
    this.matchExpiryMs = config?.matchExpiryMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  initialize(): void {
    this.index.initialize();
  }

  /** Insert a vector and return match notifications for complementary items. */
  insertAndMatch(
    vector: number[],
    meta: VectorMetadata,
    k: number = 10,
    threshold: number = HNSW_DEFAULTS.similarityThreshold,
  ): MatchNotification[] {
    const { matches } = this.index.addAndMatch(vector, meta, k, threshold);
    const notifications: MatchNotification[] = [];
    const now = Date.now();

    for (const match of matches) {
      // Look up the matched item's metadata from the complementary index
      const matchedType: ItemType = meta.itemType === 'need' ? 'offer' : 'need';
      const matchedMeta = this.index.getMetadata(match.label, matchedType);
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

  /** Get pending notifications for a DID (both as publisher and as matched partner). */
  getPendingForDID(did: string): MatchNotification[] {
    const now = Date.now();
    return this.pendingNotifications.filter(
      n => (n.publisherDID === did || n.matchedDID === did) && n.expiry > now,
    );
  }

  /** Remove a notification from the queue (after successful delivery). */
  removeNotification(matchId: string, did: string): void {
    this.pendingNotifications = this.pendingNotifications.filter(
      n => !(n.matchId === matchId && (n.publisherDID === did || n.matchedDID === did)),
    );
  }

  /** Ephemeral search — does NOT index the query. */
  search(
    vector: number[],
    queryType: ItemType,
    k: number = 10,
    threshold: number = HNSW_DEFAULTS.similarityThreshold,
  ): SearchResult[] {
    const matches = this.index.search(vector, queryType, k, threshold);
    const results: SearchResult[] = [];

    const matchedType: ItemType = queryType === 'need' ? 'offer' : 'need';
    for (const match of matches) {
      const meta = this.index.getMetadata(match.label, matchedType);
      if (!meta) continue;
      if (this.withdrawnItems.has(meta.itemId)) continue;
      results.push({
        did: meta.did,
        similarity: match.similarity,
        itemType: meta.itemType,
      });
    }

    return results;
  }

  /** Mark an item as withdrawn. Cannot truly remove from HNSW, so we filter on search. */
  withdraw(did: string, itemId: string): boolean {
    this.withdrawnItems.add(itemId);
    return true;
  }

  /** Save index, dedup set, withdrawn set, and stats to disk. */
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

  /** Load index, dedup set, withdrawn set, and stats from disk. */
  load(dir: string): void {
    this.index.load(dir);

    const dedupPath = join(dir, 'dedup.json');
    if (existsSync(dedupPath)) {
      const pairs: string[] = JSON.parse(readFileSync(dedupPath, 'utf-8'));
      this.notifiedPairs = new Set(pairs);
    }

    const withdrawnPath = join(dir, 'withdrawn.json');
    if (existsSync(withdrawnPath)) {
      const items: string[] = JSON.parse(readFileSync(withdrawnPath, 'utf-8'));
      this.withdrawnItems = new Set(items);
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
