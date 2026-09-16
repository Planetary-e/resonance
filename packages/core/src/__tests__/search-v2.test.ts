import { describe, expect, it } from 'vitest';
import {
  createSearchRequestFrameV2,
  createSearchRequestV2,
  createSearchResponsePayloadV2,
  generateSearchKeyMaterialV2,
  isSearchRequestActiveV2,
  parseSearchRequestFrameV2,
  serializeSearchRequestFrameV2,
  verifySearchRequestV2,
  verifySearchResponsePayloadV2,
} from '../index.js';

const NOW = 1_800_000_000_000;
const ADMISSION = {
  version: 2 as const,
  kind: 'admission-capability' as const,
  scheme: 'test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

function request() {
  return createSearchRequestV2({
    groupId: 'community:barcelona',
    fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0x5a),
    itemType: 'need',
    k: 10,
    threshold: 0.7,
    createdAt: NOW,
    expiresAt: NOW + 30_000,
  });
}

describe('protocol v2 one-use search', () => {
  it('generates independent identities for otherwise identical requests', () => {
    const first = request();
    const second = request();

    expect(first.searchId).not.toBe(second.searchId);
    expect(first.searchKey).not.toBe(second.searchKey);
    expect(verifySearchRequestV2(first)).toBe(true);
    expect(verifySearchRequestV2(second)).toBe(true);
    expect(first).not.toHaveProperty('did');
  });

  it('round-trips a strict signed frame without a root DID', () => {
    const search = request();
    const serialized = serializeSearchRequestFrameV2(createSearchRequestFrameV2(search, ADMISSION));

    expect(parseSearchRequestFrameV2(serialized).request).toEqual(search);
    expect(parseSearchRequestFrameV2(serialized).admission).toEqual(ADMISSION);
    expect(serialized).not.toContain('did:key:');
    expect(serialized).not.toContain('owner');
    expect(isSearchRequestActiveV2(search, NOW + 1)).toBe(true);
    expect(isSearchRequestActiveV2(search, NOW + 30_000)).toBe(false);
  });

  it('rejects tampering and key reuse under another identifier', () => {
    const search = request();
    expect(verifySearchRequestV2({ ...search, threshold: 0.1 })).toBe(false);
    expect(verifySearchRequestV2({
      ...search,
      searchId: generateSearchKeyMaterialV2().searchId,
    })).toBe(false);
  });

  it('validates bounded relay responses', () => {
    const search = request();
    const publicationId = `pub_${'A'.repeat(43)}`;
    const response = createSearchResponsePayloadV2(search.searchId, [{
      publicationId,
      similarity: 0.81,
      itemType: 'offer',
    }], NOW + 1);

    expect(verifySearchResponsePayloadV2(response)).toBe(true);
    expect(verifySearchResponsePayloadV2({
      ...response,
      results: [...response.results, response.results[0]],
    })).toBe(false);
  });
});
