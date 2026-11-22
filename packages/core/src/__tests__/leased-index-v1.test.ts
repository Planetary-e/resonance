import { describe, expect, it } from 'vitest';
import {
  LEASED_INDEX_KIND,
  MAX_LEASED_INDEX_BYTES,
  MAX_LEASE_DURATION_MS,
  MAX_ORIGINAL_BYTES,
  LeasedIndexReplayV1,
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  isLeasedIndexActiveV1,
  parseLeasedIndexV1,
  serializeLeasedIndexV1,
  verifyLeasedIndexV1,
  verifyOriginalCommitmentV1,
  type CreateLeasedIndexInputV1,
  type LeasedIndexKeyMaterialV1,
} from '../leased-index-v1.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const keys = generateLeasedIndexKeyMaterialV1();
  const original = new TextEncoder().encode('exact original bytes');
  const commitmentKey = generateOriginalCommitmentKeyV1();
  const originalCommitment = createOriginalCommitmentV1(original, commitmentKey);
  return { keys, original, commitmentKey, originalCommitment };
}

function createIndex(
  keys: LeasedIndexKeyMaterialV1,
  originalCommitment: string,
  overrides: Partial<CreateLeasedIndexInputV1> = {},
) {
  return createLeasedIndexV1({
    groupId: 'community:test',
    itemType: 'offer',
    derivationId: 'fixed-derivation-fixture-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(7),
    originalCommitment,
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
    ...overrides,
  }, keys);
}

describe('leased index commitments', () => {
  it('creates and verifies the exact original with a private random key', () => {
    const { original, commitmentKey, originalCommitment } = fixture();

    expect(commitmentKey).toHaveLength(32);
    expect(verifyOriginalCommitmentV1(original, commitmentKey, originalCommitment)).toBe(true);
    expect(verifyOriginalCommitmentV1(Uint8Array.from(original), commitmentKey, originalCommitment)).toBe(true);
  });

  it('rejects wrong bytes, keys, commitments and oversized originals', () => {
    const { original, commitmentKey, originalCommitment } = fixture();
    const changed = Uint8Array.from(original);
    changed[0] ^= 1;

    expect(verifyOriginalCommitmentV1(changed, commitmentKey, originalCommitment)).toBe(false);
    expect(verifyOriginalCommitmentV1(original, generateOriginalCommitmentKeyV1(), originalCommitment)).toBe(false);
    expect(verifyOriginalCommitmentV1(original, new Uint8Array(31), originalCommitment)).toBe(false);
    expect(verifyOriginalCommitmentV1(original, commitmentKey, 'not-base64')).toBe(false);
    expect(() => createOriginalCommitmentV1(new Uint8Array(MAX_ORIGINAL_BYTES + 1), commitmentKey))
      .toThrow('Invalid original commitment input');
    expect(() => createOriginalCommitmentV1(new Uint8Array(MAX_ORIGINAL_BYTES), commitmentKey)).not.toThrow();
  });
});

describe('leased index schema and signatures', () => {
  it('round-trips a canonical signed index with independent counters and generation identity', () => {
    const { keys, originalCommitment } = fixture();
    const index = createIndex(keys, originalCommitment, { leaseSequence: 3, semanticRevision: 2 });

    expect(index.kind).toBe(LEASED_INDEX_KIND);
    expect(index.fingerprint.bits).toBe(512);
    expect(verifyLeasedIndexV1(index)).toBe(true);
    expect(parseLeasedIndexV1(serializeLeasedIndexV1(index))).toEqual(index);
    expect(createLeasedIndexGenerationIdV1(index)).toMatch(/^gen_[A-Za-z0-9_-]{43}$/);

    const refreshed = createIndex(keys, originalCommitment, { leaseSequence: 4, semanticRevision: 2 });
    const revised = createIndex(keys, originalCommitment, { leaseSequence: 4, semanticRevision: 3 });
    expect(createLeasedIndexGenerationIdV1(refreshed)).not.toBe(createLeasedIndexGenerationIdV1(index));
    expect(createLeasedIndexGenerationIdV1(revised)).not.toBe(createLeasedIndexGenerationIdV1(refreshed));
  });

  it('keeps private source and derivation material out of the signed public record', () => {
    const { keys, originalCommitment } = fixture();
    const serialized = serializeLeasedIndexV1(createIndex(keys, originalCommitment));

    for (const field of ['originalBytes', 'commitmentKey', 'summary', 'intent', 'embedding', 'trueEmbedding']) {
      expect(serialized).not.toContain(field);
    }
  });

  it('rejects unknown fields, private-field additions and signed-data tampering', () => {
    const { keys, originalCommitment } = fixture();
    const index = createIndex(keys, originalCommitment);

    expect(verifyLeasedIndexV1({ ...index, summary: 'private' })).toBe(false);
    expect(verifyLeasedIndexV1({ ...index, expiresAt: index.expiresAt - 1 })).toBe(false);
    expect(verifyLeasedIndexV1({ ...index, original: { ...index.original, commitmentKey: 'secret' } })).toBe(false);
    expect(verifyLeasedIndexV1({ ...index, fingerprint: { ...index.fingerprint, bits: 256 } })).toBe(false);
    expect(() => parseLeasedIndexV1(JSON.stringify({ ...index, extra: true }))).toThrow('Invalid leased index');
  });

  it('rejects a wrong signing key and noncanonical encodings', () => {
    const { keys, originalCommitment } = fixture();
    const index = createIndex(keys, originalCommitment);
    const wrongPublication = createIndex(generateLeasedIndexKeyMaterialV1(), originalCommitment);

    expect(verifyLeasedIndexV1({ ...index, signature: wrongPublication.signature })).toBe(false);
    expect(verifyLeasedIndexV1({ ...index, publicationKey: wrongPublication.publicationKey })).toBe(false);
    expect(() => createIndex(keys, 'not-a-commitment')).toThrow('Invalid leased index input');
  });

  it('enforces lease duration, expiry and serialized-size boundaries separately from signatures', () => {
    const { keys, originalCommitment } = fixture();
    const index = createIndex(keys, originalCommitment);

    expect(isLeasedIndexActiveV1(index, NOW - 1)).toBe(false);
    expect(isLeasedIndexActiveV1(index, NOW)).toBe(true);
    expect(isLeasedIndexActiveV1(index, index.expiresAt - 1)).toBe(true);
    expect(isLeasedIndexActiveV1(index, index.expiresAt)).toBe(false);
    expect(verifyLeasedIndexV1(index)).toBe(true);
    expect(() => createIndex(keys, originalCommitment, { expiresAt: NOW })).toThrow('Invalid leased index input');
    expect(() => createIndex(keys, originalCommitment, { expiresAt: NOW + MAX_LEASE_DURATION_MS + 1 }))
      .toThrow('Invalid leased index input');
    expect(() => parseLeasedIndexV1(' '.repeat(MAX_LEASED_INDEX_BYTES + 1))).toThrow('Invalid leased index');
  });
});

