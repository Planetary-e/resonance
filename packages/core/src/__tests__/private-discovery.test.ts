import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import { createRelayDescriptorV1, createRelayPeerResponseV1 } from '../relay-discovery.js';
import { generateRelayTransportKeyV1 } from '../private-envelope.js';
import {
  createPrivateDiscoveryRequestV1, createPrivateDiscoveryResponseV1,
  parsePrivateDiscoveryRequestV1, serializePrivateDiscoveryRequestV1,
  verifyPrivateDiscoveryResponseV1,
} from '../private-discovery.js';

const ENDPOINT = 'ws://127.0.1.1:43000/';

async function exchange() {
  const now = Date.now();
  const entry = generateIdentity();
  const destination = generateIdentity();
  const descriptor = createRelayDescriptorV1({
    sequence: 1, endpoints: [ENDPOINT], reachability: 'direct',
    capabilities: {
      storesPublications: true, storesMailboxes: true, answersQueries: true,
      forwardsQueries: true, replicaExchange: true,
    },
    supportedGroups: ['public'],
    storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
    issuedAt: now, expiresAt: now + 60_000,
  }, destination);
  const key = await generateRelayTransportKeyV1(destination, now);
  const request = createPrivateDiscoveryRequestV1(ENDPOINT, now);
  const peerResponse = createRelayPeerResponseV1(
    request.peerRequest, [descriptor], destination, now, key.attestation,
  );
  const raw = createPrivateDiscoveryResponseV1(request, '127.0.1.1', peerResponse, entry, now);
  return { now, entry, destination, descriptor, key, request, raw, peerResponse };
}

describe('indirect destination key discovery', () => {
  it('binds a fresh client challenge to signed entry and destination evidence', async () => {
    const { now, entry, descriptor, key, request, raw } = await exchange();
    expect(parsePrivateDiscoveryRequestV1(serializePrivateDiscoveryRequestV1(request), now)).toEqual(request);
    expect(verifyPrivateDiscoveryResponseV1(raw, request, entry.did, now)).toEqual({
      descriptor, transportKey: key.attestation, destinationRemoteAddress: '127.0.1.1',
    });
  });

  it('rejects replay, tampering, wrong entry identity, and a false destination endpoint', async () => {
    const { now, entry, request, raw, peerResponse } = await exchange();
    const differentRequest = createPrivateDiscoveryRequestV1(ENDPOINT, now);
    expect(() => verifyPrivateDiscoveryResponseV1(raw, differentRequest, entry.did, now))
      .toThrow('does not match');
    expect(() => createPrivateDiscoveryResponseV1(
      differentRequest, '127.0.1.1', peerResponse, entry, now,
    )).toThrow('Invalid destination');
    expect(() => verifyPrivateDiscoveryResponseV1(raw, request, generateIdentity().did, now))
      .toThrow('entry signature');
    const tampered = JSON.parse(raw);
    tampered.payload.destinationRemoteAddress = '127.0.2.1';
    expect(() => verifyPrivateDiscoveryResponseV1(JSON.stringify(tampered), request, entry.did, now))
      .toThrow('entry signature');
    expect(() => verifyPrivateDiscoveryResponseV1(raw, request, entry.did, now + 15_000))
      .toThrow('expired');
    const wrongEndpoint = createPrivateDiscoveryRequestV1('ws://127.0.2.1:43000/', now);
    expect(() => createPrivateDiscoveryResponseV1(
      wrongEndpoint, '127.0.2.1', peerResponse, entry, now,
    )).toThrow('Invalid destination');
    expect(() => createPrivateDiscoveryResponseV1(
      request, '127.0.2.1', peerResponse, entry, now,
    )).toThrow('Invalid destination');
  });
});
