import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createRelayContactHintV1 } from '@resonance/core';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it.each(['throw', 'cancel', 'elapsed'] as const)('sends no discovery request after an accounting callback causes %s', async kind => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: true });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const messages: string[] = [], extensions: Array<string | undefined> = [];
  const closed = new Promise<void>(resolve => server.once('connection', (socket, request) => {
    extensions.push(request.headers['sec-websocket-extensions']);
    socket.on('error', () => {}); socket.on('message', data => messages.push(data.toString())); socket.once('close', () => resolve());
  }));
  await once(server, 'listening');
  const hint = createRelayContactHintV1('configured', `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const controller = new AbortController(); let calls = 0;
  const attempt = discoverRelayContactV1(hint, { timeoutMs: kind === 'elapsed' ? 100 : 1000, signal: controller.signal, onTransportSocket() {
    calls++; if (kind === 'throw') throw new Error('Private accounting details');
    if (kind === 'elapsed') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); return; }
    controller.abort(new Error('Owner cancelled discovery'));
  } });
  await expect(attempt).rejects.toThrow(kind === 'throw' ? 'socket accounting failed' : kind === 'elapsed' ? 'timed out' : 'cancelled');
  await closed; expect(calls).toBe(1); expect(messages).toEqual([]); expect(extensions).toEqual([undefined]);
});
