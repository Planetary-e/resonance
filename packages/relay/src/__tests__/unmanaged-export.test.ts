import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { PublicationOperationStore } from '../publication-store.js';
import { MailboxStore } from '../mailbox-store.js';
import { MatchingEngine } from '../matching-engine.js';
import { HammingIndex } from '../hamming-index.js';
import { HnswIndex } from '../hnsw.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const native = () => { const index = new HnswIndex({ dimensions: 2, maxElements: 16 }); index.initialize(); return index; };
const factories = [
  ['publication', () => { const value = new PublicationOperationStore(); return (path: string) => value.save(path); }],
  ['mailbox', () => { const value = new MailboxStore(); return (path: string) => value.save(path); }],
  ['matching', () => { const value = new MatchingEngine(); return (path: string) => value.save(path); }],
  ['hamming', () => { const value = new HammingIndex(); return (path: string) => value.save(path, 'test'); }],
  ['hnsw', () => { const value = native(); return (path: string) => value.save(path); }],
  ['hnsw-metadata', () => { const value = native(); return (path: string) => value.saveWithMetadata(path, 'test'); }],
] as const;
it.each(factories)('keeps %s exports unavailable to managed state even after its construction scope exits', (_name, create) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-export-boundary-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const authority = { reserve() { throw new Error('Unbounded export must not request an invented reservation'); } };
  const managed = withStorageReservationAuthority(authority, create), outside = join(root, 'outside');
  expect(() => managed(outside)).toThrow(/Unreserved materialized-view/);
  expect(() => withStorageReservationAuthority(authority, () => managed(outside))).toThrow(/Unreserved materialized-view/);
  const unmanaged = create();
  expect(() => withStorageReservationAuthority(authority, () => unmanaged(outside))).toThrow(/cannot switch/);
  expect(existsSync(outside)).toBe(false); expect(readdirSync(root)).toEqual([]);
  unmanaged(outside); expect(existsSync(outside)).toBe(true);
});
