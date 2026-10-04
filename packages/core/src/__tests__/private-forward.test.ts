import { describe, expect, it } from 'vitest';
import { decodeUTF8, generateIdentity } from '../crypto.js';
import { createRelayDescriptorV1 } from '../relay-discovery.js';
import { createPrivateRequestV1, generateRelayTransportKeyV1,
  openPrivateEntryRequestV1, PrivateRequestReplayCacheV1 } from '../private-envelope.js';
import { createRelayPrivateForwardV1, isRelayPrivateForwardActiveV1,
  parseRelayPrivateForwardV1, serializeRelayPrivateForwardV1,
  verifyRelayPrivateForwardV1 } from '../private-forward.js';

const NOW = 1_800_000_000_000;

describe('authenticated private relay forwarding', () => {
  it('binds the entry signature to the destination layer and expiry', async () => {
    const entryIdentity = generateIdentity();
    const entryKey = await generateRelayTransportKeyV1(entryIdentity, NOW);
    const destinationKey = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: ['wss://entry.example.net/'],
      reachability: 'direct',
      capabilities: {
        storesPublications: true, storesMailboxes: true, answersQueries: true,
        forwardsQueries: true, replicaExchange: true,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    }, entryIdentity);
    const { request: outer } = await createPrivateRequestV1(
      decodeUTF8('operation'), entryKey.attestation, destinationKey.attestation, NOW + 1,
    );
    const inner = await openPrivateEntryRequestV1(
      outer, entryKey, new PrivateRequestReplayCacheV1(), NOW + 2,
    );
    const signed = createRelayPrivateForwardV1(inner, descriptor, entryIdentity, NOW + 2);
    expect(verifyRelayPrivateForwardV1(signed)).toBe(true);
    expect(isRelayPrivateForwardActiveV1(signed, NOW + 3)).toBe(true);
    expect(parseRelayPrivateForwardV1(serializeRelayPrivateForwardV1(signed))).toEqual(signed);
    expect(verifyRelayPrivateForwardV1({
      ...signed, destination: { ...inner, ciphertext: inner.ciphertext.slice(0, -4) + 'AAAA' },
    })).toBe(false);
    expect(verifyRelayPrivateForwardV1({ ...signed, expiresAt: signed.expiresAt - 1 }))
      .toBe(false);
    expect(verifyRelayPrivateForwardV1({ ...signed, extra: true })).toBe(false);
    expect(isRelayPrivateForwardActiveV1(signed, signed.expiresAt)).toBe(false);
  });
});
