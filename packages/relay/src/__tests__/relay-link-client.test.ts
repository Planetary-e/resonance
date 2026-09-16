import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  createRelayContactHintV1,
  createRelayDescriptorV1,
  generateIdentity,
} from '@resonance/core';
import { connectRelayLinkV1 } from '../relay-link-client.js';
import { createRelayServer, type RelayServer } from '../server.js';

const HUB_PORT = 24_500 + Math.floor(Math.random() * 500);
const SPOKE_PORT = HUB_PORT + 600;
const HUB_DIR = `/tmp/resonance-link-hub-${Date.now()}`;
const SPOKE_DIR = `/tmp/resonance-link-spoke-${Date.now()}`;
const HUB_ENDPOINT = `ws://127.0.0.1:${HUB_PORT}/`;

let hub: RelayServer;
let spoke: RelayServer;

function createHub(): RelayServer {
  return createRelayServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    persistDir: HUB_DIR,
    relayDiscovery: {
      endpoints: [HUB_ENDPOINT],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 2_000,
    },
    relayLinkHeartbeatIntervalMs: 50,
    relayLinkHeartbeatTimeoutMs: 250,
  });
}

beforeAll(async () => {
  hub = createHub();
  spoke = createRelayServer({
    port: SPOKE_PORT,
    host: '127.0.0.1',
    persistDir: SPOKE_DIR,
    relayDiscovery: {
      endpoints: [],
      reachability: 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 2_000,
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', HUB_ENDPOINT)],
      maxConnections: 2,
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 250,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 50,
    relayLinkHeartbeatTimeoutMs: 250,
  });
  await hub.start();
  await spoke.start();
});

afterAll(async () => {
  await spoke.stop();
  await hub.stop();
  rmSync(HUB_DIR, { recursive: true, force: true });
  rmSync(SPOKE_DIR, { recursive: true, force: true });
});

describe('authenticated outbound relay links', () => {
  it('rejects a reachable relay that does not match an invitation pin', async () => {
    const initiator = generateIdentity();
    const wrongRelay = generateIdentity();
    const now = Date.now();
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: [],
      reachability: 'outbound-only',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: false,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: now,
      expiresAt: now + 30_000,
    }, initiator);
    const hint = createRelayContactHintV1('invitation', HUB_ENDPOINT, wrongRelay.did);

    await expect(connectRelayLinkV1(hint, descriptor, initiator, {
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 250,
    })).rejects.toThrow('does not match the pinned relay identity');
    await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(initiator.did));
  });

  it('keeps an outbound-only relay reachable through a direct relay', async () => {
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.length === 1);

    const spokeId = spoke.getRelayDescriptor()!.relayId;
    const hubId = hub.getRelayDescriptor()!.relayId;
    expect(spoke.getRelayLinkStatus().connectedRelayIds).toEqual([hubId]);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
    expect(spoke.getStats().connected_relays).toBe(1);
    expect(hub.getStats().connected_relays).toBe(1);
    expect(hub.getKnownRelayDescriptors().find(value => value.relayId === spokeId)?.reachability)
      .toBe('outbound-only');

    await new Promise(resolve => setTimeout(resolve, 300));
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.includes(hubId)
      && hub.getRelayLinkStatus().inboundRelayIds.includes(spokeId));
    expect(spoke.getRelayLinkStatus().connectedRelayIds).toEqual([hubId]);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
  });

  it('reconnects after the directly reachable relay restarts', async () => {
    const hubId = hub.getRelayDescriptor()!.relayId;
    const spokeId = spoke.getRelayDescriptor()!.relayId;
    await hub.stop();
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.length === 0);

    hub = createHub();
    await hub.start();
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.includes(hubId));

    expect(hub.getRelayDescriptor()!.relayId).toBe(hubId);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
  });

  it('renews the link before continuing with expired descriptors', async () => {
    const spokeId = spoke.getRelayDescriptor()!.relayId;
    const initialSequence = hub.getKnownRelayDescriptors()
      .find(value => value.relayId === spokeId)!.sequence;

    await waitFor(() => {
      const observed = hub.getKnownRelayDescriptors().find(value => value.relayId === spokeId);
      return observed !== undefined
        && observed.sequence > initialSequence
        && spoke.getRelayLinkStatus().connectedRelayIds.length === 1
        && hub.getRelayLinkStatus().inboundRelayIds.includes(spokeId);
    }, 6_000);

    expect(spoke.getRelayLinkStatus().connectedRelayIds).toHaveLength(1);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for relay link state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
