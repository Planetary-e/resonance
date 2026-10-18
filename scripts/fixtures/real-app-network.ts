/** Local measurement fixture. Public test credentials must never be deployed. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createRelayTestEndpoints, type RelayTestEndpoint } from '../../packages/relay/src/__tests__/fixtures/relay-test-endpoint.js';

export const realAppTestCa = fileURLToPath(new URL('../../packages/relay/src/__tests__/fixtures/tls/test-ca.crt', import.meta.url));
type Cleanup = Array<() => void | Promise<void>>;
type Category = 'entry' | 'destination' | 'witness' | 'policy-observer' | 'policy-history' | 'admission-history';

export function createRealAppNetwork(encrypted: boolean, cleanup: Cleanup) {
  const read = (name: string) => readFileSync(new URL(`../../packages/relay/src/__tests__/fixtures/tls/${name}`, import.meta.url));
  const tls = encrypted ? { cert: read('localhost.crt'), key: read('localhost.key') } : undefined;
  const endpoints: Array<{ category: Category; endpoint: RelayTestEndpoint }> = [];
  async function address(category: Category, host: '127.0.0.1' | '::1' = '127.0.0.1') {
    const [endpoint] = await createRelayTestEndpoints(1, host); cleanup.push(endpoint.close);
    endpoints.push({ category, endpoint });
    return { ...endpoint, url: `${encrypted ? 'wss' : 'ws'}://${host === '::1' ? '[::1]' : host}:${endpoint.port}/` };
  }
  /** Terminate test TLS at a loopback proxy for existing loopback-only services.
   * Counts are taken before TLS termination, never on the decrypted backend leg. */
  async function protect(category: Category, endpoint: string) {
    if (!tls) return endpoint;
    const backend = new URL(endpoint);
    assert.equal(backend.protocol, 'ws:'); assert.equal(backend.hostname, '127.0.0.1');
    const sockets = new Set<Socket>(); let closing: Promise<void> | undefined;
    const server = createServer({ ...tls, handshakeTimeout: 10000 }, client => {
      const upstream = connect(Number(backend.port), '127.0.0.1'); sockets.add(upstream);
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.pipe(upstream); upstream.pipe(client);
    });
    server.on('connection', socket => {
      sockets.add(socket); socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanup.push(() => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    }));
    const frontend = await address(category); frontend.forwardTo((server.address() as AddressInfo).port);
    const result = new URL(frontend.url); result.pathname = backend.pathname; return result.href;
  }
  function snapshot() {
    const rows = endpoints.map(({ category, endpoint }) => ({ category, ...endpoint.traffic() }));
    const categories = [...new Set(rows.map(row => row.category))].map(category => {
      const selected = rows.filter(row => row.category === category);
      return { category, endpoints: selected.length, connections: selected.reduce((n, row) => n + row.connections, 0),
        clientToServerBytes: selected.reduce((n, row) => n + row.clientToServerBytes, 0),
        serverToClientBytes: selected.reduce((n, row) => n + row.serverToClientBytes, 0) };
    });
    return { encrypted, scope: encrypted ? 'all-exposed-peer-endpoints' : 'private-route-only', categories,
      connections: categories.reduce((n, row) => n + row.connections, 0),
      tcpStreamBytes: categories.reduce((n, row) => n + row.clientToServerBytes + row.serverToClientBytes, 0) };
  }
  return { tls, address, protect, snapshot };
}
export type RealAppNetwork = ReturnType<typeof createRealAppNetwork>;
