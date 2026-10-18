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
async function echoBurst(socket: WebSocket, payloads: string[]) {
  const began = performance.now();
  await new Promise<void>((resolve, reject) => {
    let received = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer); socket.off('message', message); socket.off('error', failed); socket.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const failed = (error: Error) => finish(error), closed = () => finish(new Error('Calibration socket closed'));
    const message = (data: WebSocket.RawData) => {
      try { assert.equal(data.toString(), payloads[received++]); if (received === payloads.length) finish(); }
      catch (error) { finish(error as Error); }
    };
    const timer = setTimeout(() => finish(new Error('Calibration echo timed out')), 5000);
    socket.on('message', message); socket.once('error', failed); socket.once('close', closed);
    try { for (const payload of payloads) socket.send(payload); } catch (error) { finish(error as Error); }
  });
  return performance.now() - began;
}
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
    const openingMs = performance.now() - started, roundTripsMs: number[] = [], burstRoundTripsMs: number[] = [], largeRoundTripsMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      roundTripsMs.push(await echoBurst(socket, ['x'.repeat(i % 2 ? 5000 : 200)]));
    }
    // Small sequential echoes alone miss delay that depends on stream fragmentation.
    // Both cases fit the explicit fixture window, with no consumer stall.
    for (let i = 0; i < 10; i++) burstRoundTripsMs.push(await echoBurst(socket,
      Array.from({ length: 8 }, (_, j) => `${i}:${j}:` + 'x'.repeat(252))));
    for (let i = 0; i < 10; i++) largeRoundTripsMs.push(await echoBurst(socket, ['x'.repeat(256 * 1024)]));
    rows.push({ oneWayDelayMs, openingMs, roundTripsMs, burstRoundTripsMs, largeRoundTripsMs, transport: network.snapshot() });
  } finally { for (const close of cleanup.reverse()) await close(); }
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[4] + sorted[5]) / 2; };
// A calibration screen, not an Internet model: no application work or competing
// workloads. Report an overloaded host rather than widening this screen.
const addedMedianRoundTripMs = median(rows[1].roundTripsMs) - median(rows[0].roundTripsMs);
const checks = [
  { scenario: 'sequential-200-5000-byte', addedMedianRoundTripMs },
  { scenario: 'burst-eight-256-byte-frames', addedMedianRoundTripMs: median(rows[1].burstRoundTripsMs) - median(rows[0].burstRoundTripsMs) },
  { scenario: 'single-256-KiB-frame', addedMedianRoundTripMs: median(rows[1].largeRoundTripsMs) - median(rows[0].largeRoundTripsMs) },
].map(check => ({ ...check, passed: check.addedMedianRoundTripMs >= 49 && check.addedMedianRoundTripMs <= 65 }));
const passed = checks.every(check => check.passed);
const report = { measuredAt: new Date().toISOString(), rows, addedMedianRoundTripMs, checks, passed,
  scope: 'Real WSS; two 25 ms ordered stream delays. TCP_NODELAY on fixture hops. Ten samples per scenario. Calibration bursts fit the bounded fixture window. No packet loss, TCP setup latency, sustained bandwidth or Internet claim.' };
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2)); if (!passed) process.exitCode = 1;
