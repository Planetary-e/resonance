import { describe, expect, it } from 'vitest';
import {
  createRelayQueryRequestFrameV1,
  createRelayQueryRequestV1,
  createRelayQueryResponseFrameV1,
  createRelayQueryResponseV1,
  createSearchRequestV2,
  generateIdentity,
  isRelayQueryRequestActiveV1,
  parseRelayQueryRequestFrameV1,
  parseRelayQueryResponseFrameV1,
  serializeRelayQueryRequestFrameV1,
  serializeRelayQueryResponseFrameV1,
  verifyRelayQueryRequestV1,
  verifyRelayQueryResponseV1,
} from '../index.js';

const NOW = 1_800_000_000_000;

function fixture() {
  const sender = generateIdentity();
  const target = generateIdentity();
  const search = createSearchRequestV2({
    groupId: 'public', fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0xa5), itemType: 'need',
    k: 5, threshold: 0.7, createdAt: NOW, expiresAt: NOW + 30_000,
  });
  const request = createRelayQueryRequestV1(
    search, target.did, sender, 1, undefined, NOW + 1, NOW + 3_001,
  );
  return { sender, target, search, request };
}

describe('signed relay query frames', () => {
  it('binds a one-use search, recipient, hop budget, and reply to the authenticated relays', () => {
    const { sender, target, request } = fixture();
    const frame = serializeRelayQueryRequestFrameV1(createRelayQueryRequestFrameV1(request));
    expect(parseRelayQueryRequestFrameV1(frame).request).toEqual(request);
    expect(isRelayQueryRequestActiveV1(request, NOW + 2)).toBe(true);
    expect(isRelayQueryRequestActiveV1(request, NOW + 3_001)).toBe(false);
    const response = createRelayQueryResponseV1(request, target, 'ok', [], NOW + 2);
    expect(parseRelayQueryResponseFrameV1(
      serializeRelayQueryResponseFrameV1(createRelayQueryResponseFrameV1(response)),
    ).response).toEqual(response);
    expect(verifyRelayQueryResponseV1(response, request)).toBe(true);
    expect(response.targetRelayId).toBe(sender.did);
  });

  it('rejects changed hops, target, search, and an unbound response', () => {
    const { sender, target, request } = fixture();
    expect(verifyRelayQueryRequestV1({ ...request, remainingHops: 0 })).toBe(false);
    expect(verifyRelayQueryRequestV1({ ...request, targetRelayId: sender.did })).toBe(false);
    expect(verifyRelayQueryRequestV1({ ...request, search: { ...request.search, k: 1 } })).toBe(false);
    expect(() => createRelayQueryRequestV1(request.search, target.did, sender, 2, undefined, NOW + 1))
      .toThrow('Invalid relay query request input');
    const response = createRelayQueryResponseV1(request, target, 'ok', [], NOW + 2);
    expect(verifyRelayQueryResponseV1({ ...response, requestSignature: request.search.signature }, request))
      .toBe(false);
    expect(verifyRelayQueryResponseV1({ ...response, senderRelayId: sender.did }, request)).toBe(false);
  });
});
