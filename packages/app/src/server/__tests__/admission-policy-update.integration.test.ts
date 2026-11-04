import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { EmbeddingEngine } from '@resonance/core';
import { createAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { policyTransferFixture } from '../../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyTransferResponder } from '../../../../relay/src/admission-policy-transfer.js';
import { createRelayServer, type RelayServer } from '../../../../relay/src/server.js';
import { createAppServer, type AppServer } from '../server.js';
import { lockSession } from '../session.js';

let n: Awaited<ReturnType<typeof policyTransferFixture>>, directory: string, app: AppServer, entry: RelayServer, destination: RelayServer, base: string, auth: string;
let responder: ReturnType<typeof createAdmissionPolicyTransferResponder>, head: typeof n.context.genesis, artifact: typeof n.advance;
let gate: ((signal: AbortSignal) => Promise<void>) | undefined;
const query = vi.fn(), source = vi.fn();
async function request(path: string, body?: unknown, authorized = true) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json',
    ...(authorized ? { authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function unlock() { const result = await request('/api/unlock', { password: 'policy-update-test-password' }); expect(result.status).toBe(200); auth = result.body.token; }
beforeAll(async () => {
  n = await policyTransferFixture(true); directory = mkdtempSync(join(tmpdir(), 'desktop-policy-update-')); head = n.advance.commitment.next; artifact = n.advance;
  vi.stubEnv('RESONANCE_DATA_DIR', join(directory, 'personal')); vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  source.mockImplementation(async (_previous, signal) => { await gate?.(signal); return artifact; });
  responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: source });
  query.mockImplementation(async value => {
    const request = parseAdmissionPolicyQuery(value, n.context, Date.now()).request;
    return { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
      votes: n.keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(request, head, n.context, key)) } };
  });
  const discovery = { reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, 'entry'), relayDiscovery: { ...discovery, endpoints: ['ws://127.0.0.1:0/'] } });
  destination = createRelayServer({ host: '::1', port: 0, persistDir: join(directory, 'destination'), relayDiscovery: { ...discovery, endpoints: ['ws://[::1]:0/'] },
    policyQuery: query, policyTransfer: (value, signal) => responder.exchange(value, signal) });
  await entry.start(); await destination.start(); expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
  const endpoint = `ws://[::1]:${destination.getListeningPort()}/`;
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `ws://127.0.0.1:${entry.getListeningPort()}/,${endpoint}`);
  app = createAppServer({ port: 0, relayUrl: endpoint }); base = `http://127.0.0.1:${await app.start()}`;
  expect((await request('/api/init', { password: 'policy-update-test-password' })).status).toBe(200); await unlock();
  expect((await request('/api/admission-wallet/policy', { policy: n.first, authority: n.context.authority, observers: n.context })).status).toBe(200);
}, 30000);
afterAll(async () => {
  lockSession(); await app?.stop(); await responder?.close(); await destination?.stop({ graceful: false }); await entry?.stop({ graceful: false });
  n?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true });
});

it('authenticates an explicit private update, imports a policy above the frame cap and stays silent after unlock', async () => {
  expect((await request('/api/admission-wallet/update', {}, false)).status).toBe(401);
  expect((await request('/api/admission-wallet/update', { endpoint: 'wss://attacker.example/' })).status).toBe(400);
  expect(query).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
  const updated = await request('/api/admission-wallet/update', {});
  expect(updated).toMatchObject({ status: 200, body: { updated: true, revision: 2, remaining: 0 } });
  expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 0, reserved: 0,
    freshness: { installedRevision: 2, observedRevision: 2, conflicted: false } });
  expect(source).toHaveBeenCalledTimes(1);
  expect((await request('/api/admission-wallet/update', {})).body).toMatchObject({ updated: false, revision: 2 }); expect(source).toHaveBeenCalledTimes(1);
  const wire = vi.spyOn(WebSocket.prototype, 'send');
  try { await request('/api/lock', {}); await unlock(); await request('/api/admission-wallet'); expect(wire).not.toHaveBeenCalled(); }
  finally { wire.mockRestore(); }
}, 30000);

it('retains the newer observed floor when locking cancels a download and resumes with an explicit later request', async () => {
  const { authority: _authority, signature: _signature, ...body } = n.second;
  const next = await signAdmissionPolicy({ ...body, revision: 3 }, n.context.authority, n.key.secretKey);
  artifact = await createAdmissionPolicyAdvance(n.second, next, n.context, n.key, n.advance.commitment.next); head = artifact.commitment.next;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  gate = signal => new Promise((_, reject) => { entered(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  const pending = request('/api/admission-wallet/update', {}); await started;
  expect((await request('/api/admission-wallet/update', {})).status).toBe(409);
  await request('/api/lock', {}); const ended = await pending; expect(ended.status).toBe(401);
  gate = undefined; await unlock();
  expect((await request('/api/admission-wallet')).body).toMatchObject({ reserved: 0, freshness: { installedRevision: 2, observedRevision: 3 } });
  const limit = performance.now() + 2000;
  while (responder.health().operations) { if (performance.now() >= limit) throw new Error('Cancelled artifact source did not drain'); await new Promise(resolve => setTimeout(resolve, 10)); }
  expect((await request('/api/admission-wallet/update', {})).body).toMatchObject({ updated: true, revision: 3, remaining: 0 });
  expect((await request('/api/admission-wallet')).body.reserved).toBe(0);
}, 30000);
