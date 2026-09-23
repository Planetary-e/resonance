import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  createRelayContactHintV1,
  createRelayDescriptorV1,
  generateIdentity,
} from '@resonance/core';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';
import { createRelayServer, type RelayServer } from '../server.js';

const SOURCE_PORT = 22_000 + Math.floor(Math.random() * 1_000);
const COLLECTOR_PORT = SOURCE_PORT + 1_100;
const SOURCE_DIR = `/tmp/resonance-discovery-source-${Date.now()}`;
const COLLECTOR_DIR = `/tmp/resonance-discovery-collector-${Date.now()}`;
const SOURCE_ENDPOINT = `ws://127.0.0.1:${SOURCE_PORT}/`;

let source: RelayServer;
let collector: RelayServer;

beforeAll(async () => {
  source = createRelayServer({
    port: SOURCE_PORT,
    host: '127.0.0.1',
    persistDir: SOURCE_DIR,
    relayDiscovery: {
      endpoints: [SOURCE_ENDPOINT],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      maxKnownRelays: 8,
    },
  });
  collector = createRelayServer({
    port: COLLECTOR_PORT,
    host: '127.0.0.1',
    persistDir: COLLECTOR_DIR,
    relayDiscovery: {
      endpoints: [`ws://127.0.0.1:${COLLECTOR_PORT}/`],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      maxKnownRelays: 8,
    },
  });

  const peerIdentity = generateIdentity();
  const now = Date.now();
  expect(source.observeRelayDescriptor(createRelayDescriptorV1({
    sequence: 1,
    endpoints: ['wss://another-community-relay.example.net/'],
    reachability: 'direct',
    capabilities: {
      storesPublications: true,
      storesMailboxes: true,
      answersQueries: true,
      forwardsQueries: false,
      replicaExchange: false,
    },
    supportedGroups: ['public'],
    storage: { capacityBytes: 1_000_000, availableBytes: 750_000 },
    issuedAt: now,
    expiresAt: now + 60_000,
  }, peerIdentity), now)).toBe('accepted');

  await source.start();
  await collector.start();
});

afterAll(async () => {
  await collector.stop();
  await source.stop();
  rmSync(SOURCE_DIR, { recursive: true, force: true });
  rmSync(COLLECTOR_DIR, { recursive: true, force: true });
});

describe('outbound relay discovery', () => {
  it('rejects a public cleartext endpoint in its own advertisement', () => {
    expect(() => createRelayServer({
      relayDiscovery: {
        endpoints: ['ws://relay.example.org/'],
        reachability: 'direct',
        supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      },
    })).toThrow('Internet-facing relay endpoints require wss://');
  });

  it('rejects a public cleartext contact before dialing', async () => {
    const hint = createRelayContactHintV1('configured', 'ws://relay.example.org/');
    await expect(discoverRelayContactV1(hint))
      .rejects.toThrow('Internet-facing relay endpoints require wss://');
  });

  it('verifies a pinned responder and ingests independently signed descriptors', async () => {
    const sourceDescriptor = source.getRelayDescriptor();
    expect(sourceDescriptor).not.toBeNull();
    const hint = createRelayContactHintV1(
      'invitation',
      SOURCE_ENDPOINT,
      sourceDescriptor!.relayId,
    );

    const result = await collector.discoverRelay(hint, { maxPeers: 2 });

    expect(result.responder.relayId).toBe(sourceDescriptor!.relayId);
    expect(result.descriptors).toHaveLength(2);
    expect(result.observations.every(observation => observation.status === 'accepted')).toBe(true);
    expect(collector.getStats().known_relays).toBe(2);
  });

  it('rejects a responder that does not match an invitation pin', async () => {
    const wrongIdentity = generateIdentity();
    const hint = createRelayContactHintV1('invitation', SOURCE_ENDPOINT, wrongIdentity.did);

    await expect(discoverRelayContactV1(hint, { maxPeers: 1 }))
      .rejects.toThrow('does not match the pinned relay identity');
  });

  it('rejects a descriptor that does not bind the contacted endpoint', async () => {
    const alias = createRelayContactHintV1('configured', `ws://localhost:${SOURCE_PORT}/`);

    await expect(discoverRelayContactV1(alias, { maxPeers: 1 }))
      .rejects.toThrow('does not bind the contacted endpoint');
  });
});
