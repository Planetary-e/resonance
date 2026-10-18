import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  createPublicationRecord, createRelayDescriptorV1, createRelayReplicaInventoryBatchResponseFrameV1,
  createRelayReplicaInventoryBatchResponseV1, createRelayReplicaPutV1, createRelayReplicaReceiptV1,
  generateIdentity, generatePublicationKeyMaterial, serializeRelayReplicaInventoryBatchResponseFrameV1,
  verifyRelayReplicaInventoryBatchResponseV1, type RelayReplicaInventoryBatchRequestV1,
} from '@resonance/core';
import { ReverseReplicaRequests } from '../reverse-replica-link.js';

const NOW = 1_800_000_000_000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const owner = generateIdentity(), volunteer = generateIdentity(); let sent = '';
  // The production request table and signed protocol run unchanged; only the
  // already-authenticated socket's wire delivery is controlled by this test.
  const socket = { readyState: WebSocket.OPEN, send: vi.fn((raw: string) => { sent = raw; }), close: vi.fn() };
  const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
    capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
    supportedGroups: ['public'], storage: { capacityBytes: 1_000_000, availableBytes: 800_000 }, issuedAt: NOW, expiresAt: NOW + 60_000 }, volunteer);
  const requests = new ReverseReplicaRequests(owner, relayId => relayId === volunteer.did
    ? { socket: socket as unknown as WebSocket, descriptor } : undefined);
  const operation = createPublicationRecord({ groupId: 'public', fingerprintEpoch: '2026-09', fingerprint: new Uint8Array(64).fill(0xa5),
    itemType: 'offer', createdAt: NOW, expiresAt: NOW + 60_000 }, generatePublicationKeyMaterial());
  const placement = createRelayReplicaPutV1(operation, owner, NOW, NOW + 30_000);
  const receipt = createRelayReplicaReceiptV1(placement, volunteer, { status: 'stored' }, NOW + 1);
  function start() {
    const pending = requests.checkReplicaBatch(volunteer.did, [receipt]);
    const request = JSON.parse(sent).request as RelayReplicaInventoryBatchRequestV1;
    const response = createRelayReplicaInventoryBatchResponseV1(request, volunteer, { status: 'inventory', present: [true] }, request.createdAt);
    expect(verifyRelayReplicaInventoryBatchResponseV1(response, request)).toBe(true);
    return { pending, request, response, raw: serializeRelayReplicaInventoryBatchResponseFrameV1(createRelayReplicaInventoryBatchResponseFrameV1(response)) };
  }
  return { requests, socket, volunteer, start };
}

it.each(['socket', 'peer'] as const)('does not accept a valid presence reply from the wrong authenticated %s', async wrong => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 2);
  const n = fixture(), reply = n.start(); let accepted = false; void reply.pending.then(() => { accepted = true; });
  const otherSocket = { ...n.socket, close: vi.fn() };
  expect(n.requests.handleResponse(reply.raw, wrong === 'peer' ? generateIdentity().did : n.volunteer.did,
    (wrong === 'socket' ? otherSocket : n.socket) as unknown as WebSocket)).toBe(true);
  await Promise.resolve(); expect(accepted).toBe(false);
  expect((wrong === 'socket' ? otherSocket : n.socket).close).toHaveBeenCalledWith(4000, 'unbound_reverse_replica_response');
  expect(n.requests.handleResponse(reply.raw, n.volunteer.did, n.socket as unknown as WebSocket)).toBe(true);
  expect(await reply.pending).toEqual(reply.response);
});

it.each(['exact-expiry', 'after-expiry', 'monotonic-timeout'] as const)('refuses an authentic presence reply at %s before its timer callback runs', async late => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const wall = vi.spyOn(Date, 'now').mockReturnValue(NOW + 2), clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const n = fixture(), reply = n.start();
  const outcome = reply.pending.then(() => 'accepted', () => 'refused');
  if (late === 'monotonic-timeout') offset = 10_001;
  else wall.mockReturnValue(reply.request.expiresAt + (late === 'after-expiry' ? 1 : 0));
  expect(n.requests.handleResponse(reply.raw, n.volunteer.did, n.socket as unknown as WebSocket)).toBe(true);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await outcome).toBe('refused'); expect(n.socket.close).not.toHaveBeenCalled();
});
