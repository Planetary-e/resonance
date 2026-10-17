import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { EmbeddingEngine } from '@resonance/core';
import { createAppServer } from '../server.js';
import * as sessions from '../session.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  sessions.lockSession();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-boundary-')), ui = join(directory, 'ui');
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(ui); mkdirSync(join(ui, 'assets')); mkdirSync(join(directory, 'ui-private'));
  writeFileSync(join(ui, 'index.html'), '<h1>Test interface</h1>'); writeFileSync(join(ui, 'assets', 'app.js'), 'safe asset');
  writeFileSync(join(directory, 'ui-private', 'secret.txt'), 'private fixture content');
  symlinkSync(join(directory, 'ui-private', 'secret.txt'), join(ui, 'external.txt'));
  vi.stubEnv('RESONANCE_DATA_DIR', join(directory, 'account'));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: 'ws://127.0.0.1:1/', uiDirectory: ui });
  cleanup.push(() => app.stop()); const port = await app.start(), base = `http://127.0.0.1:${port}`;
  function request(path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST', fragments?: Buffer[]) {
    return new Promise<{ status: number; headers: Record<string, unknown>; text: string; json(): any }>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path, method,
        headers: { 'content-type': 'application/json', ...headers } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk.toString(); });
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, text, json: () => JSON.parse(text) }));
      }); request.on('error', reject);
      if (fragments) {
        void (async () => {
          request.setNoDelay(true);
          for (const chunk of fragments) { request.write(chunk); await new Promise(resolve => setTimeout(resolve, 20)); }
          request.end();
        })().catch(reject);
      } else request.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
    });
  }
  async function init() { expect((await request('/api/init', { password: 'local-boundary-test-password' })).status).toBe(200); }
  async function unlock(headers: Record<string, string> = {}) {
    const response = await request('/api/unlock', { password: 'local-boundary-test-password' }, headers);
    expect(response.status).toBe(200); return response.json().token as string;
  }
  function events(token: string, origin?: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=${token}`, origin ? { origin } : {});
    cleanup.push(async () => socket.terminate()); return socket;
  }
  return { request, init, unlock, events, base };
}

it('rejects foreign origins and rebinding hosts before bootstrap or session access', async () => {
  const f = await fixture();
  const cases: Array<Record<string, string>> = [{ origin: 'https://foreign.example' }, { origin: 'null' },
    { host: 'rebinding.example' }, { host: '127.0.0.1.evil:3000' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of cases) {
    expect((await f.request('/api/init', { password: 'should-not-initialize' }, headers)).status).toBe(403);
    expect((await f.request('/api/status', undefined, headers)).status).toBe(403);
  }
  expect((await f.request('/api/status')).json().initialized).toBe(false);
  expect((await f.request('/api/status', undefined, { origin: f.base })).headers['access-control-allow-origin']).toBe(f.base);
});

it('serves regular UI assets and SPA routes without exposing sibling files, links or directories', async () => {
  const f = await fixture();
  expect((await f.request('/assets/app.js?v=1')).text).toBe('safe asset');
  expect((await f.request('/unknown/route')).text).toBe('<h1>Test interface</h1>');
  expect((await f.request('/assets/app.js', undefined, {}, 'HEAD')).text).toBe('');
  for (const path of ['/%2e%2e%2fui-private/secret.txt', '/external.txt', '/assets/', '/%00']) {
    const response = await f.request(path); expect(response.status).toBe(404); expect(response.text).not.toContain('private fixture content');
  }
  expect((await f.request('/api/status')).status).toBe(200);
});

it('requires a session token to disclose activity or lock, and unauthenticated calls do not renew activity', async () => {
  const f = await fixture(); await f.init(); const token = await f.unlock(), headers = { authorization: `Bearer ${token}` };
  const reset = vi.spyOn(sessions, 'resetInactivityTimer'); reset.mockClear();
  expect((await f.request('/api/status')).json()).toMatchObject({ unlocked: false, did: null, items: 0, matches: 0 });
  expect((await f.request('/api/items')).status).toBe(401);
  expect((await f.request('/api/lock', {})).status).toBe(401); expect(sessions.isUnlocked()).toBe(true);
  expect(reset).not.toHaveBeenCalled();
  expect((await f.request('/api/status', undefined, headers)).json().did).toMatch(/^did:key:/);
  expect((await f.request('/api/items', undefined, headers)).status).toBe(200); expect(reset).toHaveBeenCalledOnce();
  expect((await f.request('/api/lock', {}, headers)).status).toBe(200); expect(sessions.isUnlocked()).toBe(false);
});

it('revokes open event sockets on lock and token rotation, rejects stale/foreign upgrades and inbound event payloads', async () => {
  const f = await fixture(); await f.init(); const old = await f.unlock();
  const socket = f.events(old, 'tauri://localhost'); await once(socket, 'open');
  const closed = once(socket, 'close'), next = await f.unlock(); await closed; expect(next).not.toBe(old);
  await expect(once(f.events(old), 'open')).rejects.toThrow('401');
  await expect(once(f.events(next, 'https://foreign.example'), 'open')).rejects.toThrow('403');
  const current = f.events(next); await once(current, 'open'); const locked = once(current, 'close');
  sessions.lockSession(); await locked;
  await expect(once(f.events(next), 'open')).rejects.toThrow('401');
  const fresh = f.events(await f.unlock()); await once(fresh, 'open'); const refused = once(fresh, 'close');
  fresh.send('unexpected input'); await refused;
});

it('keeps CORS headers attached to the correct response during overlapping requests', async () => {
  const f = await fixture(); await f.init();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(EmbeddingEngine.prototype.initialize).mockImplementationOnce(async () => { entered(); await gate; });
  cleanup.push(async () => release());
  const pending = f.request('/api/unlock', { password: 'local-boundary-test-password' }, { origin: 'http://localhost:5173' });
  await started;
  const fast = await f.request('/api/status', undefined, { origin: 'tauri://localhost' });
  expect(fast.headers['access-control-allow-origin']).toBe('tauri://localhost');
  release(); const slow = await pending; expect(slow.status).toBe(200);
  expect(slow.headers['access-control-allow-origin']).toBe('http://localhost:5173');
});

it('does not reopen a session after lock interrupts model initialization and excludes simultaneous unlocks', async () => {
  const f = await fixture(); await f.init();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(EmbeddingEngine.prototype.initialize).mockImplementationOnce(async () => { entered(); await gate; });
  cleanup.push(async () => release());
  const pending = f.request('/api/unlock', { password: 'local-boundary-test-password' }); await started;
  expect((await f.request('/api/unlock', { password: 'local-boundary-test-password' })).status).toBe(401);
  expect((await f.request('/api/lock', {})).status).toBe(200); release();
  const result = await pending; expect(result.status).toBe(401); expect(result.json().token).toBeUndefined();
  expect(sessions.isUnlocked()).toBe(false); expect(await f.unlock()).toHaveLength(64);
});

it('serializes initial identity creation and cancels it before writing when locked during model loading', async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(EmbeddingEngine.prototype.initialize).mockImplementationOnce(async () => { entered(); await gate; });
  cleanup.push(async () => release());
  const pending = f.request('/api/init', { password: 'local-boundary-test-password' }); await started;
  expect((await f.request('/api/init', { password: 'competing-password' })).status).toBe(500);
  sessions.lockSession(); release(); expect((await pending).status).toBe(500);
  expect(sessions.isInitialized()).toBe(false); await f.init(); const original = await f.unlock();
  expect((await f.request('/api/init', { password: 'replacement-password' })).status).toBe(400);
  expect((await f.request('/api/status', undefined, { authorization: `Bearer ${original}` })).json().unlocked).toBe(true);
});

it('rejects malformed, non-object and invalid UTF-8 JSON before initialization', async () => {
  const f = await fixture();
  const malformed = [Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from('"text"'),
    Buffer.concat([Buffer.from('{"password":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')])];
  for (const body of malformed) expect((await f.request('/api/init', body)).status).toBe(400);
  expect((await f.request('/api/init', { password: { unexpected: true } })).status).toBe(400);
  expect(sessions.isInitialized()).toBe(false);
  await expect(f.request('/api/init', Buffer.alloc(1024 * 1024 + 1, 32))).rejects.toThrow();
  expect((await f.request('/api/status')).status).toBe(200); expect(sessions.isInitialized()).toBe(false);
});

it('preserves a password whose UTF-8 character is split across actual HTTP chunks', async () => {
  const f = await fixture(), password = 'contraseña-🙂-fragmentada', bytes = Buffer.from(JSON.stringify({ password }));
  const split = bytes.indexOf(Buffer.from('🙂')) + 2;
  expect((await f.request('/api/init', {}, {}, 'POST', [bytes.subarray(0, split), bytes.subarray(split)])).status).toBe(200);
  expect((await f.request('/api/unlock', { password })).status).toBe(200);
});
