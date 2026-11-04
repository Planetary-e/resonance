/** Selection boundary for a private two-relay route. No traffic is sent here. */

import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { isRelayDescriptorActiveV1, type RelayDescriptorV1 } from './relay-discovery.js';
import { assertSecureRelayTransportEndpoint } from './relay-transport.js';

const MAX_ROUTE_CANDIDATES = 64;

export interface PrivateRouteCandidateV1 {
  /** Descriptor authenticated by the connection handshake, not a discovery hint. */
  descriptor: RelayDescriptorV1;
  /** Exact signed endpoint used for that authenticated connection. */
  endpoint: string;
  /** IP observed on the live transport socket, not a descriptor claim. */
  remoteAddress: string;
}

export interface PrivateRouteV1 {
  entry: PrivateRouteCandidateV1;
  destination: PrivateRouteCandidateV1;
}

/**
 * Choose an ordered pair of fresh, reachable relays with different identities
 * and observed network domains. Different IP domains do not prove different
 * operators; a caller must also verify that the entry can reach the destination.
 */
export function selectPrivateRouteV1(
  candidates: readonly PrivateRouteCandidateV1[],
  now = Date.now(),
): PrivateRouteV1 {
  if (!Array.isArray(candidates) || candidates.length > MAX_ROUTE_CANDIDATES
    || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid private route candidates');
  }

  const byRelay = new Map<string, { candidate: PrivateRouteCandidateV1; domain: string }>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.endpoint !== 'string'
      || typeof candidate.remoteAddress !== 'string'
      || !isRelayDescriptorActiveV1(candidate.descriptor, now)
      || candidate.descriptor.reachability !== 'direct'
      || !candidate.descriptor.endpoints.includes(candidate.endpoint)) continue;
    try { assertSecureRelayTransportEndpoint(candidate.endpoint); }
    catch { continue; }
    const domain = observedNetworkDomainV1(candidate.remoteAddress);
    if (!domain) continue;
    if (!byRelay.has(candidate.descriptor.relayId)) byRelay.set(candidate.descriptor.relayId, {
      candidate,
      domain,
    });
  }

  const eligible = [...byRelay.values()];
  const pairs: Array<[number, number]> = [];
  for (let entry = 0; entry < eligible.length; entry++) {
    for (let destination = 0; destination < eligible.length; destination++) {
      if (entry !== destination && eligible[entry].domain !== eligible[destination].domain) {
        pairs.push([entry, destination]);
      }
    }
  }
  if (pairs.length === 0) throw new Error('No independent two-relay route is available');
  const [entry, destination] = pairs[randomInt(pairs.length)];
  return {
    entry: copyCandidate(eligible[entry].candidate),
    destination: copyCandidate(eligible[destination].candidate),
  };
}

/** Conservative /24 IPv4 or /48 IPv6 domain for observed relay sockets. */
export function observedNetworkDomainV1(address: string): string | undefined {
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(normalized) === 4) return `ipv4:${normalized.split('.').slice(0, 3).join('.')}`;
  if (isIP(normalized) !== 6) return undefined;
  const halves = normalized.toLowerCase().split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const expanded = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (expanded.length !== 8 || expanded.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }
  return `ipv6:${expanded.slice(0, 3).map(part => part.padStart(4, '0')).join(':')}`;
}

function copyCandidate(candidate: PrivateRouteCandidateV1): PrivateRouteCandidateV1 {
  return {
    descriptor: {
      ...candidate.descriptor,
      endpoints: [...candidate.descriptor.endpoints],
      capabilities: { ...candidate.descriptor.capabilities },
      supportedGroups: [...candidate.descriptor.supportedGroups],
      storage: { ...candidate.descriptor.storage },
    },
    endpoint: candidate.endpoint,
    remoteAddress: candidate.remoteAddress,
  };
}
