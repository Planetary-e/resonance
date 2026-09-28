import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { publicVerif } from '@cloudflare/privacypass-ts';
import {
  createBlindAdmissionRequestV2, createPublicationRecord, generatePublicationKeyMaterial,
  issueBlindAdmissionRequestV2, presentBlindAdmissionTokenV2,
} from '@resonance/core';
import { createLocalBlindAdmissionVerifierV2, createRelayServer, type RelayServer } from '@resonance/relay';
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
    await expect(client.submitPublicationOperation(record)).rejects.toThrow('overlap the entry network domain');
    expect(servers[2].getStats().stored_publications).toBe(0);
  });

  it('redeems a blind token through the two-hop client without sending an account ID', async () => {
    const entryEndpoint = `ws://127.0.0.1:${BASE_PORT + 3}/`;
    const destinationEndpoint = `ws://[::1]:${BASE_PORT + 4}/`;
    const entryDir = `${dirs[0]}-blind-entry`;
    const destinationDir = `${dirs[0]}-blind-destination`;
    const scope = { issuer: 'community-test', community: 'public', epoch: '2026-09' };
    const mode = publicVerif.BlindRSAMode.PSS;
    const keys = await publicVerif.Issuer.generateKey(mode, {
      modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]),
    });
    const issuer = new publicVerif.Issuer(mode, scope.issuer, keys.privateKey, keys.publicKey);
    const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey);
    const token = await blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request));
    const verifier = createLocalBlindAdmissionVerifierV2({
      directory: destinationDir, scope, issuerPublicKey: keys.publicKey,
    });
    const entry = relay(BASE_PORT + 3, '127.0.0.1', entryEndpoint, entryDir);
    const destination = createRelayServer({
      port: BASE_PORT + 4, host: '::1', persistDir: destinationDir,
      admissionVerifier: verifier,
      relayDiscovery: {
        endpoints: [destinationEndpoint], reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8,
      },
    });
    await entry.start();
    await destination.start();
    try {
      expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
      const client = createRelayClient({
        relayUrl: destinationEndpoint,
        privateEntryUrls: [entryEndpoint],
        admissionCapabilityProvider: ({ action, requestBinding }) =>
          presentBlindAdmissionTokenV2(token, scope, action, requestBinding),
      });
      const now = Date.now();
      const record = createPublicationRecord({
        groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
        fingerprint: new Uint8Array(64).fill(0xd6), itemType: 'offer',
        createdAt: now, expiresAt: now + 86_400_000,
      }, generatePublicationKeyMaterial());
      expect((await client.submitPublicationOperation(record)).status).toBe('ok');
      expect(entry.getStats().stored_publications).toBe(0);
      expect(destination.getStats().stored_publications).toBe(1);
    } finally {
      await destination.stop();
      await entry.stop();
      verifier.close();
      rmSync(entryDir, { recursive: true, force: true });
      rmSync(destinationDir, { recursive: true, force: true });
    }
  });
});
