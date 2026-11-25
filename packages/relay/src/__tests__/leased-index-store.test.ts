import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
import {
  createDeterministicMatchId,
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createLeasedIndexWithdrawalV1,
  createOriginalCommitmentV1,
  createStableNotificationIdV1,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  serializeLeasedIndexOperationV1,
  type LeasedIndexKeyMaterialV1,
} from '@resonance/core';
import { LeasedIndexStore } from '../leased-index-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];

function fixture(itemType: 'need' | 'offer', fill: number, sequence = 0, semanticRevision = 0) {
  const keys = generateLeasedIndexKeyMaterialV1();
  const original = new Uint8Array(32).fill(fill);
  const commitmentKey = generateOriginalCommitmentKeyV1();
  const index = createLeasedIndexV1({
    leaseSequence: sequence,
    semanticRevision,
    groupId: 'public',
    itemType,
    derivationId: 'fixed-derivation-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(fill),
    originalCommitment: createOriginalCommitmentV1(original, commitmentKey),
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, keys);
  return { keys, index, originalCommitment: index.original.commitment };
}

function revision(
  keys: LeasedIndexKeyMaterialV1,
  originalCommitment: string,
  input: {
    leaseSequence: number;
    semanticRevision: number;
    createdAt: number;
    expiresAt: number;
    fingerprintFill?: number;
    derivationId?: string;
  },
) {
  return createLeasedIndexV1({
    leaseSequence: input.leaseSequence,
    semanticRevision: input.semanticRevision,
    groupId: 'public',
    itemType: 'need',
    derivationId: input.derivationId ?? 'fixed-derivation-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(input.fingerprintFill ?? 1),
    originalCommitment,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  }, keys);
}

function serialized(value: Parameters<typeof serializeLeasedIndexOperationV1>[0]): string {
  return serializeLeasedIndexOperationV1(value);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('leased relay refresh and stable notifications', () => {
  it('refreshes without re-matching or another logical notification', () => {
    const offer = fixture('offer', 0);
    const need = fixture('need', 0);
    const store = new LeasedIndexStore();

    expect(store.apply(serialized(offer.index), NOW).notifications).toHaveLength(0);
    const initial = store.apply(serialized(need.index), NOW);
    expect(initial.notifications).toHaveLength(1);
    const matchId = createDeterministicMatchId(offer.index.publicationId, need.index.publicationId);
    const notificationId = createStableNotificationIdV1(matchId, need.index.publicationId);
    expect(initial.notifications[0]).toMatchObject({ matchId, notificationId });

    const refreshed = revision(need.keys, need.originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 0,
      createdAt: NOW + DAY,
      expiresAt: NOW + 8 * DAY,
      fingerprintFill: 0,
    });
    const rematch = vi.spyOn(store.matching, 'reviseLeasedAndMatch');
    const result = store.apply(serialized(refreshed), NOW + DAY);
    expect(result.status).toBe('accepted');
    expect(result.notifications).toEqual([]);
    expect(rematch).not.toHaveBeenCalled();
    expect(refreshed.semanticRevision).toBe(need.index.semanticRevision);
    expect(refreshed.derivationId).toBe(need.index.derivationId);
    expect(refreshed.fingerprint).toEqual(need.index.fingerprint);
    expect(refreshed.original).toEqual(need.index.original);
    expect(store.byGeneration(createLeasedIndexGenerationIdV1(need.index))).toEqual(need.index);
    expect(store.byGeneration(createLeasedIndexGenerationIdV1(refreshed))).toEqual(refreshed);
    expect(store.matching.getPendingForDID(need.index.clientLeaseId)).toHaveLength(1);
  });

  it('re-evaluates semantic revisions without resetting stable identity across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-relay-'));
    directories.push(directory);
    const offer = fixture('offer', 0);
    const need = fixture('need', 0);
    const store = new LeasedIndexStore();
    store.apply(serialized(offer.index), NOW);
    const initial = store.apply(serialized(need.index), NOW).notifications[0];

    const revisedAway = revision(need.keys, need.originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
      fingerprintFill: 255,
      derivationId: 'fixed-derivation-v2',
    });
    const awayResult = store.apply(serialized(revisedAway), NOW + 1_000);
    expect(awayResult.status).toBe('accepted');
    expect(awayResult.notifications).toEqual([]);
    expect(store.matching.search(new Uint8Array(64), 'offer', 10, 0.7, 'public\nepoch-1')).toEqual([]);
    store.save(directory);

    const restored = new LeasedIndexStore();
    restored.load(directory);
    const revisedBack = revision(need.keys, need.originalCommitment, {
      leaseSequence: 2,
      semanticRevision: 2,
      createdAt: NOW + 2_000,
      expiresAt: NOW + 7 * DAY,
      fingerprintFill: 0,
      derivationId: 'fixed-derivation-v3',
    });
    const result = restored.apply(serialized(revisedBack), NOW + 2_000);
    expect(result.status).toBe('accepted');
    expect(result.notifications).toEqual([]);
    expect(restored.matching.getPendingForDID(need.index.clientLeaseId)).toHaveLength(1);
    expect(restored.matching.getPendingForDID(need.index.clientLeaseId)[0].notificationId)
      .toBe(initial.notificationId);
  });
});

