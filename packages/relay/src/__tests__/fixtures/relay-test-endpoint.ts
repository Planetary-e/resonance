/** Keep an OS-reserved test address through relay outages and restarts. */
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
export interface RelayTestEndpoint {
  port: number; forwardTo(port: number): void; disconnect(): void; close(): Promise<void>;
}
export async function createRelayTestEndpoints(count: number): Promise<RelayTestEndpoint[]> {
  const endpoints: RelayTestEndpoint[] = [];
  try {
    for (let index = 0; index < count; index++) {
      let target: number | undefined, closed = false;
      const sockets = new Set<Socket>();
      const server = createServer(client => {
        client.on('error', () => client.destroy());
        if (target === undefined) { client.destroy(); return; }
        const upstream = connect(target, '127.0.0.1');
        sockets.add(client); sockets.add(upstream);
        client.pipe(upstream); upstream.pipe(client);
        client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
        client.on('close', () => { sockets.delete(client); upstream.destroy(); });
        upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      });
      const disconnect = () => { target = undefined; for (const socket of sockets) socket.destroy(); };
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      endpoints.push({ port: (server.address() as AddressInfo).port,
        forwardTo(port) {
          if (closed || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid test upstream');
          disconnect(); target = port;
        }, disconnect,
        async close() {
          if (closed) return; closed = true; disconnect();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
      });
    }
    return endpoints;
  } catch (error) { await Promise.all(endpoints.map(endpoint => endpoint.close())); throw error; }
}
