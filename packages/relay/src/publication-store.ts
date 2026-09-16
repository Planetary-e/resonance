/**
 * Relay-side materialized view of protocol v2 publication operations.
 *
 * Operations are self-authenticating and idempotent. The relay keeps only the
 * highest accepted operation for each publication; tombstones are terminal so
 * stale replicas cannot resurrect withdrawn data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPublicationActive,
  verifyPublicationRecord,
  verifyPublicationOperation,
  type PublicationOperation,
  type PublicationRecord,
} from '@resonance/core';

export type PublicationApplyStatus = 'accepted' | 'duplicate' | 'stale' | 'conflict' | 'terminal' | 'invalid';

export interface PublicationApplyResult {
  status: PublicationApplyStatus;
  current?: PublicationOperation;
}

const STORE_FILENAME = 'publication-operations.json';

interface PublicationState {
  current: PublicationOperation;
  /** Retained so a tombstoned publication can still authenticate mailbox cleanup. */
  record?: PublicationRecord;
}

export class PublicationOperationStore {
  private publications = new Map<string, PublicationState>();

  evaluate(operation: unknown): PublicationApplyResult {
    if (!verifyPublicationOperation(operation)) return { status: 'invalid' };

    const state = this.publications.get(operation.publicationId);
    const current = state?.current;
    if (!current) {
      return { status: 'accepted', current: operation };
    }

    if (current.kind === operation.kind && current.signature === operation.signature) {
      return { status: 'duplicate', current };
    }

    // A signed withdrawal is irreversible for this publication identity. It
    // must therefore dominate a live operation even if relays received those
    // two valid owner-signed records in opposite sequence order.
    if (current.kind === 'publication-tombstone') return { status: 'terminal', current };
    if (operation.kind === 'publication-tombstone') return { status: 'accepted', current };

    if (current.sequence === operation.sequence) return { status: 'conflict', current };

    if (operation.sequence < current.sequence) return { status: 'stale', current };

    return { status: 'accepted', current: operation };
  }

  apply(operation: unknown): PublicationApplyResult {
    const result = this.evaluate(operation);
    if (result.status !== 'accepted' || !verifyPublicationOperation(operation)) return result;

    const state = this.publications.get(operation.publicationId);

    this.publications.set(operation.publicationId, {
      current: operation,
      record: operation.kind === 'publication' ? operation : state?.record,
    });
    return { status: 'accepted', current: operation };
  }

  list(): PublicationOperation[] {
    return Array.from(this.publications.values(), state => state.current)
      .sort((a, b) => a.publicationId.localeCompare(b.publicationId));
  }

  activeRecords(now = Date.now()): PublicationRecord[] {
    return this.list().filter((operation): operation is PublicationRecord => (
      operation.kind === 'publication' && isPublicationActive(operation, now)
    ));
  }

  expiredPublicationIds(now = Date.now()): string[] {
    return this.list().flatMap(operation => (
      operation.kind === 'publication' && operation.expiresAt <= now
        ? [operation.publicationId]
        : []
    ));
  }

  nextExpiryAfter(now = Date.now()): number | undefined {
    let next: number | undefined;
    for (const operation of this.publications.values()) {
      const current = operation.current;
      if (current.kind !== 'publication' || current.expiresAt <= now) continue;
      if (next === undefined || current.expiresAt < next) next = current.expiresAt;
    }
    return next;
  }

  get tombstoneCount(): number {
    let count = 0;
    for (const state of this.publications.values()) {
      if (state.current.kind === 'publication-tombstone') count++;
    }
    return count;
  }

  get(publicationId: string): PublicationOperation | undefined {
    return this.publications.get(publicationId)?.current;
  }

  getRecord(publicationId: string): PublicationRecord | undefined {
    return this.publications.get(publicationId)?.record;
  }

  get size(): number {
    return this.publications.size;
  }

  save(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const publications = Array.from(this.publications.values())
      .sort((a, b) => a.current.publicationId.localeCompare(b.current.publicationId));
    writeFileSync(join(dir, STORE_FILENAME), JSON.stringify({ version: 2, publications }));
  }

  load(dir: string): void {
    const path = join(dir, STORE_FILENAME);
    if (!existsSync(path)) return;

    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isStoredFile(parsed)) throw new Error('Invalid persisted publication operation store');

    const restored = new Map<string, PublicationState>();
    for (const state of parsed.publications) {
      if (!isPublicationState(state) || restored.has(state.current.publicationId)) {
        throw new Error('Invalid persisted publication state');
      }
      restored.set(state.current.publicationId, state);
    }
    this.publications = restored;
  }
}

function isStoredFile(value: unknown): value is { version: 2; publications: unknown[] } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 2
    && Array.isArray((value as Record<string, unknown>).publications)
    && Object.keys(value).sort().join(',') === 'publications,version';
}

function isPublicationState(value: unknown): value is PublicationState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!verifyPublicationOperation(state.current)) return false;
  const expectedKeys = state.record === undefined ? ['current'] : ['current', 'record'];
  if (Object.keys(state).sort().join(',') !== expectedKeys.sort().join(',')) return false;
  if (state.record === undefined) return state.current.kind === 'publication-tombstone';
  if (!verifyPublicationRecord(state.record)
    || state.record.publicationId !== state.current.publicationId
    || state.record.publicationKey !== state.current.publicationKey
    || state.record.sequence > state.current.sequence) return false;
  return state.current.kind === 'publication-tombstone'
    || state.current.signature === state.record.signature;
}
