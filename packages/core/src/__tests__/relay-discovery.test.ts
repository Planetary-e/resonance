import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import {
  MAX_RELAY_DESCRIPTOR_LIFETIME_MS,
  createRelayContactHintV1,
  createRelayDescriptorV1,
  createRelayPeerRequestFrameV1,
  createRelayPeerRequestV1,
  createRelayPeerResponseFrameV1,
  createRelayPeerResponseV1,
  isRelayDescriptorActiveV1,
  isRelayPeerRequestActiveV1,
  isRelayPeerResponseActiveV1,
  parseRelayPeerRequestFrameV1,
  parseRelayPeerResponseFrameV1,
  serializeRelayPeerRequestFrameV1,
  serializeRelayPeerResponseFrameV1,
  verifyRelayContactHintV1,
  verifyRelayDescriptorV1,
  verifyRelayPeerRequestV1,
  verifyRelayPeerResponseV1,
  type RelayDescriptorV1,
} from '../relay-discovery.js';

const NOW = 1_800_000_000_000;

function descriptor(
  endpoint: string,
  overrides: Partial<Parameters<typeof createRelayDescriptorV1>[0]> = {},
): RelayDescriptorV1 {
  return createRelayDescriptorV1({
    sequence: 4,
    endpoints: [endpoint],
    reachability: 'direct',
    capabilities: {
      storesPublications: true,
      storesMailboxes: true,
      answersQueries: true,
      forwardsQueries: true,
      replicaExchange: true,
    },
    supportedGroups: ['public', 'tools'],
    storage: { capacityBytes: 10_000_000, availableBytes: 7_500_000 },
    issuedAt: NOW,
    expiresAt: NOW + 3_600_000,
    ...overrides,
  }, generateIdentity());
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('relay descriptors', () => {
  it('binds canonical capabilities and endpoints to the relay infrastructure identity', () => {
    const identity = generateIdentity();
    const result = createRelayDescriptorV1({
      sequence: 2,
      endpoints: ['wss://relay.example.net/z', 'wss://relay.example.net/a'],
      reachability: 'direct',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: true,
      },
      supportedGroups: ['tools', 'public'],
      storage: { capacityBytes: 50_000, availableBytes: 40_000 },
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    }, identity);

    expect(result.relayId).toBe(identity.did);
    expect(result.endpoints).toEqual(['wss://relay.example.net/a', 'wss://relay.example.net/z']);
    expect(result.supportedGroups).toEqual(['public', 'tools']);
    expect(verifyRelayDescriptorV1(result)).toBe(true);
    expect(isRelayDescriptorActiveV1(result, NOW + 1)).toBe(true);
    expect(isRelayDescriptorActiveV1(result, result.expiresAt)).toBe(false);
  });

  it('rejects tampering, non-canonical lists, impossible storage, and overlong claims', () => {
    const valid = descriptor('wss://relay.example.net');
    const tampered = copy(valid);
    tampered.storage.availableBytes -= 1;
    expect(verifyRelayDescriptorV1(tampered)).toBe(false);

    const reordered = copy(valid);
    reordered.supportedGroups.reverse();
    expect(verifyRelayDescriptorV1(reordered)).toBe(false);

    expect(() => descriptor('wss://relay.example.net', {
      storage: { capacityBytes: 1, availableBytes: 2 },
    })).toThrow('Invalid relay descriptor input');
    expect(() => descriptor('wss://relay.example.net', {
      expiresAt: NOW + MAX_RELAY_DESCRIPTOR_LIFETIME_MS + 1,
    })).toThrow('Invalid relay descriptor input');
    expect(() => descriptor('wss://relay.example.net', {
      reachability: 'outbound-only',
    })).toThrow('Invalid relay descriptor input');
  });

  it('represents outbound-only volunteers without inventing a reachable endpoint', () => {
    const result = descriptor('wss://unused.example.net', {
      endpoints: [],
      reachability: 'outbound-only',
    });
    expect(verifyRelayDescriptorV1(result)).toBe(true);
    expect(result.endpoints).toEqual([]);
  });
});

describe('relay contact hints', () => {
  it('canonicalizes locations while keeping optional identity pinning explicit', () => {
    const identity = generateIdentity();
    const unpinned = createRelayContactHintV1('configured', 'ws://localhost:9090');
    const pinned = createRelayContactHintV1('invitation', 'wss://relay.example.net', identity.did);

    expect(unpinned).toEqual({ source: 'configured', endpoint: 'ws://localhost:9090/' });
    expect(pinned.expectedRelayId).toBe(identity.did);
    expect(verifyRelayContactHintV1(unpinned)).toBe(true);
    expect(verifyRelayContactHintV1(pinned)).toBe(true);
    expect(() => createRelayContactHintV1('configured', 'https://relay.example.net')).toThrow();
  });
});

