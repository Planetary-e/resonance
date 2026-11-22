import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  generateLeasedIndexKeyMaterialV1,
  parseLeasedIndexOperationV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { LeasedIndexStore } from '@resonance/relay';
import { LeasedIndexLocalStore } from '../leased-index-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-leased-client-'));
  directories.push(directory);
  const path = join(directory, 'leased-state.json');
  const backupPath = join(directory, 'restored-state.json');
  const encryptionKey = randomBytes(32);
  const keys = generateLeasedIndexKeyMaterialV1();
  const originalBytes = new TextEncoder().encode('exact client original');
  const store = LeasedIndexLocalStore.create({
    path,
    encryptionKey,
    keys,
    originalBytes,
    input: {
      groupId: 'public',
      itemType: 'need',
      derivationId: 'fixed-derivation-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1),
      createdAt: NOW,
      expiresAt: NOW + 7 * DAY,
    },
  });
  return { directory, path, backupPath, encryptionKey, keys, originalBytes, store };
}

function ready(
  store: LeasedIndexLocalStore,
  relay: LeasedIndexStore,
  raw: string,
  now: number,
): string {
  expect(relay.apply(raw, now).status).toBe('accepted');
  store.acknowledge(raw);
  const result = store.reconcile([relay.exportReplicaState(store.currentOperation().publicationId)]);
  expect(result.status).toBe('ready');
  return result.writerLeaseId!;
}

