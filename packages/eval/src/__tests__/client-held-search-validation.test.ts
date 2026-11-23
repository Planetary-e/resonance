import { describe, expect, it } from 'vitest';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexSearchRequestV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateSigningKeyPair,
  serializeLeasedIndexOperationV1,
} from '@resonance/core';
import {
  ActiveFixtureState,
  advanceFixtureOnAcknowledgment,
  validateSearchResults,
} from '../client-held-search-validation.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function fixture(
  fill: number,
  sequence = 0,
  itemType: 'need' | 'offer' = 'need',
  scope: { groupId?: string; fingerprintEpoch?: string } = {},
) {
  const keys = generateLeasedIndexKeyMaterialV1();
  const index = createLeasedIndexV1({
    leaseSequence: sequence,
    groupId: scope.groupId ?? 'public',
    itemType,
    derivationId: 'search-validator-control-v1',
    fingerprintEpoch: scope.fingerprintEpoch ?? 'epoch-1',
    fingerprint: new Uint8Array(64).fill(fill),
    originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, keys);
  return { keys, index };
}

function nextGeneration(value: ReturnType<typeof fixture>, leaseSequence: number) {
  const index = createLeasedIndexV1({
    leaseSequence,
    groupId: value.index.groupId,
    itemType: value.index.itemType,
    derivationId: value.index.derivationId,
    fingerprintEpoch: value.index.fingerprint.epoch,
    fingerprint: new Uint8Array(64),
    originalCommitment: value.index.original.commitment,
    createdAt: NOW + leaseSequence,
    expiresAt: value.index.expiresAt,
  }, value.keys);
  return { ...value, index };
}

function request(fill = 0, limit = 10) {
  return createLeasedIndexSearchRequestV1({
    groupId: 'public',
    itemType: 'offer',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(fill),
    limit,
    createdAt: NOW,
    expiresAt: NOW + 10_000,
  }, generateSigningKeyPair());
}

function validate(state: ActiveFixtureState, values: Parameters<typeof serializeLeasedIndexOperationV1>[0][],
  expected?: { publicationId: string; generationId: string }, limit = 10) {
  return validateSearchResults({
    request: request(0, limit),
    results: values.map(serializeLeasedIndexOperationV1),
    state,
    ...(expected ?? {}),
    now: NOW + 1_000,
  });
}

describe('client-held harness search validator', () => {
  it('accepts the independently computed complete top-10 and rejects truncation or a false positive', () => {
    const fixtures = Array.from({ length: 12 }, () => fixture(0));
    const state = new ActiveFixtureState(fixtures.map(value => value.index));
    const expected = fixtures[0];
    const expectedIdentity = {
      publicationId: expected.index.publicationId,
      generationId: createLeasedIndexGenerationIdV1(expected.index),
    };
    expect(validate(state, fixtures.slice(0, 10).map(value => value.index), expectedIdentity)).toHaveLength(10);
    expect(() => validate(state, fixtures.slice(0, 9).map(value => value.index), expectedIdentity))
      .toThrow('search_top_generation_set_mismatch');
    expect(() => validate(state, fixtures.slice(0, 11).map(value => value.index), expectedIdentity))
      .toThrow('search_result_count');
  });

  it('requires distinct publication and generation identities and the expected exact match', () => {
    const first = fixture(0);
    const second = fixture(0);
    const state = new ActiveFixtureState([first.index, second.index]);
    const expected = {
      publicationId: first.index.publicationId,
      generationId: createLeasedIndexGenerationIdV1(first.index),
    };
    expect(() => validate(state, [first.index, first.index], expected)).toThrow('search_duplicate_publication');
    expect(() => validate(state, [second.index], expected)).toThrow();
    expect(validate(state, [first.index, second.index], expected)).toHaveLength(2);
  });

  it('rejects signed conflicted, withdrawn, expired, wrong-type, and invalid-signature results', () => {
    const conflicted = fixture(0);
    const withdrawn = fixture(0);
    const expired = fixture(0);
    const wrongType = fixture(0, 0, 'offer');
    const state = new ActiveFixtureState([conflicted.index, withdrawn.index, expired.index, wrongType.index]);
    state.mark(conflicted.index.publicationId, 'conflict');
    state.mark(withdrawn.index.publicationId, 'withdrawn');
    for (const value of [conflicted, withdrawn, wrongType]) {
      expect(() => validate(state, [value.index])).toThrow();
    }
    expect(() => validate(state, [expired.index], undefined, 10)).not.toThrow();
    expect(() => validateSearchResults({
      request: request(), results: [serializeLeasedIndexOperationV1(expired.index)], state,
      now: expired.index.expiresAt,
    })).toThrow();
    const other = fixture(0);
    expect(() => validate(state, [{ ...expired.index, signature: other.index.signature }])).toThrow();
  });

  it('orders by similarity and rejects actual below-threshold and out-of-scope candidates', () => {
    const exact = fixture(0);
    const near = fixture(1);
    const belowThreshold = fixture(255);
    const outOfScope = fixture(0, 0, 'need', { groupId: 'private', fingerprintEpoch: 'epoch-2' });
    const state = new ActiveFixtureState([
      exact.index, near.index, belowThreshold.index, outOfScope.index,
    ]);
    expect(validate(state, [exact.index, near.index])).toHaveLength(2);
    expect(() => validate(state, [near.index, exact.index])).toThrow('search_top_generation_set_mismatch');
    expect(() => validate(state, [exact.index, belowThreshold.index])).toThrow('search_top_generation_set_mismatch');
    expect(() => validate(state, [exact.index, outOfScope.index])).toThrow();
  });

  it('does not regress oracle generation on duplicate, stale, or uncertain acknowledgments', () => {
    const initial = fixture(0);
    const refreshed = nextGeneration(initial, 1);
    const uncertain = nextGeneration(initial, 2);
    const state = new ActiveFixtureState([initial.index]);
    expect(advanceFixtureOnAcknowledgment(state, refreshed.index, { outcome: 'ok', reason: 'accepted' })).toBe(true);
    expect(advanceFixtureOnAcknowledgment(state, initial.index, { outcome: 'ok', reason: 'duplicate' })).toBe(true);
    expect(advanceFixtureOnAcknowledgment(state, uncertain.index, { outcome: 'error', reason: 'timeout' })).toBe(false);
    expect(state.currentGenerationId(refreshed.index.publicationId)).not.toBe(
      createLeasedIndexGenerationIdV1(initial.index),
    );
    expect(state.currentGenerationId(refreshed.index.publicationId)).toBe(
      createLeasedIndexGenerationIdV1(refreshed.index),
    );
  });

  it('allows an empty result within the protocol range when no fixture match is required', () => {
    const state = new ActiveFixtureState();
    expect(validate(state, [])).toEqual([]);
  });
});
