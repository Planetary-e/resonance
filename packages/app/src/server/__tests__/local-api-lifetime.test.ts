import { afterEach, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createLocalApiLifetimes } from '../local-api-lifetime.js';
import { readLocalJsonBody } from '../local-json-body.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }

async function fixture(handler: (req: Parameters<ReturnType<typeof createLocalApiLifetimes>['open']>[0],
  lifetime: NonNullable<ReturnType<ReturnType<typeof createLocalApiLifetimes>['open']>>) => Promise<unknown>, options = { maximum: 2, inputMs: 100 }) {
  const manager = createLocalApiLifetimes(options.maximum, options.inputMs);
  const server = createServer({ keepAliveTimeout: options.inputMs, keepAliveTimeoutBuffer: 0 }, async (req, res) => {
    const lifetime = manager.open(req, res); if (!lifetime) return;
    try {
      const result = await handler(req, lifetime); lifetime.assertCurrent();
      if (!res.writableEnded && !res.destroyed) { res.writeHead(200); res.end(JSON.stringify(result)); }
    } catch {
      if (!res.writableEnded && !res.destroyed) { res.writeHead(409); res.end('{}'); }
    } finally { lifetime.close(); }
  });
  server.setTimeout(options.inputMs, socket => { if (!manager.isProcessing(socket)) socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = () => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' });
  return { port, request };
}

it('allows admitted processing beyond the input idle cutoff and releases its slot afterwards', async () => {
  const f = await fixture(async (req, lifetime) => { lifetime.admit(1000); await readLocalJsonBody(req); await delay(150); return { complete: true }; });
  expect(await (await f.request()).json()).toEqual({ complete: true });
  expect((await f.request()).status).toBe(200);
});

it('expires an admitted operation once, cancels it and keeps an uncooperative handler charged until settlement', async () => {
  const waiting = gate(), admitted = gate(), settled = gate(); let aborted = false;
  const f = await fixture(async (req, lifetime) => {
    await readLocalJsonBody(req); lifetime.admit(80); admitted.release();
    lifetime.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await waiting.promise; settled.release(); return {};
  }, { maximum: 1, inputMs: 1000 });
  cleanup.push(async () => { waiting.release(); await settled.promise; });
  const pending = f.request(); await admitted.promise;
  expect((await pending).status).toBe(504); expect(aborted).toBe(true);
  expect((await f.request()).status).toBe(503);
  waiting.release(); await settled.promise; await delay(5);
  expect((await f.request()).status).toBe(200);
});

it('does not let authentication or periodic chunks extend an incomplete body deadline', async () => {
  let cancelled = false;
  const f = await fixture(async (req, lifetime) => {
    lifetime.admit(2000); lifetime.signal.addEventListener('abort', () => { cancelled = true; });
    await readLocalJsonBody(req); return {};
  });
  const socket = connect(f.port, '127.0.0.1'); cleanup.push(async () => { socket.destroy(); }); await once(socket, 'connect');
  let response = '', reset = false; socket.on('data', bytes => { response += bytes; });
  socket.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') reset = true; });
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Length: 1000\r\n\r\n{`);
  const timer = setInterval(() => socket.write(' '), 10);
  try { await closed; } finally { clearInterval(timer); }
  // Closing a connection with unread incoming bytes may reset it after the 408.
  expect(response.includes('408') || reset).toBe(true); expect(cancelled).toBe(true);
});

it('cancels disconnected callers but does not free capacity while their handler is still running', async () => {
  const started = gate(), waiting = gate(), cancelled = gate();
  const f = await fixture(async (req, lifetime) => {
    lifetime.admit(2000); await readLocalJsonBody(req);
    lifetime.signal.addEventListener('abort', () => cancelled.release(), { once: true }); started.release();
    await waiting.promise; return {};
  }, { maximum: 1, inputMs: 1000 });
  cleanup.push(async () => waiting.release());
  const req = httpRequest({ hostname: '127.0.0.1', port: f.port, method: 'POST' }); req.on('error', () => {}); req.end('{}');
  await started.promise; req.destroy(); await cancelled.promise;
  expect((await f.request()).status).toBe(503); waiting.release();
});

it('rechecks elapsed monotonic time even when the event loop delays the timeout callback', async () => {
  const f = await fixture(async (req, lifetime) => {
    await readLocalJsonBody(req); lifetime.admit(10);
    const end = performance.now() + 25; while (performance.now() < end) { /* simulate synchronous work */ }
    lifetime.assertCurrent(); return {};
  }, { maximum: 1, inputMs: 1000 });
  expect((await f.request()).status).toBe(504);
});

it('keeps simultaneous pipelined requests on their own deadlines and bounds the idle socket afterwards', async () => {
  const f = await fixture(async (req, lifetime) => {
    lifetime.admit(1000); await readLocalJsonBody(req);
    await delay(req.url === '/first' ? 10 : 180); return { path: req.url };
  });
  const socket = connect(f.port, '127.0.0.1'); cleanup.push(async () => { socket.destroy(); }); await once(socket, 'connect');
  let response = ''; socket.on('data', bytes => { response += bytes; }); const closed = once(socket, 'close');
  socket.write(['/first', '/second'].map(path => `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Length: 2\r\n\r\n{}`).join(''));
  await closed; expect(response.match(/HTTP\/1.1 200/g)).toHaveLength(2); expect(response).toContain('"path":"/second"');
});