function currentLive(store: LeasedIndexLocalStore): LeasedIndexV1 {
  const operation = store.currentOperation();
  if (operation.kind !== 'leased-discovery-index') throw new Error('Expected live index');
  return operation;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('encrypted leased client state', () => {
  it('persists exact signed outbox state and private originals without plaintext at rest', () => {
    const fixture = createStore();
    const pending = fixture.store.pendingOperation()!;
    const disk = readFileSync(fixture.path, 'utf8');

    expect(parseLeasedIndexOperationV1(pending)).toEqual(fixture.store.currentOperation());
    expect(fixture.store.read().acknowledgedBytes).toBeNull();
    expect(disk).not.toContain('exact client original');
    expect(disk).not.toContain(fixture.keys.signingKeyPair.secretKey.toString());
    expect(() => fixture.store.refresh('unreconciled', NOW + DAY, NOW + 8 * DAY)).toThrow('read-only');
    fixture.store.close();

    const reopened = LeasedIndexLocalStore.open({ path: fixture.path, encryptionKey: fixture.encryptionKey });
    expect(reopened.pendingOperation()).toBe(pending);
    expect(reopened.read().writerLeaseId).toBeNull();
    const relay = new LeasedIndexStore();
    expect(relay.apply(pending, NOW).status).toBe('accepted');
    const reconciliation = reopened.reconcile([relay.exportReplicaState(fixture.keys.publicationId)]);
    expect(reconciliation.status).toBe('ready');
    expect(reopened.pendingOperation()).toBeNull();
    expect(new TextDecoder().decode(reopened.original(0))).toBe('exact client original');
    reopened.close();
  });

  it('allows only one open local writer', () => {
    const fixture = createStore();
    expect(() => LeasedIndexLocalStore.open({ path: fixture.path, encryptionKey: fixture.encryptionKey }))
      .toThrow();
    fixture.store.close();
  });
});

describe('lease refresh and semantic revision', () => {
  it('increments only lease sequence for refresh and preserves dedup state', () => {
    const fixture = createStore();
    const relay = new LeasedIndexStore();
    const writer = ready(fixture.store, relay, fixture.store.pendingOperation()!, NOW);
    expect(fixture.store.recordNotification(`notification_${'A'.repeat(43)}`)).toBe(true);
    const before = currentLive(fixture.store);
    const refreshedBytes = fixture.store.refresh(writer, NOW + DAY, NOW + 8 * DAY);
    const refreshed = parseLeasedIndexOperationV1(refreshedBytes);

    expect(refreshed.kind).toBe('leased-discovery-index');
    if (refreshed.kind !== 'leased-discovery-index') return;
    expect(refreshed.leaseSequence).toBe(before.leaseSequence + 1);
    expect(refreshed.semanticRevision).toBe(before.semanticRevision);
    expect(refreshed.derivationId).toBe(before.derivationId);
    expect(refreshed.fingerprint).toEqual(before.fingerprint);
    expect(refreshed.original).toEqual(before.original);
    expect(fixture.store.read().notificationIds).toEqual([`notification_${'A'.repeat(43)}`]);
    expect(relay.apply(refreshedBytes, NOW + DAY).notifications).toEqual([]);
    expect(fixture.store.recordNotification(`notification_${'A'.repeat(43)}`)).toBe(false);
    fixture.store.close();
  });

  it('uses a controlled semantic path with a new original and commitment key', () => {
    const fixture = createStore();
    const relay = new LeasedIndexStore();
    const writer = ready(fixture.store, relay, fixture.store.pendingOperation()!, NOW);
    const before = currentLive(fixture.store);
    const revisedBytes = fixture.store.revise(writer, {
      originalBytes: new TextEncoder().encode('semantic revision original'),
      derivationId: 'fixed-derivation-v2',
      fingerprint: new Uint8Array(64).fill(2),
      createdAt: NOW + 1_000,
      expiresAt: NOW + 7 * DAY,
    });
    const revised = parseLeasedIndexOperationV1(revisedBytes);

    expect(revised.kind).toBe('leased-discovery-index');
    if (revised.kind !== 'leased-discovery-index') return;
    expect(revised.leaseSequence).toBe(before.leaseSequence + 1);
    expect(revised.semanticRevision).toBe(before.semanticRevision + 1);
    expect(revised.derivationId).toBe('fixed-derivation-v2');
    expect(revised.original.commitment).not.toBe(before.original.commitment);
    expect(new TextDecoder().decode(fixture.store.original(0))).toBe('exact client original');
    expect(new TextDecoder().decode(fixture.store.original(1))).toBe('semantic revision original');
    expect(relay.apply(revisedBytes, NOW + 1_000).status).toBe('accepted');
    expect(() => fixture.store.revise('wrong-writer', {
      originalBytes: new Uint8Array(),
      createdAt: NOW + 2_000,
      expiresAt: NOW + 7 * DAY,
    })).toThrow('read-only');
    fixture.store.close();
  });
});

describe('writer reconciliation and stale backup', () => {
  it('keeps a restored backup read-only until it reconciles the exact newer generation', () => {
    const fixture = createStore();
    const relay = new LeasedIndexStore();
    const initialWriter = ready(fixture.store, relay, fixture.store.pendingOperation()!, NOW);
    copyFileSync(fixture.path, fixture.backupPath);

    const refreshed = fixture.store.refresh(initialWriter, NOW + DAY, NOW + 8 * DAY);
    ready(fixture.store, relay, refreshed, NOW + DAY);
    const backup = LeasedIndexLocalStore.open({ path: fixture.backupPath, encryptionKey: fixture.encryptionKey });
    expect(() => backup.refresh(initialWriter, NOW + 2 * DAY, NOW + 9 * DAY)).toThrow('read-only');

    const reconciliation = backup.reconcile([relay.exportReplicaState(fixture.keys.publicationId)]);
    expect(reconciliation.status).toBe('ready');
    expect(currentLive(backup).leaseSequence).toBe(1);
    expect(backup.read().nextLeaseSequence).toBe(2);
    expect(reconciliation.generationId).toBe(createLeasedIndexGenerationIdV1(currentLive(backup)));
    backup.close();
    fixture.store.close();
  });

  it('becomes read-only on current-generation conflict evidence', () => {
    const fixture = createStore();
    const relay = new LeasedIndexStore();
    const initial = fixture.store.pendingOperation()!;
    const writer = ready(fixture.store, relay, initial, NOW);
    const current = currentLive(fixture.store);
    const conflict = createLeasedIndexV1({
      leaseSequence: current.leaseSequence,
      semanticRevision: current.semanticRevision,
      groupId: current.groupId,
      itemType: current.itemType,
      derivationId: current.derivationId,
      fingerprintEpoch: current.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(1),
      originalCommitment: current.original.commitment,
      createdAt: current.createdAt,
      expiresAt: current.expiresAt - 1,
    }, fixture.keys);
    const conflictBytes = JSON.stringify(conflict);
    expect(relay.apply(conflictBytes, NOW).status).toBe('conflict');

    const reconciliation = fixture.store.reconcile([relay.exportReplicaState(fixture.keys.publicationId)]);
    expect(reconciliation.status).toBe('conflict');
    expect(() => fixture.store.refresh(writer, NOW + DAY, NOW + 8 * DAY)).toThrow('read-only');
    fixture.store.close();
  });
});

describe('local withdrawal', () => {
  it('is terminal for writing while retaining originals and exact terminal evidence', () => {
    const fixture = createStore();
    const relay = new LeasedIndexStore();
    const writer = ready(fixture.store, relay, fixture.store.pendingOperation()!, NOW);
    const withdrawal = fixture.store.withdraw(writer, NOW + 1_000);

    expect(fixture.store.read().withdrawn).toBe(true);
    expect(() => fixture.store.refresh(writer, NOW + DAY, NOW + 8 * DAY)).toThrow('read-only');
    expect(new TextDecoder().decode(fixture.store.original(0))).toBe('exact client original');
    expect(relay.apply(withdrawal, NOW + 1_000).status).toBe('accepted');
    fixture.store.acknowledge(withdrawal);
    fixture.store.close();

    const reopened = LeasedIndexLocalStore.open({ path: fixture.path, encryptionKey: fixture.encryptionKey });
    const reconciliation = reopened.reconcile([relay.exportReplicaState(fixture.keys.publicationId)]);
    expect(reconciliation.status).toBe('withdrawn');
    expect(reopened.currentOperation()).toEqual(parseLeasedIndexOperationV1(withdrawal));
    expect(new TextDecoder().decode(reopened.original(0))).toBe('exact client original');
    reopened.close();
  });
});
