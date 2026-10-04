import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { EmbeddingEngine } from '@resonance/core';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { createAppServer, type AppServer } from '../server.js';
import { getSession, lockSession } from '../session.js';

const directory = mkdtempSync(join(tmpdir(), 'desktop-outbox-'));
const basePort = 49_000 + Math.floor(Math.random() * 500);
const entryUrl = `ws://127.0.0.1:${basePort}/`;
const destinationUrl = `ws://[::1]:${basePort + 1}/`;
let app: AppServer;
let base: string;
let token = '';
const relays: RelayServer[] = [];
async function request(path: string, body?: unknown, authenticated = true) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  vi.stubEnv('RESONANCE_DATA_DIR', join(directory, 'personal'));
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `${entryUrl},${destinationUrl}`);
  // Network/session/storage are real; a fixed vector avoids downloading the model in this regression.
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  vi.spyOn(EmbeddingEngine.prototype, 'embedForMatching').mockResolvedValue(new Float32Array(768).fill(1 / Math.sqrt(768)));
  for (const [index, host, endpoint] of [[0, '127.0.0.1', entryUrl], [1, '::1', destinationUrl]] as const) {
    const relay = createRelayServer({ port: basePort + index, host, persistDir: join(directory, `relay-${index}`),
      relayDiscovery: { endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8 } });
    relays.push(relay); await relay.start();
  }
  expect(relays[0].observeRelayDescriptor(relays[1].getRelayDescriptor()!)).toBe('accepted');
  app = createAppServer({ port: 0, relayUrl: destinationUrl });
  base = `http://127.0.0.1:${await app.start()}`;
  expect((await request('/api/init', { password: 'test-password-for-outbox' })).status).toBe(200);
  token = (await request('/api/unlock', { password: 'test-password-for-outbox' })).body.token;
}, 15_000);
afterAll(async () => {
  lockSession(); if (app) await app.stop();
  for (const relay of relays.reverse()) await relay.stop();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
it('holds and cancels locally across session restart, then explicitly releases one publication through two relays', async () => {
  const wire = vi.spyOn(WebSocket.prototype, 'send');
  expect((await request('/api/status')).body.privateDeliveryAvailable).toBe(true);
  expect((await request('/api/unlock', { password: 'wrong-password' }, false)).status).toBe(401);
  const refreshed = await request('/api/unlock', { password: 'test-password-for-outbox' }, false);
  expect(refreshed.status).toBe(200); expect(refreshed.body.token).not.toBe(token);
  const obsoleteToken = token; token = refreshed.body.token;
  expect((await fetch(base + '/api/items', { headers: { authorization: `Bearer ${obsoleteToken}` } })).status).toBe(401);
  const saved = await request('/api/items', { text: 'I offer patient gardening lessons.', type: 'offer', delivery: 'hold' });
  expect(saved.body.status).toBe('held');
  const s = getSession()!;
  expect(s.store.listItems()).toHaveLength(0); expect(s.store.listPublications()).toHaveLength(0);
  let items = (await request('/api/items')).body;
  const deliveryId = items[0].delivery.id;
  expect(items[0].rawText).toBe('I offer patient gardening lessons.');
  expect(JSON.stringify(items)).not.toMatch(/signingSecret|mailboxSecret|fingerprint|relayUrl/);
  expect(readFileSync(join(directory, 'personal', 'publication-outbox.json'), 'utf8')).not.toContain('gardening');
  await request('/api/matches');
  await request('/api/lock', {});
  token = (await request('/api/unlock', { password: 'test-password-for-outbox' })).body.token;
  await request('/api/matches');
  items = (await request('/api/items')).body;
  expect(items[0].delivery.state).toBe('held');
  expect(wire).not.toHaveBeenCalled();
  expect(relays[1].getStats().stored_publications).toBe(0);
  expect((await request(`/api/outbox/${deliveryId}/release`, {}, false)).status).toBe(401);
  expect(wire).not.toHaveBeenCalled();
  expect((await request(`/api/outbox/${deliveryId}/release`, {})).status).toBe(200);
  expect(relays[0].getStats().stored_publications).toBe(0);
  expect(relays[1].getStats().stored_publications).toBe(1);
  expect(getSession()!.store.listPublications()).toHaveLength(1);
  expect((await request('/api/items')).body[0]).toMatchObject({ status: 'published', delivery: { state: 'delivered' } });
  // Recover an ACK committed to the outbox before the app had imported it into the store.
  const second = await request('/api/items', { text: 'A second saved offer.', type: 'offer', delivery: 'hold' });
  const secondItem = (await request('/api/items')).body.find((item: { id: string }) => item.id === second.body.id);
  await getSession()!.publicationOutbox.release(secondItem.delivery.id);
  expect(getSession()!.store.listPublications()).toHaveLength(1);
  await request('/api/lock', {});
  wire.mockClear();
  token = (await request('/api/unlock', { password: 'test-password-for-outbox' })).body.token;
  expect(getSession()!.store.listPublications()).toHaveLength(2);
  expect(wire).not.toHaveBeenCalled(); // Local recovery never replays the accepted publication.
  const cancelled = await request('/api/items', { text: 'This must never leave.', type: 'need', delivery: 'hold' });
  const cancelledItem = (await request('/api/items')).body.find((item: { id: string }) => item.id === cancelled.body.id);
  expect((await request(`/api/outbox/${cancelledItem.delivery.id}/cancel`, {})).status).toBe(200);
  expect((await request(`/api/outbox/${cancelledItem.delivery.id}/release`, {})).status).toBe(503);
  expect((await request(`/api/outbox/${cancelledItem.delivery.id}/remove`, {})).status).toBe(200);
  expect((await request('/api/items')).body).toHaveLength(2);
  expect(wire).not.toHaveBeenCalled();
  wire.mockRestore();
  const unavailable = vi.spyOn(getSession()!.publicationOutbox, 'list').mockImplementation(() => { throw new Error('State unavailable'); });
  expect((await request('/api/items')).status).toBe(503);
  expect((await request('/api/status')).status).toBe(503);
  unavailable.mockRestore();
  expect((await request('/api/status')).status).toBe(200);
}, 15_000);

it('holds search and per-mailbox checks through restart and keeps automatic refresh quiet until explicitly enabled', async () => {
  expect((await request('/api/private-requests/mailbox-mode', { automatic: false }, false)).status).toBe(401);
  expect((await request('/api/private-requests/mailbox-mode', { automatic: false })).status).toBe(200);
  const wire = vi.spyOn(WebSocket.prototype, 'send');
  try {
    const savedSearch = await request('/api/search', { text: 'I need patient gardening lessons.', type: 'need', delivery: 'hold' });
    expect(savedSearch.status).toBe(200); expect(savedSearch.body.saved).toMatch(/^reqhold_/);
    const publication = getSession()!.store.listPublications()[0];
    const mailbox = await request('/api/private-requests/hold-mailbox', { kind: 'publication-mailbox', id: publication.publicationId });
    expect(mailbox.status).toBe(200);
    expect((await request('/api/private-requests/mailbox-mode', { automatic: true })).status).toBe(409);
    for (const route of ['/api/matches', '/api/channels', '/api/channels/missing']) await request(route);
    await request('/api/lock', {});
    // Existing holds and the persistent pause remain manageable if pilot configuration is removed.
    vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', undefined);
    const unlockedWithoutPilot = await request('/api/unlock', { password: 'test-password-for-outbox' });
    expect(unlockedWithoutPilot.status).toBe(200); token = unlockedWithoutPilot.body.token;
    expect((await request('/api/status')).body).toMatchObject({ privateDeliveryAvailable: false, savedRequestsAvailable: true, automaticMailboxes: false });
    for (const route of ['/api/matches', '/api/channels', '/api/channels/missing']) await request(route);
    const restored = await request('/api/private-requests');
    expect(restored.body.automaticMailboxes).toBe(false);
    expect(restored.body.requests.map((entry: { state: string }) => entry.state)).toEqual(['held', 'held']);
    expect(JSON.stringify(restored.body)).not.toMatch(/fingerprint|relayUrl|secretKey/);
    expect(readFileSync(join(directory, 'personal', 'private-request-outbox.json'), 'utf8')).not.toContain('gardening');
    expect(wire).not.toHaveBeenCalled();
    const searched = await request(`/api/private-requests/${savedSearch.body.saved}/release`, {});
    expect(searched.status).toBe(200); expect(searched.body.result.kind).toBe('search');
    expect(searched.body.result.results.length).toBeGreaterThan(0);
    wire.mockClear();
    const checked = await request(`/api/private-requests/${mailbox.body.saved}/release`, {});
    expect(checked.status).toBe(200); expect(checked.body.result.kind).toBe('mailbox');
    expect(wire).toHaveBeenCalled(); wire.mockClear();
    await request('/api/matches'); await request('/api/channels'); expect(wire).not.toHaveBeenCalled();
    // Completion and expiry are never permission to resume automatic checks.
    expect((await request('/api/status')).body.automaticMailboxes).toBe(false);
    const completed = (await request('/api/private-requests')).body.requests;
    expect(completed.map((entry: { state: string }) => entry.state)).toEqual(['completed', 'completed']);
    expect((await request('/api/private-requests/mailbox-mode', { automatic: true })).status).toBe(200);
    expect((await request('/api/private-requests/mailbox-mode', { automatic: false })).status).toBe(200);
    vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `${entryUrl},${destinationUrl}`);
    await request('/api/lock', {});
    token = (await request('/api/unlock', { password: 'test-password-for-outbox' })).body.token;
    const cancelled = await request('/api/private-requests/hold-mailbox', { kind: 'publication-mailbox', id: publication.publicationId });
    await request(`/api/private-requests/${cancelled.body.saved}/cancel`, {});
    await request(`/api/private-requests/${cancelled.body.saved}/remove`, {});
    expect(wire).not.toHaveBeenCalled();
    expect((await request('/api/private-requests/mailbox-mode', { automatic: true })).status).toBe(200);
    await request('/api/matches'); expect(wire).toHaveBeenCalled();
  } finally { wire.mockRestore(); }
}, 20_000);

it('stops an in-flight automatic check when saving a mailbox hold and does not continue to other mailboxes', async () => {
  const originalSend = WebSocket.prototype.send;
  let replyWithheld = false;
  const wire = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
    const port = (this as unknown as { _socket?: { localPort?: number } })._socket?.localPort;
    if (port === basePort && typeof data === 'string' && JSON.parse(data).type === 'private_response') {
      replyWithheld = true; return;
    }
    return Reflect.apply(originalSend, this, [data, ...args]);
  });
  const pending = request('/api/matches');
  try {
    await vi.waitFor(() => expect(replyWithheld).toBe(true), { timeout: 6000, interval: 20 });
    const publication = getSession()!.store.listPublications()[0];
    expect((await request('/api/private-requests/hold-mailbox', { kind: 'publication-mailbox', id: publication.publicationId })).status).toBe(200);
    expect((await pending).status).toBe(200);
    expect(getSession()!.mailboxSync).toBeUndefined();
    const payloads = wire.mock.calls.filter(([data]) => typeof data === 'string' && JSON.parse(data).stage === 'entry');
    expect(payloads).toHaveLength(1);
    wire.mockClear();
    await request('/api/matches'); await request('/api/channels');
    expect(wire).not.toHaveBeenCalled();
  } finally { wire.mockRestore(); await pending; }
}, 15_000);
