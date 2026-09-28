import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  createPublicationRecord, generatePublicationKeyMaterial,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { createRelayClient } from '../relay-client.js';

const BASE_PORT = 46_000 + Math.floor(Math.random() * 1_000);
const ENTRY = `ws://127.0.0.1:${BASE_PORT}/`;
const DESTINATION = `ws://[::1]:${BASE_PORT + 1}/`;
const SAME_DOMAIN = `ws://127.0.0.1:${BASE_PORT + 2}/`;
const dirs = [0, 1, 2].map(index => `/tmp/resonance-private-client-${Date.now()}-${BASE_PORT}-${index}`);
const servers: RelayServer[] = [];

function relay(port: number, host: string, endpoint: string, persistDir: string): RelayServer {
  return createRelayServer({
    port, host, persistDir,
    relayDiscovery: {
      endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
      maxKnownRelays: 8,
    },
  });
}

beforeAll(async () => {
  servers.push(
    relay(BASE_PORT, '127.0.0.1', ENTRY, dirs[0]),
    relay(BASE_PORT + 1, '::1', DESTINATION, dirs[1]),
    relay(BASE_PORT + 2, '127.0.0.1', SAME_DOMAIN, dirs[2]),
  );
  for (const server of servers) await server.start();
  const destinationDescriptor = servers[1].getRelayDescriptor();
  const sameDomainDescriptor = servers[2].getRelayDescriptor();
  expect(destinationDescriptor).toBeDefined();
  expect(sameDomainDescriptor).toBeDefined();
  expect(servers[0].observeRelayDescriptor(destinationDescriptor!)).toBe('accepted');
  expect(servers[0].observeRelayDescriptor(sameDomainDescriptor!)).toBe('accepted');
});

afterAll(async () => {
  for (const server of [...servers].reverse()) await server.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('personal client private transport', () => {
  it('does not allow the same relay URL to act as entry and destination', () => {
    expect(() => createRelayClient({ relayUrl: ENTRY, privateEntryUrls: [ENTRY] }))
      .toThrow('separate entry and destination');
  });

  it('sends publication, search, and mailbox operations through separate observed domains', async () => {
    const client = createRelayClient({
      relayUrl: DESTINATION,
      privateEntryUrls: [ENTRY],
    });
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, keys);
    const ack = await client.submitPublicationOperation(record);
    expect(ack).toMatchObject({ status: 'ok', ref: record.publicationId });
    expect(servers[0].getStats().stored_publications).toBe(0);
    expect(servers[1].getStats().stored_publications).toBe(1);

    const search = await client.searchV2({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'need',
      k: 5, threshold: 0.9,
    });
    expect(search.results.some(result => result.publicationId === record.publicationId)).toBe(true);
    expect((await client.fetchMailbox(record, keys)).envelopes).toEqual([]);
  });

  it('fails closed when both reachable contacts share one observed IP domain', async () => {
    const client = createRelayClient({
      relayUrl: SAME_DOMAIN,
      privateEntryUrls: [ENTRY],
    });
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xc5), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, keys);
    await expect(client.submitPublicationOperation(record)).rejects.toThrow('No independent two-relay route');
    expect(servers[2].getStats().stored_publications).toBe(0);
  });
});
