import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createRealAppNetwork, realAppTestCa } from './real-app-network.js';
import { createRelayTestDelay, RELAY_TEST_DELAY_WINDOW_BYTES } from '../../packages/relay/src/__tests__/fixtures/relay-test-delay.js';

async function echo(cleanup: Array<() => void | Promise<void>>) {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    connections++; sockets.add(socket); socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket)); socket.pipe(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); for (const socket of sockets) socket.destroy();
  }));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}
async function exchange(socket: Socket, value: string) {
  const received: Buffer[] = [];
  let length = 0;
  socket.on('data', bytes => {
    const chunk = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    received.push(chunk); length += chunk.length;
    if (length >= Buffer.byteLength(value)) socket.end();
  });
  const finished = once(socket, 'close'); socket.write(value); await finished;
  expect(Buffer.concat(received).toString()).toBe(value);
}

it('counts both stream directions exactly and retains totals across endpoint restarts', async () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const backend = await echo(cleanup), network = createRealAppNetwork(false, cleanup);
    const endpoint = await network.address('entry'); endpoint.forwardTo(backend.port);
    await exchange(connect(endpoint.port, '127.0.0.1'), 'abc');
    endpoint.disconnect(); endpoint.forwardTo(backend.port);
    await exchange(connect(endpoint.port, '127.0.0.1'), '12345');
    expect(network.snapshot()).toEqual({ encrypted: false, tcpNoDelay: true, simulatedOneWayDelayMs: 0, scope: 'private-route-only', connections: 2, tcpStreamBytes: 16,
      stages: [], activeStages: 0, droppedStages: 0,
      categories: [{ category: 'entry', endpoints: 1, connections: 2, clientToServerBytes: 8, serverToClientBytes: 8 }] });
  } finally { for (const close of cleanup.reverse()) await close(); }
});

it('delays an ordered burst once instead of accumulating one delay for every chunk', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const stream = createRelayTestDelay(40), received: Array<{ value: string; time: number }> = [];
  stream.output.on('data', bytes => received.push({ value: bytes.toString(), time: performance.now() }));
  const finished = once(stream.output, 'end');
  try {
    const burst = Array.from({ length: 8 }, (_, i) => `chunk-${i}`);
    for (const value of burst) stream.input.write(value);
    stream.input.end();
    await vi.advanceTimersByTimeAsync(39); expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual(burst.map(value => ({ value, time: 40 })));
    await finished;
  } finally { stream.close(); vi.useRealTimers(); }
});

it('delivers a fragmented 512 KiB frame within one delay window', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const stream = createRelayTestDelay(40), received: Buffer[] = [], times: number[] = [];
  stream.output.on('data', bytes => { received.push(bytes); times.push(performance.now()); });
  const chunks = Array.from({ length: 32 }, (_, i) => Buffer.alloc(16 * 1024, i));
  const finished = once(stream.output, 'end');
  try {
    for (const chunk of chunks) stream.input.write(chunk);
    stream.input.end();
    await vi.advanceTimersByTimeAsync(39); expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await finished;
    expect(Buffer.concat(received)).toEqual(Buffer.concat(chunks));
    expect(times).toEqual(chunks.map(() => 40));
  } finally { stream.close(); vi.useRealTimers(); }
});

it('does not enqueue zero-byte chunks or add a delay for them', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const stream = createRelayTestDelay(40), received: string[] = [];
  stream.output.on('data', bytes => received.push(bytes.toString()));
  const finished = once(stream.output, 'end');
  try {
    for (let i = 0; i < 2048; i++) stream.input.write(Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
    stream.input.end('kept');
    await vi.advanceTimersByTimeAsync(40); await finished;
    expect(received).toEqual(['kept']);
  } finally { stream.close(); vi.useRealTimers(); }
});

