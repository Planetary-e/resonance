import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createPublicationRecord, generatePublicationKeyMaterial, createPublicationOperationFrame,
  serializePublicationOperationFrame, type AdmissionCapabilityV2 } from '@resonance/core';
import { createRelayServer, type RelayConfig } from '../server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function relay(config: Partial<RelayConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'listener-bounds-'));
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  const server = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory, ...config });
  cleanup.push(() => server.stop({ graceful: false })); await server.start();
  return { server, port: server.getListeningPort()!, directory };
}
async function raw(port: number) {
  const socket = connect(port, '127.0.0.1'); socket.on('error', () => {});
  cleanup.push(async () => socket.destroy()); await once(socket, 'connect'); return socket;
}
function closes(socket: Socket | WebSocket) { return new Promise<void>(resolve => socket.once('close', () => resolve())); }
function publication() {
  const now = Date.now();
  return createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(42),
    itemType: 'offer', createdAt: now, expiresAt: now + 60000 }, generatePublicationKeyMaterial());
}

it('bounds total raw connections, preserves existing sockets and frees capacity on close', async () => {
  const { server, port } = await relay({ maxInboundConnections: 2 });
  const a = await raw(port), b = await raw(port), c = await raw(port);
  await closes(c); expect(a.destroyed).toBe(false); expect(b.destroyed).toBe(false);
  const aClosed = closes(a); a.destroy(); await aClosed;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  expect(response.status).toBe(200); await response.text();
  const bClosed = closes(b); await server.stop({ graceful: false }); await bClosed;
});

it.each(['idle-http', 'drip-http', 'idle-tls', 'idle-websocket'] as const)(
  'expires %s openings without waiting for the peer to cooperate', async mode => {
    const { port } = await relay({ inboundHandshakeTimeoutMs: 300,
      ...(mode === 'idle-tls' ? { identityPassphrase: 'test-only-listener-key', tls: {
        cert: readFileSync(new URL('./fixtures/localhost-test.crt', import.meta.url)),
        key: readFileSync(new URL('./fixtures/localhost-test.key', import.meta.url)),
      } } : {}) });
    if (mode === 'idle-websocket') {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`); socket.on('error', () => {});
      cleanup.push(async () => socket.terminate()); const closed = closes(socket);
      await once(socket, 'open'); await closed; return;
    }
    const socket = await raw(port), closed = closes(socket);
    socket.resume(); // Consume the HTTP error, if the header deadline returns one.
    if (mode === 'drip-http') {
      socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
      const timer = setInterval(() => socket.write('x'), 40);
      try { await closed; } finally { clearInterval(timer); }
    } else await closed;
  }, 4000,
);

it('refuses oversized headers before processing a WebSocket request', async () => {
  const { port, server } = await relay(); const socket = await raw(port), closed = closes(socket); let response = '';
  socket.on('data', bytes => { response += bytes.toString(); });
  socket.write(`GET /health HTTP/1.1\r\nHost: localhost\r\nX-Fill: ${'a'.repeat(9000)}\r\n\r\n`);
  await closed; expect(response).toContain('431'); expect(server.getStats().journal_entries).toBe(0);
});

it('refuses a signed publication encoded as a binary frame', async () => {
  const { port, server } = await relay({ inboundHandshakeTimeoutMs: 300 });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`); socket.on('error', () => {});
  cleanup.push(async () => socket.terminate()); const closed = closes(socket);
  await once(socket, 'open'); socket.send(Buffer.from(serializePublicationOperationFrame(createPublicationOperationFrame(publication()))));
  await closed; expect(server.getStats().stored_publications).toBe(0); expect(server.getStats().journal_entries).toBe(0);
});

it('waits for an in-flight admission decision before shutdown permits stores to close', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { server, port, directory } = await relay({ admissionVerifier: {
    async verifyAndSpend() { entered(); await gate; return { status: 'accepted' as const }; },
  } });
  const capability: AdmissionCapabilityV2 = { version: 2, kind: 'admission-capability', scheme: 'test-blind-token-v1',
    issuer: 'community:test', token: 'A'.repeat(43), requestProof: `admreq_${'a'.repeat(86)}` };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`); socket.on('error', () => {});
  cleanup.push(async () => { release(); socket.terminate(); });
  await once(socket, 'open'); socket.send(serializePublicationOperationFrame(createPublicationOperationFrame(publication(), capability)));
  await started; let stopped = false;
  const closing = server.stop({ graceful: false }).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
  release(); await closing;
  expect(server.getStats().stored_publications).toBe(1); expect(server.getListeningPort()).toBeNull();
  const reopened = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory });
  cleanup.push(() => reopened.stop({ graceful: false })); await reopened.start();
  expect(reopened.getStats().stored_publications).toBe(1);
});

it('rejects invalid listener bounds before opening storage', () => {
  for (const config of [{ maxInboundConnections: 0 }, { maxInboundConnections: 4097 },
    { inboundHandshakeTimeoutMs: 249 }, { inboundHandshakeTimeoutMs: 10001 }]) {
    expect(() => createRelayServer(config)).toThrow('Invalid inbound connection or handshake bounds');
  }
});
