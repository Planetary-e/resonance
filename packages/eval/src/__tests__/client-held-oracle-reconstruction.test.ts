import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexSearchRequestV1,
  createLeasedIndexV1,
  createLeasedIndexWithdrawalV1,
  createOriginalCommitmentV1,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateSigningKeyPair,
  serializeLeasedIndexOperationV1,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { LeasedIndexStore } from '@resonance/relay';
import { reconstructRelayFixtureState, reconcileFixtureWithCurrent } from '../client-held-oracle-reconstruction.js';
import { ActiveFixtureState, advanceFixtureOnAcknowledgment, validateSearchResults } from '../client-held-search-validation.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const directories: string[] = [];

function fixture(fingerprint = new Uint8Array(64)): { keys: LeasedIndexKeyMaterialV1; index: LeasedIndexV1 } {
  const keys = generateLeasedIndexKeyMaterialV1();
  const index = createLeasedIndexV1({
    groupId: 'public',
    itemType: 'need',
    derivationId: 'oracle-reconstruction-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint,
    originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, keys);
  return { keys, index };
}

function refresh(value: ReturnType<typeof fixture>): LeasedIndexV1 {
  return createLeasedIndexV1({
    leaseSequence: value.index.leaseSequence + 1,
    semanticRevision: value.index.semanticRevision,
    groupId: value.index.groupId,
    itemType: value.index.itemType,
    derivationId: value.index.derivationId,
    fingerprintEpoch: value.index.fingerprint.epoch,
    fingerprint: new Uint8Array(64),
    originalCommitment: value.index.original.commitment,
    createdAt: NOW + DAY,
    expiresAt: NOW + 8 * DAY,
  }, value.keys);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('client-held replayed oracle reconstruction', () => {
  it('uses current log generation and production remove/reinsert order, then excludes conflict and withdrawal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-oracle-reconstruction-'));
    directories.push(directory);
    const first = fixture();
    const second = fixture();
    const third = fixture();
    const operations = [first.index, second.index, third.index];
    const store = new LeasedIndexStore();
    for (const operation of operations) store.apply(serializeLeasedIndexOperationV1(operation), NOW);
    store.save(directory);
    const refreshed = refresh(second);
    expect(store.apply(serializeLeasedIndexOperationV1(refreshed), NOW + DAY).status).toBe('accepted');
    store.save(directory);

    const state = reconstructRelayFixtureState(directory, operations, () => NOW + DAY, new Map());
    expect(state.activeOperations(NOW + DAY)[0]).toBe(first.index);
    expect(state.activeOperations(NOW + DAY)[1]).toBe(third.index);
    expect(state.currentGenerationId(second.index.publicationId)).toBe(createLeasedIndexGenerationIdV1(refreshed));
    expect(state.activeOperations(NOW + DAY).map(operation => operation.publicationId)).toEqual([
      first.index.publicationId, third.index.publicationId, second.index.publicationId,
    ]);
    const request = createLeasedIndexSearchRequestV1({
      groupId: 'public', itemType: 'offer', fingerprintEpoch: 'epoch-1', fingerprint: new Uint8Array(64),
      limit: 10, createdAt: NOW + DAY, expiresAt: NOW + DAY + 10_000,
    }, generateSigningKeyPair());
    expect(validateSearchResults({
      request,
      results: [first.index, third.index, refreshed].map(serializeLeasedIndexOperationV1),
      state,
      expectedPublicationId: second.index.publicationId,
      expectedGenerationId: createLeasedIndexGenerationIdV1(refreshed),
      now: NOW + DAY,
    })).toHaveLength(3);

    const conflict = createLeasedIndexV1({
      leaseSequence: refreshed.leaseSequence,
      semanticRevision: refreshed.semanticRevision,
      groupId: refreshed.groupId,
      itemType: refreshed.itemType,
      derivationId: refreshed.derivationId,
      fingerprintEpoch: refreshed.fingerprint.epoch,
      fingerprint: new Uint8Array(64),
      originalCommitment: refreshed.original.commitment,
      createdAt: refreshed.createdAt + 1,
      expiresAt: refreshed.expiresAt,
    }, second.keys);
    expect(store.apply(serializeLeasedIndexOperationV1(conflict), NOW + DAY + 1).status).toBe('conflict');
    store.save(directory);
    expect(reconstructRelayFixtureState(directory, operations, () => NOW + DAY).activeOperations(NOW + DAY + 1)
      .map(operation => operation.publicationId)).toEqual([first.index.publicationId, third.index.publicationId]);

    const withdrawal = createLeasedIndexWithdrawalV1(third.index, third.keys, NOW + DAY + 2);
    expect(store.apply(serializeLeasedIndexOperationV1(withdrawal), NOW + DAY + 2).status).toBe('accepted');
    store.save(directory);
    expect(reconstructRelayFixtureState(directory, operations, () => NOW + DAY).activeOperations(NOW + DAY + 2)
      .map(operation => operation.publicationId)).toEqual([first.index.publicationId]);
  });

  it('preserves raw insertion order when zero-query ranking opposes the actual tied query', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-oracle-raw-order-'));
    directories.push(directory);
    const lowerZero = new Uint8Array(64);
    lowerZero.fill(255, 0, 8);
    const higherZero = new Uint8Array(64);
    higherZero.fill(255, 0, 16);
    const firstInProduction = fixture(higherZero);
    const secondInProduction = fixture(lowerZero);
    const operations = [firstInProduction.index, secondInProduction.index];
    const store = new LeasedIndexStore();
    for (const operation of operations) store.apply(serializeLeasedIndexOperationV1(operation), NOW);
    const zeroRanking = store.matching.search(new Uint8Array(64), 'offer', 10, 0, 'public\nepoch-1')
      .map(match => match.publicationId);
    expect(zeroRanking).toEqual([secondInProduction.index.publicationId, firstInProduction.index.publicationId]);
    store.save(directory);

    const state = reconstructRelayFixtureState(directory, operations, () => NOW);
    expect(state.activeOperations(NOW).map(operation => operation.publicationId)).toEqual([
      firstInProduction.index.publicationId, secondInProduction.index.publicationId,
    ]);
    const actualQuery = new Uint8Array(64);
    actualQuery.fill(255, 12, 16);
    const request = createLeasedIndexSearchRequestV1({
      groupId: 'public', itemType: 'offer', fingerprintEpoch: 'epoch-1', fingerprint: actualQuery,
      limit: 10, createdAt: NOW, expiresAt: NOW + 10_000,
    }, generateSigningKeyPair());
    expect(validateSearchResults({
      request,
      results: operations.map(serializeLeasedIndexOperationV1),
      state,
      now: NOW,
    })).toHaveLength(2);
    expect(() => validateSearchResults({
      request,
      results: [...operations].reverse().map(serializeLeasedIndexOperationV1),
      state,
      now: NOW,
    })).toThrow('search_top_generation_set_mismatch');
  });

  it('clears uncertainty only after production-order current replay and refuses stale regression', () => {
    const initial = fixture();
    const refreshed = refresh(initial);
    const state = new ActiveFixtureState([initial.index]);

    const originalOutcome = advanceFixtureOnAcknowledgment(state, refreshed, {
      outcome: 'error', reason: 'timeout',
    });
    expect(originalOutcome).toBe(false);
    expect(state.hasPendingUncertainty()).toBe(true);
    const reconciled = reconcileFixtureWithCurrent(state, refreshed, NOW + DAY);
    expect(reconciled).toMatchObject({ status: 'reconciled', activeExactMatch: true });
    expect(state.hasPendingUncertainty()).toBe(false);
    expect(state.currentGenerationId(initial.index.publicationId)).toBe(createLeasedIndexGenerationIdV1(refreshed));

    expect(advanceFixtureOnAcknowledgment(state, initial.index, {
      outcome: 'error', reason: 'timeout',
    })).toBe(false);
    const stale = reconcileFixtureWithCurrent(state, initial.index, NOW + DAY);
    expect(stale).toMatchObject({ status: 'unresolved', productionApplyStatus: 'stale', activeExactMatch: false });
    expect(state.hasPendingUncertainty()).toBe(true);
    expect(state.currentGenerationId(initial.index.publicationId)).toBe(createLeasedIndexGenerationIdV1(refreshed));
  });

  it('preserves production order when A loses its ACK after B commits and A later reconciles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-oracle-reconcile-order-'));
    directories.push(directory);
    const first = fixture();
    const second = fixture();
    const firstRefresh = refresh(first);
    const secondRefresh = refresh(second);
    const store = new LeasedIndexStore();
    store.apply(serializeLeasedIndexOperationV1(first.index), NOW);
    store.apply(serializeLeasedIndexOperationV1(second.index), NOW);
    store.apply(serializeLeasedIndexOperationV1(firstRefresh), NOW + DAY);
    store.apply(serializeLeasedIndexOperationV1(secondRefresh), NOW + DAY);
    store.save(directory);

    const state = new ActiveFixtureState([first.index, second.index]);
    const originalOutcome = advanceFixtureOnAcknowledgment(state, firstRefresh, {
      outcome: 'error', reason: 'timeout',
    });
    expect(originalOutcome).toBe(false);
    expect(advanceFixtureOnAcknowledgment(state, secondRefresh, {
      outcome: 'ok', reason: 'accepted',
    })).toBe(true);
    expect(reconcileFixtureWithCurrent(state, firstRefresh, NOW + DAY)).toMatchObject({
      status: 'reconciled', activeExactMatch: true,
    });
    expect(state.activeOperations(NOW + DAY).map(operation => operation.publicationId)).toEqual([
      first.index.publicationId, second.index.publicationId,
    ]);

    state.replaceWith(reconstructRelayFixtureState(directory, state.allOperations(), () => NOW + DAY, new Map()));
    const restarted = reconstructRelayFixtureState(directory, state.allOperations(), () => NOW + DAY, new Map());
    for (const candidate of [state, restarted]) {
      expect(candidate.activeOperations(NOW + DAY).map(operation => operation.publicationId)).toEqual([
        first.index.publicationId, second.index.publicationId,
      ]);
      const request = createLeasedIndexSearchRequestV1({
        groupId: 'public', itemType: 'offer', fingerprintEpoch: 'epoch-1', fingerprint: new Uint8Array(64),
        limit: 10, createdAt: NOW + DAY, expiresAt: NOW + DAY + 10_000,
      }, generateSigningKeyPair());
      expect(validateSearchResults({
        request,
        results: [firstRefresh, secondRefresh].map(serializeLeasedIndexOperationV1),
        state: candidate,
        now: NOW + DAY,
      })).toHaveLength(2);
      expect(() => validateSearchResults({
        request,
        results: [secondRefresh, firstRefresh].map(serializeLeasedIndexOperationV1),
        state: candidate,
        now: NOW + DAY,
      })).toThrow('search_top_generation_set_mismatch');
    }
  });
});
