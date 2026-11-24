/**
 * Matching engine: wraps ComplementaryHammingIndex with relay-specific logic.
 * Generates match IDs, deduplicates DID pairs, tracks stats, handles persistence.
 *
 * Uses LSH binary hashes instead of float vectors — the relay never sees embeddings.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { guardUnmanagedExport } from './unmanaged-export.js';
import { writeAtomicJson } from './atomic-file.js';
import { createDeterministicMatchId, createStableNotificationIdV1, type ItemType } from '@resonance/core';
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
  notificationId?: string;
  notificationScope?: string;
}

export interface LeasedMatchNotification extends MatchNotification {
  notificationId: string;
  notificationScope: string;
}

export interface SearchResult {
  did: string;
  similarity: number;
  itemType: ItemType;
  publicationId?: string;
  generationId?: string;
}

export interface MatchingEngineConfig {
  matchExpiryMs?: number;
  matchThreshold?: number;
}

const DEFAULT_HAMMING_THRESHOLD = 0.70;

export class MatchingEngine {
  private readonly assertExportAllowed = guardUnmanagedExport();
  private index = new ComplementaryHammingIndex();
  private notifiedPairs = new Set<string>();
  private notifiedNotificationIds = new Set<string>();
  private leasedNotifications = new Map<string, LeasedMatchNotification>();
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
    queueNotifications = true,
    trackStats = true,
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
      const pairKey = [meta.did, matchedMeta.did].sort().join('\n');
      if (this.notifiedPairs.has(pairKey)) continue;
      this.notifiedPairs.add(pairKey);

      const matchId = createDeterministicMatchId(meta.itemId, matchedMeta.itemId);
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
    if (trackStats) this.updateDayCounter(notifications.length);

    // Queue for offline delivery
    if (queueNotifications) this.pendingNotifications.push(...notifications);

    return notifications;
  }

  /** Replace an existing publication revision before matching the new value. */
  replaceAndMatch(
    hash: Uint8Array,
    meta: HashMetadata,
    k: number = 10,
    threshold?: number,
    queueNotifications = true,
    trackStats = true,
  ): MatchNotification[] {
    this.index.removeByItemId(meta.itemId);
    this.withdrawnItems.delete(meta.itemId);
    for (const pairKey of this.notifiedPairs) {
      if (pairKey.split('\n').includes(meta.did)) this.notifiedPairs.delete(pairKey);
    }
    return this.insertAndMatch(hash, meta, k, threshold, queueNotifications, trackStats);
  }

  refreshLeased(hash: Uint8Array, meta: HashMetadata): void {
    this.index.removeByItemId(meta.itemId);
    this.index.addHash(hash, meta);
  }

  reviseLeasedAndMatch(
    hash: Uint8Array,
    meta: HashMetadata,
    notificationScope: string,
    k: number = 10,
    threshold?: number,
  ): LeasedMatchNotification[] {
    this.index.removeByItemId(meta.itemId);
    return this.insertLeasedAndMatch(hash, meta, notificationScope, k, threshold);
  }

  insertLeasedAndMatch(
    hash: Uint8Array,
    meta: HashMetadata,
    notificationScope: string,
    k: number = 10,
    threshold?: number,
  ): LeasedMatchNotification[] {
    const { matches } = this.index.addAndMatch(hash, meta, k, threshold ?? this.matchThreshold);
    const notifications: LeasedMatchNotification[] = [];
    const now = Date.now();
    for (const match of matches) {
      const matchedMeta = match.metadata;
      if (!matchedMeta || this.withdrawnItems.has(matchedMeta.itemId)) continue;
      const matchId = createDeterministicMatchId(meta.itemId, matchedMeta.itemId);
      const notificationId = createStableNotificationIdV1(matchId, notificationScope);
      if (this.notifiedNotificationIds.has(notificationId)) continue;
      this.notifiedNotificationIds.add(notificationId);
      const notification = {
        matchId,
        notificationId,
        notificationScope,
        publisherDID: meta.did,
        publisherItemId: meta.itemId,
        publisherItemType: meta.itemType,
        matchedDID: matchedMeta.did,
        matchedItemId: matchedMeta.itemId,
        matchedItemType: matchedMeta.itemType,
        similarity: match.similarity,
        expiry: now + this.matchExpiryMs,
      };
      notifications.push(notification);
      this.leasedNotifications.set(notificationId, notification);
    }
    if (notifications.length > 0) this.updateDayCounter(notifications.length);
    this.pendingNotifications.push(...notifications);
    return notifications;
  }

  removeLeased(itemId: string): void {
    this.index.removeByItemId(itemId);
  }

  exportLeasedDedup(publicationId: string): LeasedMatchNotification[] {
    return Array.from(this.leasedNotifications.values())
      .filter(notification => notification.publisherItemId === publicationId
        || notification.matchedItemId === publicationId)
      .map(notification => structuredClone(notification));
  }

  importLeasedDedup(notifications: readonly LeasedMatchNotification[]): void {
    for (const notification of notifications) {
      const expected = createStableNotificationIdV1(notification.matchId, notification.notificationScope);
      if (expected !== notification.notificationId) throw new Error('Invalid leased notification evidence');
      this.notifiedNotificationIds.add(notification.notificationId);
      this.leasedNotifications.set(notification.notificationId, structuredClone(notification));
    }
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

  leasedEntriesInInsertionOrder(itemType: ItemType): HashMetadata[] {
    return this.index.entriesInInsertionOrder(itemType);
  }

  /** Ephemeral search — does NOT index the query. */
  search(
    hash: Uint8Array,
    queryType: ItemType,
    k: number = 10,
    threshold?: number,
    scope?: string,
  ): SearchResult[] {
    const t = threshold ?? this.matchThreshold;
    const matches = this.index.search(hash, queryType, k, t, scope);
    const results: SearchResult[] = [];

    for (const match of matches) {
      if (this.withdrawnItems.has(match.metadata.itemId)) continue;
      results.push({
        did: match.metadata.did,
        similarity: match.similarity,
        itemType: match.metadata.itemType,
        ...(match.metadata.generationId ? {
          publicationId: match.metadata.itemId,
          generationId: match.metadata.generationId,
        } : {}),
      });
    }

    return results;
  }

  /** Expire items older than ttlMs from the index. */
  expireItems(ttlMs: number): number {
    return this.index.expireOlderThan(ttlMs);
  }

  /** Remove v2 publications according to each record's signed expiry. */
  expirePublications(now = Date.now()): number {
    return this.index.expireAtOrBefore(now);
  }

  /** Mark an item as withdrawn. */
  withdraw(did: string, itemId: string): boolean {
    this.withdrawnItems.add(itemId);
    this.index.removeByItemId(itemId);
    return true;
  }

  /** Save index + state to disk. */
  save(dir: string): void {
    this.assertExportAllowed();
    mkdirSync(dir, { recursive: true });
    this.index.save(dir);
    writeAtomicJson(join(dir, 'dedup.json'), Array.from(this.notifiedPairs));
    writeAtomicJson(join(dir, 'notification-dedup.json'), Array.from(this.leasedNotifications.values()));
    writeAtomicJson(join(dir, 'withdrawn.json'), Array.from(this.withdrawnItems));
    writeAtomicJson(join(dir, 'stats.json'), {
      matchesToday: this.matchesToday,
      matchesTodayDate: this.matchesTodayDate,
    });
    writeAtomicJson(join(dir, 'queue.json'), this.pendingNotifications);
  }

  /** Load index + state from disk. */
  load(dir: string): void {
    this.index.load(dir);

    const dedupPath = join(dir, 'dedup.json');
    if (existsSync(dedupPath)) {
      this.notifiedPairs = new Set(JSON.parse(readFileSync(dedupPath, 'utf-8')));
    }

    const notificationDedupPath = join(dir, 'notification-dedup.json');
    if (existsSync(notificationDedupPath)) {
      const parsed: unknown = JSON.parse(readFileSync(notificationDedupPath, 'utf-8'));
      if (!Array.isArray(parsed)) throw new Error('Invalid leased notification dedup state');
      for (const entry of parsed) {
        if (typeof entry === 'string') this.notifiedNotificationIds.add(entry);
        else if (isLeasedNotification(entry)) this.importLeasedDedup([entry]);
        else throw new Error('Invalid leased notification dedup state');
      }
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

function isLeasedNotification(value: unknown): value is LeasedMatchNotification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const notification = value as Record<string, unknown>;
  if (Object.keys(notification).sort().join(',') !== [
    'expiry', 'matchId', 'matchedDID', 'matchedItemId', 'matchedItemType',
    'notificationId', 'notificationScope', 'publisherDID', 'publisherItemId',
    'publisherItemType', 'similarity',
  ].sort().join(',')) return false;
  if (typeof notification.matchId !== 'string'
    || typeof notification.notificationId !== 'string'
    || typeof notification.notificationScope !== 'string'
    || typeof notification.publisherDID !== 'string'
    || typeof notification.publisherItemId !== 'string'
    || typeof notification.matchedDID !== 'string'
    || typeof notification.matchedItemId !== 'string'
    || (notification.publisherItemType !== 'need' && notification.publisherItemType !== 'offer')
    || (notification.matchedItemType !== 'need' && notification.matchedItemType !== 'offer')
    || typeof notification.similarity !== 'number'
    || !Number.isFinite(notification.similarity)
    || notification.similarity < 0
    || notification.similarity > 1
    || !Number.isSafeInteger(notification.expiry)) return false;
  try {
    return notification.matchId === createDeterministicMatchId(
      notification.publisherItemId,
      notification.matchedItemId,
    ) && notification.notificationId === createStableNotificationIdV1(
      notification.matchId,
      notification.notificationScope,
    );
  } catch {
    return false;
  }
}
