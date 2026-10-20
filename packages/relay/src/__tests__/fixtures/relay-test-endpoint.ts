/** Keep an OS-reserved test address through relay outages and restarts. */
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { createRelayTestDelay } from './relay-test-delay.js';
export interface RelayTestEndpoint {
  port: number; forwardTo(port: number): void; disconnect(): void; close(): Promise<void>;
  traffic(): { connections: number; clientToServerBytes: number; serverToClientBytes: number };
}
export async function createRelayTestEndpoints(count: number, host: '127.0.0.1' | '::1' = '127.0.0.1', delayMs = 0): Promise<RelayTestEndpoint[]> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('Invalid test network delay');
  const endpoints: RelayTestEndpoint[] = [];
  try {
    for (let index = 0; index < count; index++) {
      let target: number | undefined, closed = false;
      let connections = 0, clientToServerBytes = 0, serverToClientBytes = 0;
      const sockets = new Set<Socket>();
      const server = createServer(client => {
        client.setNoDelay(true);
        connections++;
        client.on('data', bytes => { clientToServerBytes += bytes.length; });
        client.on('error', () => client.destroy());
        if (target === undefined) { client.destroy(); return; }
        const upstream = connect(target, host);
        upstream.setNoDelay(true);
        upstream.on('data', bytes => { serverToClientBytes += bytes.length; });
        sockets.add(client); sockets.add(upstream);
        if (delayMs) {
          const request = createRelayTestDelay(delayMs), response = createRelayTestDelay(delayMs);
          client.pipe(request.input); request.output.pipe(upstream);
          upstream.pipe(response.input); response.output.pipe(client);
          const close = () => { request.close(); response.close(); };
          client.once('close', close); upstream.once('close', close);
        } else { client.pipe(upstream); upstream.pipe(client); }
        client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
        client.on('close', () => { sockets.delete(client); upstream.destroy(); });
        upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      });
      const disconnect = () => { target = undefined; for (const socket of sockets) socket.destroy(); };
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
      endpoints.push({ port: (server.address() as AddressInfo).port,
        traffic: () => ({ connections, clientToServerBytes, serverToClientBytes }),
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