describe('leased relay convergence and terminal state', () => {
  it('retains and quarantines exact-byte conflicts, refuses stale writes, and converges higher state', () => {
    const { keys, index, originalCommitment } = fixture('need', 1);
    const first = revision(keys, originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
    });
    const conflict = revision(keys, originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_001,
      expiresAt: NOW + 7 * DAY,
    });
    const store = new LeasedIndexStore();
    store.apply(serialized(first), NOW + 1_000);

    expect(store.apply(serialized(index), NOW + 1_000).status).toBe('stale');
    const conflictResult = store.apply(serialized(conflict), NOW + 1_001);
    expect(conflictResult.status).toBe('conflict');
    expect(conflictResult.conflictBytes).toBe(serialized(conflict));
    expect(store.isQuarantined(index.publicationId)).toBe(true);
    expect(store.activeRecords(NOW + 1_001)).toEqual([]);
    expect(store.exportReplicaState(index.publicationId)).toHaveLength(2);

    const higher = revision(keys, originalCommitment, {
      leaseSequence: 2,
      semanticRevision: 2,
      createdAt: NOW + 2_000,
      expiresAt: NOW + 7 * DAY,
    });
    expect(store.apply(serialized(higher), NOW + 2_000).status).toBe('accepted');
    expect(store.isQuarantined(index.publicationId)).toBe(false);
    expect(store.activeRecords(NOW + 2_000)).toEqual([higher]);
    expect(store.getExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(conflict)))
      .toBe(serialized(conflict));
  });

  it('treats withdrawal as terminal across arrival order and restart without deleting evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-relay-'));
    directories.push(directory);
    const { keys, index, originalCommitment } = fixture('need', 1);
    const future = revision(keys, originalCommitment, {
      leaseSequence: 3,
      semanticRevision: 1,
      createdAt: NOW + 3_000,
      expiresAt: NOW + 7 * DAY,
    });
    const withdrawal = createLeasedIndexWithdrawalV1(index, keys, NOW + 1_000);
    const store = new LeasedIndexStore();

    expect(store.apply(serialized(future), NOW + 3_000).status).toBe('accepted');
    expect(store.apply(serialized(withdrawal), NOW + 3_000).status).toBe('accepted');
    expect(store.activeRecords(NOW + 3_000)).toEqual([]);
    expect(store.apply(serialized(future), NOW + 3_000).status).toBe('duplicate');
    expect(store.get(index.publicationId)).toEqual(withdrawal);
    store.save(directory);

    const restored = new LeasedIndexStore();
    restored.load(directory);
    const later = revision(keys, originalCommitment, {
      leaseSequence: 4,
      semanticRevision: 2,
      createdAt: NOW + 4_000,
      expiresAt: NOW + 7 * DAY,
    });
    expect(restored.apply(serialized(later), NOW + 4_000).status).toBe('terminal');
    expect(restored.get(index.publicationId)).toEqual(withdrawal);
  });

  it('removes expired indexes from active discovery without fabricating a tombstone', () => {
    const { index } = fixture('need', 1);
    const store = new LeasedIndexStore();
    store.apply(serialized(index), NOW);

    expect(store.activeRecords(index.expiresAt - 1)).toEqual([index]);
    expect(store.activeRecords(index.expiresAt)).toEqual([]);
    expect(store.get(index.publicationId)).toEqual(index);
  });
});

