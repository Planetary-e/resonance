/** Calibrate the local byte-stream fixture, without application/crypto workloads. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import { createRealAppNetwork, realAppTestCa } from './fixtures/real-app-network.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const rows = [];
for (const oneWayDelayMs of [0, 25]) {
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    server.on('connection', socket => socket.on('message', data => socket.send(data, { binary: false })));
    await once(server, 'listening'); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const network = createRealAppNetwork(true, cleanup, oneWayDelayMs);
    const endpoint = await network.protect('policy-observer', `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const started = performance.now();
    const socket = new WebSocket(endpoint, { ca: readFileSync(realAppTestCa), perMessageDeflate: false, followRedirects: false });
    cleanup.push(() => socket.terminate()); await once(socket, 'open');
    const openingMs = performance.now() - started, roundTripsMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const payload = 'x'.repeat(i % 2 ? 5000 : 200), began = performance.now(), reply = once(socket, 'message');
      socket.send(payload); const [data] = await reply; assert.equal(data.toString(), payload);
      roundTripsMs.push(performance.now() - began);
    }
    rows.push({ oneWayDelayMs, openingMs, roundTripsMs, transport: network.snapshot() });
  } finally { for (const close of cleanup.reverse()) await close(); }
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[4] + sorted[5]) / 2; };
// A calibration screen, not an Internet model: no application work or competing
// workloads. Report an overloaded host rather than widening this screen.
const addedMedianRoundTripMs = median(rows[1].roundTripsMs) - median(rows[0].roundTripsMs);
const passed = addedMedianRoundTripMs >= 49 && addedMedianRoundTripMs <= 65;
const report = { measuredAt: new Date().toISOString(), rows, addedMedianRoundTripMs, passed,
  scope: 'Real WSS; two 25 ms ordered stream delays. TCP_NODELAY on fixture hops. No packet loss, TCP setup latency, bandwidth or Internet claim.' };
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2)); if (!passed) process.exitCode = 1;
