/** Opt-in loopback component measurement. Public test TLS keys; never production credentials. */
import { readFileSync } from 'node:fs';
import { createServer as tcpServer, connect as tcpConnect, type Socket, type AddressInfo } from 'node:net';
import { createServer as tlsServer, connect as tlsConnect, type TLSSocket } from 'node:tls';
import { performance } from 'node:perf_hooks';

export const TLS_SCHEDULE = Object.freeze({ slotMs: 125, durationMs: 12000, submissionMs: 1025, deadlineMs: 10000,
  payloadBytes: 768, frameBytes: 800, streamBudget: 1024, provisionalTlsReserve: 224, maxQueueCells: 128 });
export type TlsScheduleCase = 'idle' | 'D0' | 'D1000' | 'D12000';
export function tlsScheduleCredentials() {
  const read = (name: string) => readFileSync(new URL(`../../relay/src/__tests__/fixtures/tls/${name}`, import.meta.url));
  return { cert: read('localhost.crt'), key: read('localhost.key'), ca: read('test-ca.crt') };
}
export function preflightTlsSchedule(budget = 1024) {
  if (!Number.isSafeInteger(budget) || budget < TLS_SCHEDULE.frameBytes + TLS_SCHEDULE.provisionalTlsReserve || budget > 1024) throw new Error('Preflight stream budget refused');
  return { frameBytes: 800, provisionalTlsReserve: 224, streamBudget: budget, runtimeWireCapProven: false };
}
/** Return only the current slot; missed slots never produce catch-up writes. */
export function currentTlsSlot(elapsedMs: number, previous: number, total = 96) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isSafeInteger(previous) || previous < -1) throw new Error('Invalid slot clock');
  const tick = Math.floor(elapsedMs / 125);
  return tick >= total || tick <= previous ? null : { tick, skipped: tick - previous - 1, latenessMs: elapsedMs - tick * 125 };
}
export function createTlsDeadlineGuard(now: () => number, deadline: number, expire: () => void) {
  let expired = false;
  return () => { if (now() < deadline && !expired) return true; if (!expired) { expired = true; expire(); } return false; };
}
export function writeTlsCell(socket: { destroyed: boolean; writableLength: number; write(bytes: Buffer): boolean }, frame: Buffer, permit?: () => boolean) {
  if (permit && !permit()) return false;
  if (socket.destroyed || socket.writableLength !== 0 || !socket.write(frame)) throw new Error('Backpressure: fail session');
  return true;
}
export function fragmentTlsPayload(bytes: Buffer, kind: 1 | 2) {
  if (bytes.length < 1 || bytes.length > 65536) throw new Error('Invalid payload bound');
  const count = Math.ceil(bytes.length / 768);
  return Array.from({ length: count }, (_, index) => {
    const frame = Buffer.alloc(800), payload = bytes.subarray(index * 768, (index + 1) * 768);
    frame.writeUInt32BE(0x52534c54, 0); frame[4] = kind; frame.writeUInt16BE(index, 5);
    frame.writeUInt16BE(count, 7); frame.writeUInt16BE(payload.length, 9); payload.copy(frame, 16); return frame;
  });
}
export function createTlsReassembler(expected: Buffer, kind: 1 | 2) {
  let next = 0; const parts: Buffer[] = [], count = Math.ceil(expected.length / 768);
  return (frame: Buffer) => {
    if (frame.length !== 800 || frame.readUInt32BE(0) !== 0x52534c54 || frame[4] !== kind
      || frame.readUInt16BE(5) !== next || frame.readUInt16BE(7) !== count) throw new Error('Invalid fragment sequence');
    const length = frame.readUInt16BE(9), required = Math.min(768, expected.length - next * 768);
    if (next >= count || length !== required) throw new Error('Invalid fragment length');
    const part = frame.subarray(16, 16 + length);
    if (!part.equals(expected.subarray(next * 768, next * 768 + length))) throw new Error('Payload verification failed');
    parts.push(Buffer.from(part)); next++;
    return next === count ? Buffer.concat(parts) : null;
  };
}
type Trace = { edge: number; direction: 'up' | 'down'; atMs: number; bytes: number; phase: string; slot: number | null };
async function listen(server: ReturnType<typeof tcpServer> | ReturnType<typeof tlsServer>) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return (server.address() as AddressInfo).port;
}
export async function runPrivateScheduleTls(options: { case: TlsScheduleCase; budgetBytesPerDirectionSlot?: number }) {
  if (!['idle', 'D0', 'D1000', 'D12000'].includes(options.case)) throw new Error('Invalid frozen case');
  const budget = preflightTlsSchedule(options.budgetBytesPerDirectionSlot), credentials = tlsScheduleCredentials();
  const began = performance.now(), cpuStart = process.cpuUsage(); let peakRss = process.memoryUsage().rss;
  let sessionStart: number | null = null, phase = 'startup', active = false, terminal = options.case === 'idle';
  let completedAtMs: number | null = null, failure: string | null = null, operationFailure: string | null = null;
  let traceDropped = 0, skippedSlots = 0, realCells = 0, dummyCells = 0, lastTick = -1;
  const trace: Trace[] = [], failures: string[] = [], errors: string[] = [], latenessMs: number[] = [];
  const totals = [0, 0, 0, 0], sockets = new Set<Socket>(), servers: Array<ReturnType<typeof tcpServer> | ReturnType<typeof tlsServer>> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let serviceTimer: ReturnType<typeof setTimeout> | undefined;
  const lanes: Array<Array<{ frame: Buffer; eligible: number }>> = [[], [], [], []];
  const writes: Array<{ lane: number; tick: number; atMs: number; real: boolean }> = [];
  const request = Buffer.from(Array.from({ length: 15495 }, (_, i) => i % 251));
  const reply = Buffer.from(Array.from({ length: 11213 }, (_, i) => (i * 7) % 251));
  const receiveRequest = createTlsReassembler(request, 1), receiveReply = createTlsReassembler(reply, 2);
  const processingMs = options.case === 'D1000' ? 1000 : options.case === 'D12000' ? 12000 : 0;
  const elapsed = () => sessionStart === null ? 0 : performance.now() - sessionStart;
  function later(callback: () => void, delay: number) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, Math.max(0, delay)); timers.add(timer); return timer;
  }
  const beforeDeadline = createTlsDeadlineGuard(elapsed, 11025, () => {
    if (!terminal) { terminal = true; operationFailure = 'original-deadline'; }
    if (serviceTimer) { clearTimeout(serviceTimer); timers.delete(serviceTimer); }
  });
  function fail(reason: string) {
    if (!failure) failure = reason; failures.push(reason); active = false;
    if (!terminal && options.case !== 'idle') { terminal = true; operationFailure = reason; }
  }
  function addSocket(socket: Socket) { sockets.add(socket); socket.on('error', error => { errors.push(error.message); if (phase !== 'shutdown') fail(`socket: ${error.message}`); }); socket.once('close', () => sockets.delete(socket)); return socket; }
  function enqueue(lane: number, frame: Buffer) {
    if (terminal || !active || !beforeDeadline()) return;
    if (lanes[lane].length >= 128) { fail('queue-bound'); return; }
    lanes[lane].push({ frame, eligible: Math.floor(elapsed() / 125) + 1 });
  }
  function deliver(lane: number, frame: Buffer) {
    if (frame.every(byte => byte === 0)) return;
    if (terminal || !active || !beforeDeadline()) return;
    try {
      if (lane === 0) enqueue(1, frame);
      else if (lane === 1 && receiveRequest(frame)) {
        serviceTimer = later(() => { if (!terminal && active && beforeDeadline()) for (const part of fragmentTlsPayload(reply, 2)) enqueue(2, part); }, processingMs);
      } else if (lane === 2) enqueue(3, frame);
      else if (lane === 3 && receiveReply(frame)) {
        completedAtMs = elapsed(); terminal = true;
      }
    } catch (error) { fail((error as Error).message); }
  }
  function decoder(socket: TLSSocket, lane: number) {
    let pending = Buffer.alloc(0);
    socket.on('data', (bytes: Buffer) => {
      if (pending.length + bytes.length > 65536) { fail('receive-buffer-bound'); return; }
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 800) { const frame = pending.subarray(0, 800); pending = pending.subarray(800); deliver(lane, frame); }
    });
  }
  async function edge(edgeIndex: number) {
    let accept!: (socket: TLSSocket) => void; const accepted = new Promise<TLSSocket>(resolve => { accept = resolve; });
    const server = tlsServer({ cert: credentials.cert, key: credentials.key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => { addSocket(socket); accept(socket); });
    server.on('tlsClientError', error => fail(`TLS server: ${error.message}`)); servers.push(server); const target = await listen(server);
    const proxy = tcpServer(client => {
      addSocket(client); const upstream = addSocket(tcpConnect(target, '127.0.0.1'));
      client.setNoDelay(true); upstream.setNoDelay(true);
      function record(direction: 'up' | 'down', bytes: Buffer) {
        const atMs = performance.now() - began; totals[edgeIndex * 2 + (direction === 'down' ? 1 : 0)] += bytes.length;
        if (trace.length >= 8192) { traceDropped++; fail('trace-bound'); return; }
        trace.push({ edge: edgeIndex, direction, atMs, bytes: bytes.length, phase, slot: sessionStart === null || phase !== 'session' ? null : Math.floor(elapsed() / 125) });
      }
      client.on('data', bytes => record('up', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))); upstream.on('data', bytes => record('down', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
      client.pipe(upstream); upstream.pipe(client); client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    }); servers.push(proxy); const port = await listen(proxy);
    const outgoing = addSocket(tlsConnect({ port, host: '127.0.0.1', servername: 'localhost', ca: credentials.ca,
      rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' })) as TLSSocket;
    outgoing.setNoDelay(true);
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([new Promise<void>((resolve, reject) => { outgoing.once('secureConnect', () => outgoing.authorized ? resolve() : reject(new Error('Unauthorized TLS'))); outgoing.once('error', reject); }), accepted]),
      new Promise<never>((_, reject) => { setupTimer = later(() => reject(new Error('TLS setup deadline')), 3000); })]).finally(() => { if (setupTimer) { clearTimeout(setupTimer); timers.delete(setupTimer); } });
    return { outgoing, incoming: await accepted };
  }
  try {
    const first = await edge(0), second = await edge(1);
    const senders = [first.outgoing, second.outgoing, second.incoming, first.incoming];
    decoder(first.incoming, 0); decoder(second.incoming, 1); decoder(second.outgoing, 2); decoder(first.outgoing, 3);
    sessionStart = performance.now(); phase = 'session'; active = failure === null;
    if (options.case !== 'idle') {
      later(() => { if (!terminal && active) for (const frame of fragmentTlsPayload(request, 1)) enqueue(0, frame); }, 1025);
      later(() => { beforeDeadline(); }, 11025);
    }
    await new Promise<void>(resolve => {
      function tick() {
        if (elapsed() >= 12000) { resolve(); return; }
        if (options.case !== 'idle' && !terminal) beforeDeadline();
        const slot = currentTlsSlot(elapsed(), lastTick);
        if (slot) {
          skippedSlots += slot.skipped; lastTick = slot.tick; latenessMs.push(slot.latenessMs); peakRss = Math.max(peakRss, process.memoryUsage().rss);
          const chosen = lanes.map(lane => !terminal && lane[0]?.eligible <= slot.tick ? lane.shift()!.frame : null);
          senders.forEach((socket, lane) => {
            if (!active) return;
            try {
              const real = chosen[lane] !== null && writeTlsCell(socket, chosen[lane]!, beforeDeadline);
              if (!real) writeTlsCell(socket, Buffer.alloc(800));
              real ? realCells++ : dummyCells++; writes.push({ lane, tick: slot.tick, atMs: elapsed(), real });
            }
            catch (error) { fail((error as Error).message); }
          });
        }
        later(tick, Math.min(12000 - elapsed(), Math.max(1, (lastTick + 1) * 125 - elapsed())));
      }
      tick();
    });
    if (options.case !== 'idle' && !terminal) { terminal = true; operationFailure = 'session-end'; }
  } catch (error) { fail((error as Error).message); }
  finally {
    active = false; phase = 'shutdown'; for (const timer of timers) clearTimeout(timer); timers.clear();
    for (const socket of sockets) if (socket instanceof Object && 'encrypted' in socket) socket.end();
    await new Promise<void>(resolve => setTimeout(resolve, 75));
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.reverse().map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const cpu = process.cpuUsage(cpuStart), submitted = options.case === 'idle' ? 0 : 1;
  const completed = completedAtMs === null ? 0 : 1, latencyMs = completedAtMs === null ? null : completedAtMs - 1025;
  const rawStreamBytes = totals.reduce((sum, bytes) => sum + bytes, 0);
  const buckets = new Map<string, number>();
  for (const row of trace) if (row.slot !== null && row.slot >= 0 && row.slot < 96) {
    const key = `${row.edge}:${row.direction}:${row.slot}`; buckets.set(key, (buckets.get(key) ?? 0) + row.bytes);
  }
  return { case: options.case, classification: 'tls-loopback-component-only', budget, profile: TLS_SCHEDULE,
    submitted, completed, failed: submitted - completed, operation: submitted ? { latencyMs, infiniteLatency: !completed, failure: operationFailure, payloadVerified: completed === 1 } : null,
    failures, failure, socketErrors: errors, rawStreamBytes, directionBytes: totals, trace, traceDropped, writes,
    maxObservedSessionDirectionSlotBytes: Math.max(0, ...buckets.values()), sessionDirectionSlotOverruns: [...buckets.values()].filter(bytes => bytes > 1024).length,
    realCells, dummyCells, skippedSlots, timerLatenessMs: latenessMs,
    process: { cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, peakSampledRssBytes: peakRss, wallMs: performance.now() - began },
    bytesPerCompletion: completed ? { value: rawStreamBytes, reason: null } : { value: null, reason: 'infinite-zero-completions' },
    limitations: ['One process, loopback, diagnostic stream scheduling only; no reference-device, packet-loss, K1/K7, privacy/AUC or energy qualification.',
      'Raw proxy counts each TLS edge once, including handshake/shutdown, excluding IP/TCP headers, ACKs and retransmissions.',
      'No MPC, admission, policy, history, other-edge reserve, reconnect or role-isolated resource measurement.',
      'Preflight reserve is a proposed budget; observed stream chunks/slot bins do not enforce a runtime wire cap.'] };
}
