import { expect, it } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createRealAppNetwork, realAppTestCa } from './real-app-network.js';

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
    received.push(bytes); length += bytes.length;
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
    expect(network.snapshot()).toEqual({ encrypted: false, scope: 'private-route-only', connections: 2, tcpStreamBytes: 16,
      categories: [{ category: 'entry', endpoints: 1, connections: 2, clientToServerBytes: 8, serverToClientBytes: 8 }] });
  } finally { for (const close of cleanup.reverse()) await close(); }
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
