import { BlockList, isIP } from 'node:net';

const privateIpv6 = new BlockList();
privateIpv6.addSubnet('fc00::', 7, 'ipv6');
privateIpv6.addSubnet('fe80::', 10, 'ipv6');

/** Reject cleartext WebSocket connections outside loopback and private LANs. */
export function assertSecureRelayTransportEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid relay endpoint');
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid relay endpoint');
  }
  if (url.protocol === 'wss:') return;
  if (url.protocol !== 'ws:' || !isPrivateRelayHost(url.hostname)) {
    throw new Error('Internet-facing relay endpoints require wss://');
  }
}

function isPrivateRelayHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1) : hostname;
  const family = isIP(host);
  if (family === 6) return host === '::1' || privateIpv6.check(host, 'ipv6');
  if (family !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 127 || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}
