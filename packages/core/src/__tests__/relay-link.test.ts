import { describe, expect, it } from 'vitest';
import { generateIdentity, type Identity } from '../crypto.js';
import { createRelayDescriptorV1 } from '../relay-discovery.js';
import {
  createRelayLinkAcceptFrameV1,
  createRelayLinkAcceptV1,
  createRelayLinkOpenFrameV1,
  createRelayLinkOpenV1,
  isRelayLinkAcceptActiveV1,
  isRelayLinkOpenActiveV1,
  parseRelayLinkAcceptFrameV1,
  parseRelayLinkOpenFrameV1,
  serializeRelayLinkAcceptFrameV1,
  serializeRelayLinkOpenFrameV1,
  verifyRelayLinkAcceptV1,
  verifyRelayLinkOpenV1,
} from '../relay-link.js';

const NOW = 1_800_000_000_000;

function descriptor(identity: Identity, direct: boolean) {
  return createRelayDescriptorV1({
    sequence: 1,
    endpoints: direct ? ['wss://relay.example.net/'] : [],
    reachability: direct ? 'direct' : 'outbound-only',
    capabilities: {
      storesPublications: true,
      storesMailboxes: true,
      answersQueries: true,
      forwardsQueries: false,
      replicaExchange: false,
    },
    supportedGroups: ['public'],
    storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
  }, identity);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('relay link handshake', () => {
  it('mutually authenticates an outbound-only initiator and direct responder', () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const request = createRelayLinkOpenV1(descriptor(initiator, false), initiator, NOW, NOW + 30_000);
    const acceptance = createRelayLinkAcceptV1(
      request,
      descriptor(responder, true),
      responder,
      NOW + 1,
    );

    expect(verifyRelayLinkOpenV1(request)).toBe(true);
    expect(isRelayLinkOpenActiveV1(request, NOW + 1)).toBe(true);
    expect(verifyRelayLinkAcceptV1(acceptance, request)).toBe(true);
    expect(isRelayLinkAcceptActiveV1(acceptance, request, NOW + 2)).toBe(true);
    expect(acceptance.initiatorRelayId).toBe(initiator.did);
    expect(acceptance.responderDescriptor.relayId).toBe(responder.did);
  });

  it('rejects tampering, mismatched requests, and expired handshakes', () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const request = createRelayLinkOpenV1(descriptor(initiator, false), initiator, NOW, NOW + 30_000);
    const acceptance = createRelayLinkAcceptV1(request, descriptor(responder, true), responder, NOW + 1);

    const tampered = copy(request);
    tampered.descriptor.storage.availableBytes -= 1;
    expect(verifyRelayLinkOpenV1(tampered)).toBe(false);
    expect(isRelayLinkOpenActiveV1(request, request.expiresAt)).toBe(false);

    const otherIdentity = generateIdentity();
    const otherRequest = createRelayLinkOpenV1(
      descriptor(otherIdentity, false),
      otherIdentity,
      NOW,
      NOW + 30_000,
    );
    expect(verifyRelayLinkAcceptV1(acceptance, otherRequest)).toBe(false);
  });

  it('round-trips strict open and acceptance frames', () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const request = createRelayLinkOpenV1(descriptor(initiator, false), initiator, NOW, NOW + 30_000);
    const acceptance = createRelayLinkAcceptV1(request, descriptor(responder, true), responder, NOW + 1);
    const openFrame = createRelayLinkOpenFrameV1(request);
    const acceptFrame = createRelayLinkAcceptFrameV1(acceptance);

    expect(parseRelayLinkOpenFrameV1(serializeRelayLinkOpenFrameV1(openFrame))).toEqual(openFrame);
    expect(parseRelayLinkAcceptFrameV1(serializeRelayLinkAcceptFrameV1(acceptFrame))).toEqual(acceptFrame);
    expect(() => parseRelayLinkOpenFrameV1(JSON.stringify({ ...openFrame, extra: true }))).toThrow();
    expect(() => parseRelayLinkAcceptFrameV1(JSON.stringify({ ...acceptFrame, extra: true }))).toThrow();
  });
});