describe('leased relay durability and replica repair', () => {
  it('restores exact signed bytes and conflict evidence after restart and repairs a missing replica offline', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-relay-'));
    directories.push(directory);
    const { keys, index, originalCommitment } = fixture('need', 1);
    const conflict = revision(keys, originalCommitment, {
      leaseSequence: 0,
      semanticRevision: 0,
      createdAt: NOW,
      expiresAt: NOW + 6 * DAY,
    });
    const source = new LeasedIndexStore();
    source.apply(serialized(index), NOW);
    source.apply(serialized(conflict), NOW);
    source.save(directory);

    const restored = new LeasedIndexStore();
    restored.load(directory);
    expect(restored.getExactBytes(index.publicationId)).toBe(serialized(index));
    expect(restored.getExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(conflict)))
      .toBe(serialized(conflict));
    expect(restored.byGeneration(createLeasedIndexGenerationIdV1(index))).toEqual(index);
    expect(restored.byGeneration(createLeasedIndexGenerationIdV1(conflict))).toEqual(conflict);
    expect(restored.isQuarantined(index.publicationId)).toBe(true);

    const repair = new LeasedIndexStore();
    const results = repair.repairFrom(restored, index.publicationId, NOW);
    expect(results.map(result => result.status)).toEqual(['accepted', 'conflict']);
    expect(repair.getExactBytes(index.publicationId)).toBe(serialized(index));
    expect(repair.isQuarantined(index.publicationId)).toBe(true);
  });

  it('repairs without re-matching and retains notification dedup for later semantic revisions', () => {
    const offer = fixture('offer', 0);
    const need = fixture('need', 0);
    const source = new LeasedIndexStore();
    source.apply(serialized(offer.index), NOW);
    expect(source.apply(serialized(need.index), NOW).notifications).toHaveLength(1);
    const repair = new LeasedIndexStore();
    repair.apply(serialized(offer.index), NOW);

    const repaired = repair.repairFrom(source, need.index.publicationId, NOW);
    expect(repaired).toHaveLength(1);
    expect(repaired[0].notifications).toEqual([]);
    expect(repair.matching.getPendingForDID(need.index.clientLeaseId)).toEqual([]);

    const revised = revision(need.keys, need.originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
      fingerprintFill: 0,
    });
    expect(repair.apply(serialized(revised), NOW + 1_000).notifications).toEqual([]);
    expect(repair.matching.getPendingForDID(need.index.clientLeaseId)).toEqual([]);
  });

  it('reopens the last flushed exact state after an interrupted atomic replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-relay-'));
    directories.push(directory);
    const { keys, index, originalCommitment } = fixture('need', 1);
    const store = new LeasedIndexStore();
    store.apply(serialized(index), NOW);
    store.save(directory);
    const next = revision(keys, originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
    });
    store.apply(serialized(next), NOW + 1_000);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('injected rename failure'); });

    expect(() => store.save(directory)).toThrow('injected rename failure');
    const reopened = new LeasedIndexStore();
    reopened.load(directory);
    expect(reopened.getExactBytes(index.publicationId)).toBe(serialized(index));
    expect(reopened.activeRecords(NOW)).toEqual([index]);
  });
});

