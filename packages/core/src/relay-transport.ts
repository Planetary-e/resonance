import { BlockList, isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { RequestOptions } from 'node:https';

/** TLS still validates trust, dates and signatures before this hostname check.
 * Node 24.19's IDNA conversion loses IPv6 literals (nodejs/node#64144). Match
 * those only against the authenticated certificate's exact iPAddress SAN using
 * OpenSSL; retain Node's normal DNS/IDNA and IPv4 checks without modification. */
export function checkRelayTlsServerIdentity(hostname: string, certificate: PeerCertificate): Error | undefined {
  if (isIP(hostname) !== 6) return checkServerIdentity(hostname, certificate);
  try {
    if (certificate.raw && new X509Certificate(certificate.raw).checkIP(hostname)) return;
  } catch { /* Missing or malformed DER cannot establish an IP identity. */ }
  const error: NodeJS.ErrnoException = new Error('TLS certificate does not authenticate the requested IPv6 address');
  error.code = 'ERR_TLS_CERT_ALTNAME_INVALID'; return error;
}

// Use the Node HTTPS contract: the installed @types/ws declaration incorrectly
// types this forwarded TLS callback as accepting key material and returning boolean.
export const relayTlsClientOptions: Readonly<RequestOptions> = Object.freeze({ checkServerIdentity: checkRelayTlsServerIdentity });

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

/** A cleartext listener may accept only loopback and private-LAN source IPs. */
export function isPrivateRelayAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(normalized) !== 0 && isPrivateRelayHost(normalized);
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
