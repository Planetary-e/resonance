import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorageReservationAuthority, withStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { createPublicationRecord, generatePublicationKeyMaterial } from '@resonance/core';
import { RelayOperationLog, RELAY_OPERATION_LOG_FILENAME } from '../operation-log.js';
import { PrivateReplayLog, PRIVATE_REPLAY_LOG_FILENAME } from '../private-replay-log.js';
import { openResourceCheckpoint, RESOURCE_CHECKPOINT_BYTES } from '../resource-checkpoint.js';
import { openBoundedDiagnostics } from '../bounded-diagnostics.js';
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(extra: number) {
  const directory = mkdtempSync(join(tmpdir(), 'managed-writer-reservations-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  return { directory, ledger, authority };
}
const counter = (value: unknown): value is { total: number } => !!value && typeof value === 'object' && Number.isSafeInteger((value as { total: number }).total);
it('shares journal, replay, counter and diagnostic replacement peaks, and continues allocated work at full capacity', () => {
  const journalCap = 32768, replayCap = 512, logCap = 512;
  const n = fixture(2 * journalCap + 2 * replayCap + 2 * RESOURCE_CHECKPOINT_BYTES + 2 * logCap + 8192);
  const runtime = join(n.directory, 'runtime'), statsPath = join(runtime, 'counters.json'), logs = join(n.directory, 'diagnostics');
  const writers = withStorageReservationAuthority(n.authority, () => ({
    journal: new RelayOperationLog(runtime, journalCap), replay: new PrivateReplayLog(runtime, replayCap),
    stats: openResourceCheckpoint(statsPath, counter), diagnostics: openBoundedDiagnostics(logs, logCap),
  })); cleanup.push(writers.diagnostics.close);
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 4 });
  const now = Date.now(), record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'budget', fingerprint: new Uint8Array(64).fill(5), itemType: 'offer', createdAt: now, expiresAt: now + 60000 }, generatePublicationKeyMaterial());
  writers.journal.load(); writers.journal.append({ kind: 'publication', operation: record }, now); writers.journal.compact(writers.journal.entries);
  expect(writers.journal.load()[0].entry).toMatchObject({ kind: 'publication', operation: record });
  writers.replay.load(now);
  for (let i = 0; i < 3; i++) writers.replay.append({ id: `expired:${i}`, expiresAt: now + 1 }, now);
  writers.replay.append({ id: 'retained:request', expiresAt: now + 60000 }, now + 2);
  expect(writers.replay.load(now + 2)).toEqual([{ id: 'retained:request', expiresAt: now + 60000 }]);
  writers.stats.write({ total: 19 }); writers.stats.write({ total: 20 });
  for (let i = 0; i < 100; i++) writers.diagnostics.write(JSON.stringify({ event: 'rotation', index: i, detail: 'x'.repeat(100) }));
  expect(writers.diagnostics.status().available).toBe(true);
  const next = join(n.directory, 'not-created');
  expect(() => withStorageReservationAuthority(n.authority, () => new RelayOperationLog(next, 1))).toThrow(/exhausted/);
  expect(existsSync(next)).toBe(false);
  const names = [join(runtime, RELAY_OPERATION_LOG_FILENAME), join(runtime, PRIVATE_REPLAY_LOG_FILENAME), statsPath];
  const before = names.map(path => readFileSync(path)); n.authority.close();
  expect(() => writers.journal.append({ kind: 'publication', operation: record }, now + 1)).toThrow(/closed/);
  expect(() => writers.journal.load()).toThrow(/closed/); expect(() => writers.journal.compact([])).toThrow(/closed/);
  expect(() => writers.replay.load(now + 3)).toThrow(/closed/);
  expect(() => writers.replay.append({ id: 'another', expiresAt: now + 60000 }, now + 3)).toThrow(/closed/);
  expect(() => writers.stats.write({ total: 21 })).toThrow(/closed/);
  expect(names.map(path => readFileSync(path))).toEqual(before);
  expect(() => writers.diagnostics.write('disposable')).not.toThrow(); expect(writers.diagnostics.status()).toMatchObject({ available: false, droppedRecords: 1 });
});
it('rejects unbounded or unfunded writers before creating their directories', () => {
  const n = fixture(0);
  for (const [name, create] of [
    ['journal', (path: string) => new RelayOperationLog(path, 1)],
    ['unbounded', (path: string) => new RelayOperationLog(path)],
    ['replay', (path: string) => new PrivateReplayLog(path)],
    ['counter', (path: string) => openResourceCheckpoint(join(path, 'counter'), counter)],
    ['diagnostics', (path: string) => openBoundedDiagnostics(path)],
  ] as const) {
    const path = join(n.directory, name); expect(() => withStorageReservationAuthority(n.authority, () => create(path))).toThrow(); expect(existsSync(path)).toBe(false);
  }
  const zero = withStorageReservationAuthority(n.authority, () => new RelayOperationLog(join(n.directory, 'zero'), 0));
  zero.load(); zero.compact([]); expect(zero.byteLength).toBe(0); expect(n.authority.status().availableBytes).toBe(0);
});
it('retains writer allocations after reopening, including a smaller later component cap', () => {
  const n = fixture(65536), runtime = join(n.directory, 'runtime'), id = n.authority.status().authorityId;
  withStorageReservationAuthority(n.authority, () => new RelayOperationLog(runtime, 32768)); n.authority.close();
  const restored = openStorageReservationAuthority({ directory: n.ledger, mode: 'open-existing', authorityId: id }); cleanup.push(restored.close);
  const journal = withStorageReservationAuthority(restored, () => new RelayOperationLog(runtime, 1024)); journal.load();
  expect(restored.status()).toMatchObject({ availableBytes: 0, components: 1, reservedBytes: CONTROL + 65536 });
});