describe('leased index exact replay and conflicts', () => {
  it('returns exact duplicates without growth and rejects stale writes', () => {
    const { keys, originalCommitment } = fixture();
    const replay = new LeasedIndexReplayV1();
    const initial = createIndex(keys, originalCommitment);
    const refreshed = createIndex(keys, originalCommitment, { leaseSequence: 1 });
    const initialBytes = serializeLeasedIndexV1(initial);
    const refreshedBytes = serializeLeasedIndexV1(refreshed);

    expect(replay.submit(refreshedBytes, NOW).status).toBe('accepted');
    const size = replay.sizeBytes;
    expect(replay.submit(refreshedBytes, refreshed.expiresAt).status).toBe('duplicate');
    expect(replay.sizeBytes).toBe(size);
    expect(replay.submit(initialBytes, NOW).status).toBe('stale');
    expect(replay.sizeBytes).toBe(size);
  });

  it('retains one full-byte conflict and never resolves it by arrival order', () => {
    const { keys, originalCommitment } = fixture();
    const replay = new LeasedIndexReplayV1();
    const index = createIndex(keys, originalCommitment);
    const canonical = serializeLeasedIndexV1(index);
    const alternateEncoding = JSON.stringify(index);
    const third = serializeLeasedIndexV1(createIndex(keys, originalCommitment, { expiresAt: NOW + 6 * DAY }));

    expect(alternateEncoding).not.toBe(canonical);
    expect(replay.submit(canonical, NOW).status).toBe('accepted');
    const firstSize = replay.sizeBytes;
    const conflict = replay.submit(alternateEncoding, NOW);
    expect(conflict.status).toBe('conflict');
    expect(conflict.conflictBytes).toEqual(new TextEncoder().encode(alternateEncoding));
    expect(replay.sizeBytes).toBe(firstSize + new TextEncoder().encode(alternateEncoding).byteLength);
    const retainedSize = replay.sizeBytes;

    const repeated = replay.submit(alternateEncoding, NOW);
    expect(repeated.status).toBe('conflict');
    expect(repeated.conflictBytes).toEqual(conflict.conflictBytes);
    expect(replay.sizeBytes).toBe(retainedSize);
    const further = replay.submit(third, NOW);
    expect(further.status).toBe('conflict');
    expect(further.conflictBytes).toEqual(conflict.conflictBytes);
    expect(replay.sizeBytes).toBe(retainedSize);

    const next = serializeLeasedIndexV1(createIndex(keys, originalCommitment, { leaseSequence: 1 }));
    expect(replay.submit(next, NOW).status).toBe('accepted');
    const afterHigher = replay.sizeBytes;
    expect(replay.submit(alternateEncoding, index.expiresAt).status).toBe('conflict');
    expect(replay.sizeBytes).toBe(afterHigher);
  });

  it('verifies signatures before mutation and refuses expired new operations', () => {
    const { keys, originalCommitment } = fixture();
    const replay = new LeasedIndexReplayV1();
    const index = createIndex(keys, originalCommitment);
    const tampered = { ...index, semanticRevision: 1 };

    expect(() => replay.submit(JSON.stringify(tampered), NOW)).toThrow('Invalid leased index');
    expect(replay.sizeBytes).toBe(0);
    expect(replay.submit(serializeLeasedIndexV1(index), index.expiresAt).status).toBe('expired');
    expect(replay.sizeBytes).toBe(0);
  });
});
