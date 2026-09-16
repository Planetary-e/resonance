import { describe, expect, it } from 'vitest';
import {
  observedReplicaFailureDomain,
  prioritizeReplicaDiversity,
} from '../replica-diversity.js';

describe('replica placement diversity', () => {
  it('derives coarse domains from endpoints that completed a relay handshake', () => {
    expect(observedReplicaFailureDomain('ws://192.0.2.10:9000/')).toBe('ipv4:192.0.2.0/24');
    expect(observedReplicaFailureDomain('wss://192.0.2.200/')).toBe('ipv4:192.0.2.0/24');
    expect(observedReplicaFailureDomain('wss://relay.EXAMPLE.org/')).toBe('host:relay.example.org');
    expect(observedReplicaFailureDomain('wss://[2001:db8:abcd:1::1]/'))
      .toBe('ipv6:2001:0db8:abcd::/48');
    expect(observedReplicaFailureDomain('https://relay.example.org/')).toBeUndefined();
  });

  it('prefers new observed domains while preserving stable order within each tier', () => {
    const candidates = [
      { relayId: 'relay-a', endpoint: 'ws://192.0.2.10:9000/' },
      { relayId: 'relay-b', endpoint: 'ws://192.0.2.20:9000/' },
      { relayId: 'relay-c', endpoint: 'ws://198.51.100.8:9000/' },
      { relayId: 'relay-d', endpoint: 'wss://relay.example.org/' },
    ];

    expect(prioritizeReplicaDiversity(candidates).map(candidate => candidate.relayId))
      .toEqual(['relay-a', 'relay-c', 'relay-d', 'relay-b']);
    expect(prioritizeReplicaDiversity(candidates, ['relay-a'])
      .map(candidate => candidate.relayId))
      .toEqual(['relay-c', 'relay-d', 'relay-b']);
  });

  it('deduplicates one relay identity reached through multiple endpoints', () => {
    const candidates = [
      { relayId: 'relay-a', endpoint: 'ws://192.0.2.10:9000/' },
      { relayId: 'relay-a', endpoint: 'ws://198.51.100.10:9000/' },
      { relayId: 'relay-b', endpoint: 'ws://203.0.113.10:9000/' },
    ];

    expect(prioritizeReplicaDiversity(candidates).map(candidate => candidate.relayId))
      .toEqual(['relay-a', 'relay-b']);
  });
});
