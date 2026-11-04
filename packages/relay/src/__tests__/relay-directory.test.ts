import { describe, expect, it } from 'vitest';
import {
  createRelayDescriptorV1,
  generateIdentity,
  type Identity,
  type RelayDescriptorV1,
} from '@resonance/core';
import { RelayDirectory } from '../relay-directory.js';

const NOW = 1_800_000_000_000;

function descriptor(
  sequence: number,
  groups = ['public'],
  issuedAt = NOW,
  lifetimeMs = 60_000,
  identity: Identity = generateIdentity(),
): RelayDescriptorV1 {
  return createRelayDescriptorV1({
    sequence,
    endpoints: [`wss://relay-${sequence}.example.net`],
    reachability: 'direct',
    capabilities: {
      storesPublications: true,
      storesMailboxes: true,
      answersQueries: true,
      forwardsQueries: false,
      replicaExchange: false,
    },
    supportedGroups: groups,
    storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
    issuedAt,
    expiresAt: issuedAt + lifetimeMs,
  }, identity);
}

describe('RelayDirectory', () => {
  it('accepts fresh descriptors and replaces only higher sequences', () => {
    const directory = new RelayDirectory(4);
    const identity = generateIdentity();
    const first = descriptor(1, ['public'], NOW, 60_000, identity);
    const updated = descriptor(2, ['public'], NOW + 1, 60_000, identity);
    const older = descriptor(0, ['public'], NOW + 2, 60_000, identity);
    const equivocation = createRelayDescriptorV1({
      sequence: 2,
      endpoints: ['wss://equivocation.example.net'],
      reachability: 'direct',
      capabilities: updated.capabilities,
      supportedGroups: updated.supportedGroups,
      storage: updated.storage,
      issuedAt: NOW + 1,
      expiresAt: NOW + 60_001,
    }, identity);

    expect(directory.observe(first, NOW)).toBe('accepted');
    expect(directory.observe(updated, NOW + 2)).toBe('updated');
    expect(directory.observe(updated, NOW + 2)).toBe('unchanged');
    expect(directory.observe(older, NOW + 2)).toBe('stale');
    expect(directory.observe(equivocation, NOW + 2)).toBe('stale');
    expect(directory.select({ limit: 4, now: NOW + 2 })[0].sequence).toBe(2);
  });

  it('filters by group, expires entries, and returns defensive copies', () => {
    const directory = new RelayDirectory(4);
    const publicRelay = descriptor(1, ['public']);
    const toolsRelay = descriptor(2, ['tools']);
    expect(directory.observe(publicRelay, NOW)).toBe('accepted');
    expect(directory.observe(toolsRelay, NOW)).toBe('accepted');

    const selected = directory.select({ supportedGroups: ['public'], limit: 4, now: NOW + 1 });
    expect(selected.map(value => value.relayId)).toEqual([publicRelay.relayId]);
    selected[0].endpoints[0] = 'wss://mutated.example.net/';
    expect(directory.select({ limit: 4, now: NOW + 1 })
      .find(value => value.relayId === publicRelay.relayId)?.endpoints[0])
      .toBe(publicRelay.endpoints[0]);

    expect(directory.size(NOW + 60_000)).toBe(0);
  });

  it('rejects invalid, local, equivocated, and excess descriptors', () => {
    const first = descriptor(1);
    const directory = new RelayDirectory(1, first.relayId);
    expect(directory.observe(first, NOW)).toBe('invalid');

    const accepted = descriptor(2);
    expect(directory.observe(accepted, NOW)).toBe('accepted');
    expect(directory.observe(accepted, NOW + 1)).toBe('unchanged');
    expect(directory.observe(descriptor(3), NOW)).toBe('full');

    const malformed = { ...accepted, signature: 'not-a-signature' };
    expect(directory.observe(malformed, NOW)).toBe('invalid');
  });
});
