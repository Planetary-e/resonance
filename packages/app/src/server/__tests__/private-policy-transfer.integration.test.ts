import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { policyTransferFixture } from '../../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyChunkRequest } from '@resonance/core/admission-policy-transfer';
import { createAdmissionPolicyTransferResponder } from '../../../../relay/src/admission-policy-transfer.js';
import { createRelayServer, type RelayServer } from '../../../../relay/src/server.js';
import { createRelayClient, type RelayClient } from '../../../../node/src/relay-client.js';

let n: Awaited<ReturnType<typeof policyTransferFixture>>, responder: ReturnType<typeof createAdmissionPolicyTransferResponder>;
let entry: RelayServer, destination: RelayServer, directory: string, entryUrl: string, destinationUrl: string;
let corrupt = false, permitted = true;
const source = vi.fn(), query = vi.fn(), clients: RelayClient[] = [], capability = vi.fn();
beforeAll(async () => {
  n = await policyTransferFixture(true); directory = mkdtempSync(join(tmpdir(), 'private-policy-transfer-'));
  source.mockImplementation(async () => n.advance);
  responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: source });
  query.mockImplementation(async (value, signal) => {
    const result = await responder.exchange(value, signal);
    return corrupt && result.index === 1 ? { ...result, data: result.data.slice(1) } : result;
  });
  const discovery = { reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, 'entry'), relayDiscovery: { ...discovery, endpoints: ['ws://127.0.0.1:0/'] } });
  destination = createRelayServer({ host: '::1', port: 0, persistDir: join(directory, 'destination'), relayDiscovery: { ...discovery, endpoints: ['ws://[::1]:0/'] },
    policyTransfer: query, acceptNewWork: () => permitted });
  await entry.start(); await destination.start();
  entryUrl = `ws://127.0.0.1:${entry.getListeningPort()}/`; destinationUrl = `ws://[::1]:${destination.getListeningPort()}/`;
  expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
}, 30000);
afterEach(() => { clients.splice(0).forEach(c => c.disconnect()); query.mockClear(); capability.mockClear(); corrupt = false; permitted = true; });
afterAll(async () => { await responder?.close(); await destination?.stop({ graceful: false }); await entry?.stop({ graceful: false }); n?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
function client() {
  const value = createRelayClient({ relayUrl: destinationUrl, privateEntryUrls: [entryUrl], privateTraffic: { batchWindowMs: 10, jitterMs: 0 }, admissionCapabilityProvider: capability });
  clients.push(value); return value;
}
it('authenticates a policy larger than 190 KiB across multiple encrypted private requests without tokens', async () => {
  const result = await client().fetchAdmissionPolicySuccessor!(n.context, n.context.genesis);
  expect(result).toEqual(n.advance); expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(190 * 1024);
  expect(query.mock.calls.length).toBeGreaterThan(1); expect(source).toHaveBeenCalledTimes(1); expect(capability).not.toHaveBeenCalled();
}, 15000);
it('rejects a malformed chunk and cancels remaining workers before returning', async () => {
  corrupt = true;
  await expect(client().fetchAdmissionPolicySuccessor!(n.context, n.context.genesis)).rejects.toThrow('invalid length');
  const count = query.mock.calls.length; await new Promise(resolve => setTimeout(resolve, 100));
  expect(query).toHaveBeenCalledTimes(count); expect(responder.health().operations).toBe(0); expect(capability).not.toHaveBeenCalled();
}, 15000);
it('refuses direct transfer and owner-paused private requests before reading artifacts', async () => {
  const socket = new WebSocket(destinationUrl), closed = once(socket, 'close'); await once(socket, 'open');
  socket.send(JSON.stringify(createAdmissionPolicyChunkRequest(n.context, n.context.genesis))); await closed;
  expect(query).not.toHaveBeenCalled();
  permitted = false; await expect(client().fetchAdmissionPolicySuccessor!(n.context, n.context.genesis)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled(); expect(capability).not.toHaveBeenCalled();
});
