/** Short-lived, owner-only evidence from authenticated peers that opened a direct link. */

import { isIP } from 'node:net';
import type { RelayDescriptorV1 } from '@resonance/core';
import { observedReplicaFailureDomain } from './replica-diversity.js';

const OBSERVATION_LIFETIME_MS = 5 * 60_000;
const MAX_OBSERVATIONS = 512;

interface Observation {
  relayId: string;
  endpoint: string;
  sourceDomain: string;
  observedAt: number;
}

export class DirectReachabilityObservations {
  private readonly observations = new Map<string, Observation>();

  /** The endpoint statement is covered by the authenticated peer's link-open signature. */
  observe(
    descriptor: RelayDescriptorV1,
    relayId: string,
    dialedEndpoint: string | undefined,
    remoteAddress: string,
    now = Date.now(),
  ): boolean {
    if (descriptor.reachability !== 'direct' || !dialedEndpoint
      || !descriptor.endpoints.includes(dialedEndpoint)) return false;
    const sourceDomain = publicSourceDomain(remoteAddress);
    if (!sourceDomain || !isPublicCandidateEndpoint(dialedEndpoint)
      || sourceDomain === endpointAddressDomain(dialedEndpoint)) return false;
    this.prune(now);
    const key = `${relayId}\n${dialedEndpoint}`;
    this.observations.delete(key);
    this.observations.set(key, {
      relayId, endpoint: dialedEndpoint, sourceDomain, observedAt: now,
    });
    if (this.observations.size > MAX_OBSERVATIONS) {
      this.observations.delete(this.observations.keys().next().value!);
    }
    return true;
  }

  /** Require two distinct public source networks for each advertised URL. */
  confirmedEndpointCount(descriptor: RelayDescriptorV1 | null, now = Date.now()): number {
    this.prune(now);
    if (!descriptor || descriptor.reachability !== 'direct') return 0;
    return descriptor.endpoints.filter(endpoint => {
      const networks = new Set([...this.observations.values()]
        .filter(observation => observation.endpoint === endpoint)
        .map(observation => observation.sourceDomain));
      return networks.size >= 2;
    }).length;
  }

  private prune(now: number): void {
    for (const [key, observation] of this.observations) {
      if (now - observation.observedAt >= OBSERVATION_LIFETIME_MS) {
        this.observations.delete(key);
      }
    }
  }
}

function endpointAddressDomain(endpoint: string): string | undefined {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  return isIP(hostname) ? observedReplicaFailureDomain(endpoint) : undefined;
}

function isPublicCandidateEndpoint(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(hostname)) return publicSourceDomain(hostname) !== undefined;
  return hostname !== 'localhost' && !hostname.endsWith('.localhost')
    && !hostname.endsWith('.local') && !hostname.endsWith('.internal')
    && !hostname.endsWith('.invalid');
}

function publicSourceDomain(address: string): string | undefined {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [first, second, third] = ip.split('.').map(Number);
    if (first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19
        || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113)) return undefined;
  } else if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    // Global unicast only. Exclude documentation and special-purpose prefixes.
    if (!/^[23]/.test(lower) || lower.startsWith('2001:db8:')
      || lower.startsWith('2001:db8::')) return undefined;
  } else return undefined;
  return observedReplicaFailureDomain(`ws://${isIP(ip) === 6 ? `[${ip}]` : ip}/`);
}
