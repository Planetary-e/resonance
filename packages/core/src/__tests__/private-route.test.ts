import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import { createRelayDescriptorV1 } from '../relay-discovery.js';
import { selectPrivateRouteV1, type PrivateRouteCandidateV1 } from '../private-route.js';

const NOW = 1_800_000_000_000;

function candidate(
  name: string, remoteAddress: string, overrides: { reachability?: 'direct' | 'outbound-only';
    issuedAt?: number; expiresAt?: number; endpoint?: string } = {},
): PrivateRouteCandidateV1 {
  const identity = generateIdentity();
  const endpoint = overrides.endpoint ?? `wss://${name}.example.net/`;
  return {
    descriptor: createRelayDescriptorV1({
      sequence: 1,
      endpoints: overrides.reachability === 'outbound-only' ? [] : [endpoint],
      reachability: overrides.reachability ?? 'direct',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: true,
        replicaExchange: true,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: overrides.issuedAt ?? NOW,
      expiresAt: overrides.expiresAt ?? NOW + 60_000,
    }, identity),
    endpoint,
    remoteAddress,
  };
}

describe('private route selection', () => {
  it('selects two distinct authenticated relays in different observed network domains', () => {
    const first = candidate('first', '203.0.113.10');
    const second = candidate('second', '198.51.100.20');
    const third = candidate('third', '192.0.2.30');
    for (let attempt = 0; attempt < 32; attempt++) {
      const route = selectPrivateRouteV1([first, second, third], NOW + 1);
      expect(route.entry.descriptor.relayId).not.toBe(route.destination.descriptor.relayId);
      expect(route.entry.remoteAddress.split('.').slice(0, 3))
        .not.toEqual(route.destination.remoteAddress.split('.').slice(0, 3));
    }
  });

  it('fails closed if it only sees one relay identity or one observed network', () => {
    const first = candidate('first', '203.0.113.10');
    const second = candidate('second', '203.0.113.20');
    expect(() => selectPrivateRouteV1([first], NOW + 1)).toThrow('No independent');
    expect(() => selectPrivateRouteV1([first, first], NOW + 1)).toThrow('No independent');
    expect(() => selectPrivateRouteV1([first, second], NOW + 1)).toThrow('No independent');
    expect(() => selectPrivateRouteV1([], NOW + 1)).toThrow('No independent');
  });

  it('discards stale, outbound-only, unsigned, and unobserved candidates', () => {
    const first = candidate('first', '203.0.113.10');
    const second = candidate('second', '198.51.100.20');
    const stale = candidate('stale', '192.0.2.10', { expiresAt: NOW + 1 });
    const outbound = candidate('outbound', '192.0.2.11', { reachability: 'outbound-only' });
    const forged = candidate('forged', '192.0.2.12');
    forged.descriptor.storage.availableBytes = 1;
    const unobserved = candidate('unobserved', 'not-an-ip');
    for (const invalid of [stale, outbound, forged, unobserved]) {
      expect(() => selectPrivateRouteV1([first, invalid], NOW + 2)).toThrow('No independent');
    }
    const route = selectPrivateRouteV1(
      [first, stale, outbound, forged, unobserved, second], NOW + 2,
    );
    expect(new Set([route.entry.descriptor.relayId, route.destination.descriptor.relayId]))
      .toEqual(new Set([first.descriptor.relayId, second.descriptor.relayId]));
  });

  it('requires the authenticated endpoint to be signed and secure', () => {
    const first = candidate('first', '203.0.113.10');
    const second = candidate('second', '198.51.100.20');
    expect(() => selectPrivateRouteV1([
      first, { ...second, endpoint: 'wss://other.example.net/' },
    ], NOW + 1)).toThrow('No independent');
    const insecure = candidate('insecure', '198.51.100.20', {
      endpoint: 'ws://192.0.2.20/',
    });
    expect(() => selectPrivateRouteV1([first, insecure], NOW + 1)).toThrow('No independent');
  });

  it('treats IPv4-mapped addresses and IPv6 prefixes as shared domains', () => {
    const first = candidate('first', '203.0.113.10');
    const mapped = candidate('mapped', '::ffff:203.0.113.20');
    expect(() => selectPrivateRouteV1([first, mapped], NOW + 1)).toThrow('No independent');

    const ipv6First = candidate('ipv6-first', '2001:db8:1::1');
    const ipv6Second = candidate('ipv6-second', '2001:db8:1::2');
    expect(() => selectPrivateRouteV1([ipv6First, ipv6Second], NOW + 1))
      .toThrow('No independent');
  });
});