describe('signed peer exchange', () => {
  it('uses a one-use request identity and enforces a short active window', () => {
    const request = createRelayPeerRequestV1({
      supportedGroups: ['tools', 'public'],
      maxPeers: 2,
      createdAt: NOW,
      expiresAt: NOW + 30_000,
    });
    expect(request.supportedGroups).toEqual(['public', 'tools']);
    expect(verifyRelayPeerRequestV1(request)).toBe(true);
    expect(isRelayPeerRequestActiveV1(request, NOW + 1)).toBe(true);
    expect(isRelayPeerRequestActiveV1(request, request.expiresAt)).toBe(false);

    const tampered = copy(request);
    tampered.maxPeers = 3;
    expect(verifyRelayPeerRequestV1(tampered)).toBe(false);
  });

  it('signs a bounded set of fresh, independently verifiable descriptors', () => {
    const request = createRelayPeerRequestV1({
      supportedGroups: ['public'], maxPeers: 2, createdAt: NOW, expiresAt: NOW + 30_000,
    });
    const first = descriptor('wss://z.example.net');
    const second = descriptor('wss://a.example.net');
    const response = createRelayPeerResponseV1(request, [first, second], generateIdentity(), NOW + 1);

    expect(response.descriptors.map(value => value.relayId))
      .toEqual([...response.descriptors.map(value => value.relayId)].sort());
    expect(verifyRelayPeerResponseV1(response, request)).toBe(true);
    expect(isRelayPeerResponseActiveV1(response, request, NOW + 2)).toBe(true);

    const tampered = copy(response);
    tampered.descriptors[0].storage.availableBytes -= 1;
    expect(verifyRelayPeerResponseV1(tampered, request)).toBe(false);
  });

  it('rejects duplicate, stale, and excessive peer advertisements', () => {
    const boundedRequest = createRelayPeerRequestV1({
      supportedGroups: [], maxPeers: 1, createdAt: NOW, expiresAt: NOW + 30_000,
    });
    const fresh = descriptor('wss://fresh.example.net');
    expect(() => createRelayPeerResponseV1(boundedRequest, [fresh, fresh], generateIdentity(), NOW + 1))
      .toThrow('requested peer limit');
    const duplicateRequest = createRelayPeerRequestV1({
      supportedGroups: [], maxPeers: 2, createdAt: NOW, expiresAt: NOW + 30_000,
    });
    expect(() => createRelayPeerResponseV1(duplicateRequest, [fresh, fresh], generateIdentity(), NOW + 1))
      .toThrow('invalid, stale, or duplicate');
    expect(() => createRelayPeerResponseV1(boundedRequest, [descriptor('wss://stale.example.net', {
      issuedAt: NOW - 60_000,
      expiresAt: NOW,
    })], generateIdentity(), NOW + 1)).toThrow('invalid, stale, or duplicate');
    const publicRequest = createRelayPeerRequestV1({
      supportedGroups: ['public'], maxPeers: 1, createdAt: NOW, expiresAt: NOW + 30_000,
    });
    expect(() => createRelayPeerResponseV1(publicRequest, [descriptor('wss://wrong-group.example.net', {
      supportedGroups: ['another-community'],
    })], generateIdentity(), NOW + 1)).toThrow('invalid, stale, or duplicate');
  });

  it('returns false rather than throwing for hostile descriptor arrays', () => {
    const request = createRelayPeerRequestV1({
      supportedGroups: [], maxPeers: 1, createdAt: NOW, expiresAt: NOW + 30_000,
    });
    const response = createRelayPeerResponseV1(
      request, [descriptor('wss://relay.example.net')], generateIdentity(), NOW + 1,
    );
    const malformed = copy(response) as unknown as { descriptors: unknown[] };
    malformed.descriptors = [null];

    expect(() => verifyRelayPeerResponseV1(malformed, request)).not.toThrow();
    expect(verifyRelayPeerResponseV1(malformed, request)).toBe(false);
  });

  it('round-trips strict request and response frames', () => {
    const request = createRelayPeerRequestV1({
      supportedGroups: ['public'], maxPeers: 1, createdAt: NOW, expiresAt: NOW + 30_000,
    });
    const response = createRelayPeerResponseV1(
      request, [descriptor('wss://relay.example.net')], generateIdentity(), NOW + 1,
    );
    const requestFrame = createRelayPeerRequestFrameV1(request);
    const responseFrame = createRelayPeerResponseFrameV1(response);

    expect(parseRelayPeerRequestFrameV1(serializeRelayPeerRequestFrameV1(requestFrame))).toEqual(requestFrame);
    expect(parseRelayPeerResponseFrameV1(serializeRelayPeerResponseFrameV1(responseFrame))).toEqual(responseFrame);
    expect(() => parseRelayPeerRequestFrameV1(JSON.stringify({ ...requestFrame, extra: true }))).toThrow();
    expect(() => parseRelayPeerResponseFrameV1(JSON.stringify({ ...responseFrame, extra: true }))).toThrow();
  });
});
