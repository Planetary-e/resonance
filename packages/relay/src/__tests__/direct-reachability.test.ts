import { describe, expect, it } from 'vitest';
import { createRelayDescriptorV1, generateIdentity } from '@resonance/core';
import { DirectReachabilityObservations } from '../direct-reachability.js';

const NOW = 1_800_000_000_000;
const identity = generateIdentity();
const descriptor = createRelayDescriptorV1({
  sequence: 1,
  endpoints: ['wss://relay.example.net/'],
  reachability: 'direct',
  capabilities: {
    storesPublications: true, storesMailboxes: true, answersQueries: true,
    forwardsQueries: true, replicaExchange: true,
  },
  supportedGroups: ['public'],
  storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
}, identity);

describe('direct endpoint peer observations', () => {
  it('requires two recent authenticated peers from distinct public networks', () => {
    const observations = new DirectReachabilityObservations();
    expect(observations.observe(descriptor, 'peer-1', descriptor.endpoints[0], '8.8.8.8', NOW))
      .toBe(true);
    expect(observations.confirmedEndpointCount(descriptor, NOW)).toBe(0);
    expect(observations.observe(descriptor, 'peer-2', descriptor.endpoints[0], '8.8.8.9', NOW))
      .toBe(true);
    expect(observations.confirmedEndpointCount(descriptor, NOW)).toBe(0);
    expect(observations.observe(descriptor, 'peer-3', descriptor.endpoints[0], '1.1.1.1', NOW))
      .toBe(true);
    expect(observations.confirmedEndpointCount(descriptor, NOW)).toBe(1);
    expect(observations.confirmedEndpointCount(descriptor, NOW + 5 * 60_000)).toBe(0);
  });

  it('ignores loopback, private, documentation, and unadvertised endpoints', () => {
    const observations = new DirectReachabilityObservations();
    for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '192.168.1.1',
      '203.0.113.1', '2001:db8::1']) {
      expect(observations.observe(descriptor, address, descriptor.endpoints[0], address, NOW))
        .toBe(false);
    }
    expect(observations.observe(descriptor, 'peer-1', 'wss://other.example.net/', '8.8.8.8', NOW))
      .toBe(false);
    expect(observations.confirmedEndpointCount(descriptor, NOW)).toBe(0);
  });

  it('does not count one identity switching source networks as two peers', () => {
    const observations = new DirectReachabilityObservations();
    expect(observations.observe(descriptor, 'peer-1', descriptor.endpoints[0], '8.8.8.8', NOW))
      .toBe(true);
    expect(observations.observe(descriptor, 'peer-1', descriptor.endpoints[0], '1.1.1.1', NOW + 1))
      .toBe(true);
    expect(observations.confirmedEndpointCount(descriptor, NOW + 1)).toBe(0);
  });

  it('does not treat a loopback URL as an Internet endpoint', () => {
    const loopback = createRelayDescriptorV1({
      sequence: 2,
      endpoints: ['ws://127.0.0.1/'],
      reachability: 'direct',
      capabilities: descriptor.capabilities,
      supportedGroups: descriptor.supportedGroups,
      storage: descriptor.storage,
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    }, identity);
    const observations = new DirectReachabilityObservations();
    expect(observations.observe(loopback, 'peer-1', loopback.endpoints[0], '8.8.8.8', NOW))
      .toBe(false);
  });
});