it('bounds admitted bytes and resumes blocked callbacks when a slow consumer drains', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const stream = createRelayTestDelay(40), chunkBytes = 16 * 1024;
  const admittedChunks = RELAY_TEST_DELAY_WINDOW_BYTES / chunkBytes;
  const chunks = Array.from({ length: admittedChunks + 4 }, (_, i) => Buffer.alloc(chunkBytes, i));
  const completed: number[] = [], received: Buffer[] = [], times: number[] = [];
  const drained = once(stream.input, 'drain'), finished = once(stream.output, 'end');
  try {
    // The bounded producer stops on the first false return, including Node's
    // separate 64 KiB Writable margin beyond the admitted byte window.
    const writable = chunks.map((chunk, i) => stream.input.write(chunk, () => { completed.push(i); }));
    expect(writable.slice(0, -1).every(Boolean)).toBe(true); expect(writable.at(-1)).toBe(false);
    stream.output.read(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(completed).toHaveLength(admittedChunks);
    expect(stream.input.writableLength).toBe(64 * 1024);
    expect(stream.output.readableLength).toBe(64 * 1024);
    stream.output.on('data', bytes => { received.push(bytes); times.push(performance.now()); });
    await vi.advanceTimersByTimeAsync(0); await drained;
    expect(completed).toHaveLength(chunks.length);
    expect(Buffer.concat(received).length).toBe(RELAY_TEST_DELAY_WINDOW_BYTES);
    stream.input.end();
    await vi.advanceTimersByTimeAsync(39);
    expect(Buffer.concat(received).length).toBe(RELAY_TEST_DELAY_WINDOW_BYTES);
    await vi.advanceTimersByTimeAsync(1); await finished;
    expect(Buffer.concat(received)).toEqual(Buffer.concat(chunks));
    expect(times.every(time => time === 40 || time === 80)).toBe(true);
  } finally { stream.close(); vi.useRealTimers(); }
});

it.each(['close', 'output-destroy'] as const)('cancels timers and settles blocked writes without late bytes through %s', async how => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const stream = createRelayTestDelay(40), callbacks: Array<Error | null | undefined> = [], received: Buffer[] = [];
  const chunk = Buffer.alloc(16 * 1024), count = RELAY_TEST_DELAY_WINDOW_BYTES / chunk.length + 4;
  try {
    for (let i = 0; i < count; i++) stream.input.write(chunk, error => { callbacks.push(error); });
    stream.output.read(0); await vi.advanceTimersByTimeAsync(0);
    expect(callbacks).toHaveLength(count - 4); expect(vi.getTimerCount()).toBe(1);
    const inputClosed = once(stream.input, 'close'), outputClosed = once(stream.output, 'close');
    if (how === 'close') stream.close(); else stream.output.destroy();
    await Promise.all([inputClosed, outputClosed]);
    stream.output.on('data', bytes => received.push(bytes));
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks).toHaveLength(count);
    expect(stream.input.writableLength).toBe(0);
    expect(received).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    expect(stream.input.destroyed && stream.output.destroyed).toBe(true);
  } finally { stream.close(); vi.useRealTimers(); }
});

it('refuses a chunk larger than the admitted byte window', async () => {
  const stream = createRelayTestDelay(40);
  const inputError = once(stream.input, 'error'), outputError = once(stream.output, 'error');
  try {
    stream.input.write(Buffer.alloc(RELAY_TEST_DELAY_WINDOW_BYTES + 1));
    const [[incoming], [outgoing]] = await Promise.all([inputError, outputError]);
    expect(incoming).toBeInstanceOf(RangeError); expect(outgoing).toBe(incoming);
    expect(incoming.message).toBe('Test delay chunk exceeds its byte window');
  } finally { stream.close(); }
});

it('counts encrypted handshakes while refusing an untrusted CA before the backend opens', async () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const backend = await echo(cleanup), network = createRealAppNetwork(true, cleanup);
    const endpoint = new URL(await network.protect('policy-history', `ws://127.0.0.1:${backend.port}/history-checkpoint`));
    expect(endpoint.protocol).toBe('wss:'); expect(endpoint.pathname).toBe('/history-checkpoint');
    const refused = connectTls({ host: '127.0.0.1', port: Number(endpoint.port), ca: [] });
    await once(refused, 'error'); expect(backend.connections()).toBe(0);
    const socket = connectTls({ host: '127.0.0.1', port: Number(endpoint.port), ca: readFileSync(realAppTestCa) });
    await once(socket, 'secureConnect'); expect(socket.authorized).toBe(true);
    await exchange(socket, 'hello');
    const measured = network.snapshot();
    expect(backend.connections()).toBe(1); expect(measured.encrypted).toBe(true);
    expect(measured.connections).toBe(2); expect(measured.tcpStreamBytes).toBeGreaterThan(1000);
    expect(measured.categories[0].clientToServerBytes).toBeGreaterThan(5);
    expect(measured.categories[0].serverToClientBytes).toBeGreaterThan(5);
  } finally { for (const close of cleanup.reverse()) await close(); }
});
