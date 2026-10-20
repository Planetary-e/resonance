import { describe, expect, it } from 'vitest';
import { createServer, connect, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { createTlsDeadlineGuard, createTlsReassembler, currentTlsSlot, fragmentTlsPayload, preflightTlsSchedule, tlsScheduleCredentials, writeTlsCell } from '../private-schedule-tls.js';

describe('opt-in TLS schedule boundaries', () => {
  it('reassembles and verifies exact historical payloads, rejects mutation/reorder/duplicates', () => {
    for (const length of [15495, 11213, 1, 769]) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => i % 251)), frames = fragmentTlsPayload(bytes, 1);
      const receive = createTlsReassembler(bytes, 1);
      for (const frame of frames.slice(0, -1)) expect(receive(frame)).toBeNull();
      expect(receive(frames.at(-1)!)).toEqual(bytes);
      expect(() => receive(frames[0])).toThrow();
      const changed = Buffer.from(frames[0]); changed[16] ^= 1;
      expect(() => createTlsReassembler(bytes, 1)(changed)).toThrow('verification');
      if (frames.length > 1) expect(() => createTlsReassembler(bytes, 1)(frames[1])).toThrow('sequence');
      expect(frames.every(frame => frame.length === 800)).toBe(true);
    }
  });
  it('skips overdue slots once and emits no catch-up write for the same clock', () => {
    expect(currentTlsSlot(1, -1)).toEqual({ tick: 0, skipped: 0, latenessMs: 1 });
    expect(currentTlsSlot(510, 0)).toEqual({ tick: 4, skipped: 3, latenessMs: 10 });
    expect(currentTlsSlot(511, 4)).toBeNull(); expect(currentTlsSlot(12000, 95)).toBeNull();
  });
  it('fails backpressure, queued output and destroyed sockets without retry bursts', () => {
    let calls = 0;
    const socket = { destroyed: false, writableLength: 0, write() { calls++; return false; } };
    expect(() => writeTlsCell(socket, Buffer.alloc(800))).toThrow('Backpressure'); expect(calls).toBe(1);
    socket.writableLength = 1; expect(() => writeTlsCell(socket, Buffer.alloc(800))).toThrow(); expect(calls).toBe(1);
    socket.writableLength = 0; socket.destroyed = true; expect(() => writeTlsCell(socket, Buffer.alloc(800))).toThrow(); expect(calls).toBe(1);
  });
  it('checks the original monotonic deadline again at the real write, regardless of timer order', () => {
    let now = 11024, expired = 0, writes = 0;
    const guard = createTlsDeadlineGuard(() => now, 11025, () => { expired++; });
    const socket = { destroyed: false, writableLength: 0, write() { writes++; return true; } };
    expect(guard()).toBe(true); // Earlier selection/enqueue was still timely.
    now = 11025;
    expect(writeTlsCell(socket, Buffer.alloc(800), guard)).toBe(false);
    expect(writes).toBe(0); expect(expired).toBe(1);
    now = 12000; expect(guard()).toBe(false); expect(expired).toBe(1);
  });
  it('refuses insufficient preflight budget and does not claim runtime enforcement', () => {
    expect(() => preflightTlsSchedule(1023)).toThrow('refused');
    expect(() => preflightTlsSchedule(2048)).toThrow('refused');
    expect(preflightTlsSchedule()).toMatchObject({ runtimeWireCapProven: false, streamBudget: 1024 });
  });
  it('verifies the fixture CA and hostname, rejects wrong hostname and missing CA', async () => {
    const credentials = tlsScheduleCredentials(), sockets = new Set<TLSSocket>();
    const server = createServer({ cert: credentials.cert, key: credentials.key }, socket => { sockets.add(socket); socket.on('error', () => {}); });
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    async function attempt(servername: string, ca?: Buffer) {
      return new Promise<boolean>(resolve => {
        const socket = connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, servername, ca, rejectUnauthorized: true }); sockets.add(socket);
        socket.once('secureConnect', () => { resolve(socket.authorized); socket.destroy(); });
        socket.once('error', () => { resolve(false); socket.destroy(); });
      });
    }
    try { expect(await attempt('localhost', credentials.ca)).toBe(true); expect(await attempt('wrong.invalid', credentials.ca)).toBe(false); expect(await attempt('localhost')).toBe(false); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 5000);
});
