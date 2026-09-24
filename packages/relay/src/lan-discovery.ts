/** Optional one-hop LAN hint exchange. A beacon is never a trusted descriptor. */

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

const GROUP = '239.255.76.83';
const PORT = 49_483;
const PREFIX = 'resonance-lan-v1:';
const MAX_BEACON_BYTES = 64;

export function localRelayEndpoints(port: number): string[] {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('Invalid LAN relay port');
  }
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isIP(entry.address) === 4) {
        addresses.add(`ws://${entry.address}:${port}/`);
      }
    }
  }
  return [...addresses].sort();
}

export function parseLanBeacon(data: Buffer, senderAddress: string): string | null {
  if (data.length > MAX_BEACON_BYTES || isIP(senderAddress) !== 4) return null;
  const raw = data.toString('utf8');
  if (!raw.startsWith(PREFIX)) return null;
  const portText = raw.slice(PREFIX.length);
  if (!/^[0-9]{4,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1024 || port > 65_535) return null;
  return `ws://${senderAddress}:${port}/`;
}

export interface LanDiscovery {
  stop(): Promise<void>;
}

export async function startLanDiscovery(
  relayPort: number,
  ownEndpoints: readonly string[],
  onHint: (endpoint: string) => void,
  onTraffic?: (direction: 'ingress' | 'egress', bytes: number) => void,
): Promise<LanDiscovery> {
  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
  // Multicast is a best-effort hint channel. A later socket error must not
  // terminate the relay or leave an unhandled EventEmitter error.
  socket.on('error', () => { /* Keep the relay running without LAN hints. */ });
  const lastHint = new Map<string, number>();
  socket.on('message', (data, remote) => {
    try { onTraffic?.('ingress', data.length); } catch { /* Metering must not stop discovery. */ }
    const endpoint = parseLanBeacon(data, remote.address);
    if (!endpoint || ownEndpoints.includes(endpoint)) return;
    const now = Date.now();
    if ((lastHint.get(endpoint) ?? 0) > now - 60_000) return;
    if (lastHint.size >= 64) {
      for (const [key, seenAt] of lastHint) {
        if (seenAt <= now - 60_000) lastHint.delete(key);
      }
      if (lastHint.size >= 64) lastHint.delete(lastHint.keys().next().value!);
    }
    lastHint.set(endpoint, now);
    try { onHint(endpoint); } catch { /* A hint must not stop the listener. */ }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onBindError = (error: Error): void => reject(error);
      socket.once('error', onBindError);
      socket.bind(PORT, '0.0.0.0', () => {
        socket.off('error', onBindError);
        resolve();
      });
    });
    socket.addMembership(GROUP);
    socket.setMulticastTTL(1);
    socket.setMulticastLoopback(true);
  } catch (error) {
    socket.close();
    throw error;
  }
  const beacon = Buffer.from(`${PREFIX}${relayPort}`, 'ascii');
  const announce = (): void => {
    socket.send(beacon, PORT, GROUP, error => {
      if (!error) {
        try { onTraffic?.('egress', beacon.length); } catch { /* Keep discovery available. */ }
      }
    });
  };
  announce();
  const timer = setInterval(announce, 30_000);
  timer.unref();
  return {
    stop: () => new Promise<void>(resolve => {
      clearInterval(timer);
      socket.close(() => resolve());
    }),
  };
}
