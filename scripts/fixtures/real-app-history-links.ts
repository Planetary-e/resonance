/** Actual signed relay handshakes and durable history handlers for local tests.
 * Two separate five-volunteer pools avoid exceeding eight histories per collection.
 * This is measured local composition, not proof of independent operators. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { generateIdentity, createRelayDescriptorV1, createRelayContactHintV1, type SigningKeyPair } from '@resonance/core';
import { historyCheckpointContextId, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { HistoryRelayRouter } from '../../packages/relay/src/history-relay-router.js';
import { RelayLinkManager } from '../../packages/relay/src/relay-link-client.js';
import { createRelayServer } from '../../packages/relay/src/server.js';
import { HISTORY_VOLUNTEER_MAX_HISTORIES, historyCollectionContext } from '../../packages/relay/src/history-volunteer-collection.js';
import type { openHistoryVolunteerService } from '../../packages/relay/src/history-volunteer-service.js';
import type { RealAppNetwork } from './real-app-network.js';

type Cleanup = Array<() => void | Promise<void>>;
type Service = ReturnType<typeof openHistoryVolunteerService>;

export async function createRealAppHistoryLinks(directory: string, memberKeys: SigningKeyPair[], ownerCount: number,
  category: 'policy-history' | 'admission-history', network: RealAppNetwork, cleanup: Cleanup) {
  assert(network.tls, 'Persistent history-link evaluation requires verified TLS');
  assert.equal(memberKeys.length, 5);
  assert(Number.isSafeInteger(ownerCount) && ownerCount > 0 && ownerCount <= HISTORY_VOLUNTEER_MAX_HISTORIES);
  const owners = Array.from({ length: ownerCount }, generateIdentity);
  cleanup.push(() => owners.forEach(owner => owner.secretKey.fill(0)));
  const services = Array.from({ length: 5 }, () => new Map<string, Service>());
  const contexts = new Map<number, string>(), volunteers: Array<{ id: string; endpoint: string }> = [];
  for (let i = 0; i < 5; i++) {
    const address = await network.address(category);
    const router = new HistoryRelayRouter({ acceptedRelayIds: owners.map(owner => owner.did), handler(method, value) {
      const service = services[i].get(historyCollectionContext(method, value));
      if (!service) throw new Error('History is not available in this enrolled collection');
      return method === 'agreement' ? service.exchange(value) : service[method](value);
    } });
    cleanup.push(() => router.close());
    const server = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, `volunteer-${i}`),
      tls: network.tls, identityPassphrase: randomBytes(32).toString('base64url'),
      historyLinks: router, relayDiscovery: { endpoints: [address.url], reachability: 'direct', supportedGroups: [],
        storage: { capacityBytes: 4_000_000, availableBytes: 4_000_000 } } });
    await server.start(); address.forwardTo(server.getListeningPort()!);
    cleanup.push(() => server.stop({ graceful: false }));
    volunteers.push({ id: server.getRelayDescriptor()!.relayId, endpoint: address.url });
  }
  const started = new Set<number>();
  return {
    enroll(owner: number, replica: number, context: HistoryCheckpointContext, service: Service) {
      assert(Number.isSafeInteger(owner) && Number.isSafeInteger(replica) && owners[owner] && services[replica] && !started.has(owner));
      // Policy contexts canonicalize membership order; volunteer indexes follow
      // the supplied keys, so compare the full key set rather than positions.
      assert.deepEqual([...context.members].sort(), memberKeys.map(key => Buffer.from(key.publicKey).toString('base64url')).sort());
      const id = historyCheckpointContextId(context), previous = contexts.get(owner);
      assert(previous === undefined || previous === id);
      assert(!services[replica].has(id) && services[replica].size < HISTORY_VOLUNTEER_MAX_HISTORIES);
      contexts.set(owner, id); services[replica].set(id, service);
    },
    async owner(index: number) {
      const identity = owners[index], context = contexts.get(index);
      assert(identity && context && !started.has(index) && services.every(store => store.has(context)));
      started.add(index);
      const router = new HistoryRelayRouter({ serializeRequests: true, waitForConnection: true,
        members: memberKeys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), relayId: volunteers[i].id })) });
      cleanup.push(() => router.close());
      let sequence = Date.now();
      const manager = new RelayLinkManager(identity, () => {
        const now = Date.now(); sequence = Math.max(sequence + 1, now);
        return createRelayDescriptorV1({ sequence, issuedAt: now, expiresAt: now + 120000,
          reachability: 'outbound-only', endpoints: [], supportedGroups: [],
          capabilities: { storesPublications: false, storesMailboxes: false, answersQueries: false, forwardsQueries: false, replicaExchange: false },
          storage: { capacityBytes: 0, availableBytes: 0 } }, identity);
      }, { targets: volunteers.map(v => createRelayContactHintV1('configured', v.endpoint, v.id)),
        maxConnections: 5, historyLinks: router, handshakeTimeoutMs: 10000, reconnectBaseMs: 250, reconnectMaxMs: 1000 });
      cleanup.push(() => manager.stop()); manager.start();
      // Only setup waits for handshakes; application freshness remains three seconds.
      const cutoff = performance.now() + 10000;
      while (router.health().connectedDirectMembers !== 5) {
        if (performance.now() >= cutoff) throw new Error('History fixture pinned handshakes did not complete');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { transport: router.checkpoint, members: memberKeys.map((key, i) => ({
        publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: new URL('/history-checkpoint', volunteers[i].endpoint).href,
      })), closeReplica(replica: number) {
        assert(Number.isSafeInteger(replica) && services[replica]);
        // Only this enrolled history closes. Other owners on the same volunteer
        // retain their durable stores and their authenticated shared connection.
        const service = services[replica].get(context); services[replica].delete(context); service?.close();
      } };
    },
  };
}
