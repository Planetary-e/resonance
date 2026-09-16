/** Best-effort network failure-domain signals for replica placement. */

import { isIP } from 'node:net';

export interface ReplicaDiversityCandidate {
  relayId: string;
  /** The endpoint that completed the authenticated relay handshake. */
  endpoint: string;
}

/**
 * Returns a coarse domain for an endpoint that was actually contacted.
 * Equal domains are evidence of shared network fate. Different domains are
 * useful placement diversity, but do not prove independent operators.
 */
export function observedReplicaFailureDomain(endpoint: string): string | undefined {
  let hostname: string;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return undefined;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (isIP(hostname) === 4) {
    const octets = hostname.split('.');
    return `ipv4:${octets.slice(0, 3).join('.')}.0/24`;
  }
  if (isIP(hostname) === 6) {
    return `ipv6:${ipv6Prefix48(hostname) ?? hostname}`;
  }
  return hostname.length > 0 ? `host:${hostname}` : undefined;
}

/**
 * Preserves the caller's stable score order while moving the first candidate
 * from each newly observed failure domain ahead of candidates that share one.
 */
export function prioritizeReplicaDiversity<T extends ReplicaDiversityCandidate>(
  orderedCandidates: readonly T[],
  retainedRelayIds: Iterable<string> = [],
): T[] {
  const retained = new Set(retainedRelayIds);
  const firstByRelay = new Map<string, T>();
  for (const candidate of orderedCandidates) {
    if (!firstByRelay.has(candidate.relayId)) firstByRelay.set(candidate.relayId, candidate);
  }
  const candidates = [...firstByRelay.values()];
  const occupiedDomains = new Set(candidates
    .filter(candidate => retained.has(candidate.relayId))
    .map(candidate => observedReplicaFailureDomain(candidate.endpoint))
    .filter((domain): domain is string => domain !== undefined));
  const diverse: T[] = [];
  const sharedOrUnknown: T[] = [];
  for (const candidate of candidates) {
    if (retained.has(candidate.relayId)) continue;
    const domain = observedReplicaFailureDomain(candidate.endpoint);
    if (domain !== undefined && !occupiedDomains.has(domain)) {
      occupiedDomains.add(domain);
      diverse.push(candidate);
    } else {
      sharedOrUnknown.push(candidate);
    }
  }
  return [...diverse, ...sharedOrUnknown];
}

function ipv6Prefix48(hostname: string): string | undefined {
  if (hostname.includes('.')) return undefined;
  const halves = hostname.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const expanded = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (expanded.length !== 8 || expanded.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return undefined;
  }
  return `${expanded.slice(0, 3).map(part => part.padStart(4, '0')).join(':')}::/48`;
}