describe('leased relay incremental persistence and exact active lookup', () => {
  it('appends exact operations without rewriting the base publication or matching snapshots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-incremental-'));
    directories.push(directory);
    const { keys, index, originalCommitment } = fixture('need', 1);
    const store = new LeasedIndexStore();
    store.apply(serialized(index), NOW);
    store.save(directory);
    const basePath = join(directory, 'leased-index-operations.json');
    const matchingPath = join(directory, 'needs-hamming.json');
    const baseModified = statSync(basePath).mtimeMs;
    const matchingModified = statSync(matchingPath).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 10));

    const next = revision(keys, originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 0,
      createdAt: NOW + DAY,
      expiresAt: NOW + 8 * DAY,
      fingerprintFill: 1,
    });
    store.apply(serialized(next), NOW + DAY);
    store.save(directory);
    expect(statSync(basePath).mtimeMs).toBe(baseModified);
    expect(statSync(matchingPath).mtimeMs).toBe(matchingModified);
    expect(readdirSync(join(directory, 'leased-index-log-v1')).filter(name => name.endsWith('.json'))).toHaveLength(3);

    const restored = new LeasedIndexStore();
    restored.load(directory);
    expect(restored.getExactBytes(index.publicationId)).toBe(serialized(next));
    expect(restored.getActiveExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(next), NOW + DAY))
      .toBe(serialized(next));
    expect(restored.getActiveExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(index), NOW + DAY))
      .toBeUndefined();
  });

  it('preserves conflict, later convergence, and terminal ordering across incremental restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-incremental-conflict-'));
    directories.push(directory);
    const { keys, index, originalCommitment } = fixture('need', 1);
    const conflict = revision(keys, originalCommitment, {
      leaseSequence: 0,
      semanticRevision: 0,
      createdAt: NOW,
      expiresAt: NOW + 6 * DAY,
    });
    const store = new LeasedIndexStore();
    store.apply(serialized(index), NOW);
    store.save(directory);
    store.apply(serialized(conflict), NOW);
    store.save(directory);

    const quarantined = new LeasedIndexStore();
    quarantined.load(directory);
    expect(quarantined.isQuarantined(index.publicationId)).toBe(true);
    expect(quarantined.getActiveExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(index), NOW))
      .toBeUndefined();
    expect(quarantined.getExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(conflict)))
      .toBe(serialized(conflict));

    const higher = revision(keys, originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
    });
    quarantined.apply(serialized(higher), NOW + 1_000);
    quarantined.save(directory);
    const converged = new LeasedIndexStore();
    converged.load(directory);
    expect(converged.getActiveExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(higher), NOW + 1_000))
      .toBe(serialized(higher));
    expect(converged.getActiveExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(higher), higher.expiresAt))
      .toBeUndefined();

    const withdrawal = createLeasedIndexWithdrawalV1(higher, keys, NOW + 2_000);
    converged.apply(serialized(withdrawal), NOW + 2_000);
    converged.save(directory);
    const terminal = new LeasedIndexStore();
    terminal.load(directory);
    expect(terminal.get(index.publicationId)).toEqual(withdrawal);
    expect(terminal.getActiveExactBytes(index.publicationId, createLeasedIndexGenerationIdV1(higher), NOW + 2_000))
      .toBeUndefined();
    expect(terminal.exportReplicaState(index.publicationId)).toContain(serialized(conflict));
  });

  it('persists notification dedup imported by an incremental replica repair', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-incremental-dedup-'));
    directories.push(directory);
    const offer = fixture('offer', 0);
    const need = fixture('need', 0);
    const source = new LeasedIndexStore();
    source.apply(serialized(offer.index), NOW);
    expect(source.apply(serialized(need.index), NOW).notifications).toHaveLength(1);
    const repair = new LeasedIndexStore();
    repair.apply(serialized(offer.index), NOW);
    repair.save(directory);
    repair.repairFrom(source, need.index.publicationId, NOW);
    repair.save(directory);

    const restored = new LeasedIndexStore();
    restored.load(directory);
    const revised = revision(need.keys, need.originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 1,
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
      fingerprintFill: 0,
    });
    expect(restored.apply(serialized(revised), NOW + 1_000).notifications).toEqual([]);
    expect(restored.matching.getPendingForDID(need.index.clientLeaseId)).toEqual([]);
  });

  it('preserves the authoritative legacy base during incremental migration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-legacy-migration-'));
    directories.push(directory);
    const { keys, index, originalCommitment } = fixture('need', 1);
    const store = new LeasedIndexStore();
    store.apply(serialized(index), NOW);
    store.save(directory);
    const basePath = join(directory, 'leased-index-operations.json');
    const originalBase = readFileSync(basePath);
    const originalModified = statSync(basePath).mtimeMs;
    rmSync(join(directory, 'leased-index-log-v1'), { recursive: true, force: true });
    const legacy = new LeasedIndexStore();
    legacy.load(directory);
    const next = revision(keys, originalCommitment, {
      leaseSequence: 1,
      semanticRevision: 0,
      createdAt: NOW + DAY,
      expiresAt: NOW + 8 * DAY,
      fingerprintFill: 1,
    });
    legacy.apply(serialized(next), NOW + DAY);
    await new Promise(resolve => setTimeout(resolve, 10));
    legacy.save(directory);
    expect(readFileSync(basePath).equals(originalBase)).toBe(true);
    expect(statSync(basePath).mtimeMs).toBe(originalModified);
    const restored = new LeasedIndexStore();
    restored.load(directory);
    expect(restored.getExactBytes(index.publicationId)).toBe(serialized(next));
  });

  it('rejects an incremental timestamp that differs from the signed operation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-corrupt-log-time-'));
    directories.push(directory);
    const { index } = fixture('need', 1);
    const store = new LeasedIndexStore();
    store.apply(serialized(index), NOW);
    store.save(directory);
    const path = join(directory, 'leased-index-log-v1', `${String(1).padStart(20, '0')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.createdAt++;
    writeFileSync(path, JSON.stringify(record));
    expect(() => new LeasedIndexStore().load(directory))
      .toThrow('Leased index log timestamp does not match signed operation');
  });

  it('streams canonical state with escapes and preserves fallback and truncation checks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-streamed-leased-base-'));
    directories.push(directory);
    const { keys, index } = fixture('need', 1);
    const custom = revision(keys, index.original.commitment, {
      leaseSequence: 0,
      semanticRevision: 0,
      createdAt: NOW,
      expiresAt: NOW + 7 * DAY,
      fingerprintFill: 1,
      derivationId: 'quoted"slash\\emoji😀',
    });
    const store = new LeasedIndexStore();
    store.apply(serialized(custom), NOW);
    store.save(directory);
    const path = join(directory, 'leased-index-operations.json');
    const canonical = readFileSync(path, 'utf8');
    expect(canonical.startsWith('{"version":1,"publications":[')).toBe(true);

    const restored = new LeasedIndexStore();
    restored.load(directory);
    expect(restored.getExactBytes(custom.publicationId)).toBe(serialized(custom));

    const parsed = JSON.parse(canonical);
    writeFileSync(path, JSON.stringify({ publications: parsed.publications, version: 1 }));
    expect(() => new LeasedIndexStore().load(directory)).not.toThrow();
    writeFileSync(path, canonical.slice(0, -20));
    expect(() => new LeasedIndexStore().load(directory)).toThrow('Incomplete leased index store');
  });
});
