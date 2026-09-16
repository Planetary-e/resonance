/**
 * Bounded in-memory directory of independently signed relay descriptors.
 *
 * A directory entry is a verified observation, not an endorsement. The
 * connection manager remains responsible for measuring reachability and for
 * choosing replicas across independently observed peers.
 */

import {
  isRelayDescriptorActiveV1,
  type RelayDescriptorV1,
} from '@resonance/core';

export type RelayDescriptorObservation =
  | 'accepted'
  | 'updated'
  | 'unchanged'
  | 'invalid'
  | 'stale'
  | 'full';

export interface RelayDirectorySelection {
  supportedGroups?: string[];
  limit: number;
  now?: number;
}

export class RelayDirectory {
  private readonly descriptors = new Map<string, RelayDescriptorV1>();

  constructor(
    private readonly maxEntries = 256,
    private readonly localRelayId?: string,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4_096) {
      throw new Error('Relay directory capacity must be between 1 and 4096');
    }
  }

  observe(value: unknown, now = Date.now()): RelayDescriptorObservation {
    if (!isRelayDescriptorActiveV1(value, now) || value.relayId === this.localRelayId) {
      return 'invalid';
    }

    const existing = this.descriptors.get(value.relayId);
    if (existing) {
      if (value.sequence < existing.sequence) return 'stale';
      if (value.sequence === existing.sequence) {
        return equalDescriptor(value, existing) ? 'unchanged' : 'stale';
      }
      this.descriptors.set(value.relayId, copyDescriptor(value));
      return 'updated';
    }

    this.prune(now);
    if (this.descriptors.size >= this.maxEntries) return 'full';
    this.descriptors.set(value.relayId, copyDescriptor(value));
    return 'accepted';
  }

  select(options: RelayDirectorySelection): RelayDescriptorV1[] {
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(options.limit) || options.limit < 0 || options.limit > this.maxEntries) {
      throw new Error('Invalid relay directory selection limit');
    }
    const supportedGroups = options.supportedGroups ?? [];
    if (!Array.isArray(supportedGroups) || !supportedGroups.every(group => typeof group === 'string')) {
      throw new Error('Invalid relay directory group filter');
    }

    this.prune(now);
    return [...this.descriptors.values()]
      .filter(descriptor => supportedGroups.length === 0
        || supportedGroups.some(group => descriptor.supportedGroups.includes(group)))
      .sort((first, second) => first.relayId < second.relayId ? -1 : first.relayId > second.relayId ? 1 : 0)
      .slice(0, options.limit)
      .map(copyDescriptor);
  }

  size(now = Date.now()): number {
    this.prune(now);
    return this.descriptors.size;
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [relayId, descriptor] of this.descriptors) {
      if (!isRelayDescriptorActiveV1(descriptor, now)) {
        this.descriptors.delete(relayId);
        removed++;
      }
    }
    return removed;
  }
}

function copyDescriptor(value: RelayDescriptorV1): RelayDescriptorV1 {
  return {
    ...value,
    endpoints: [...value.endpoints],
    capabilities: { ...value.capabilities },
    supportedGroups: [...value.supportedGroups],
    storage: { ...value.storage },
  };
}

function equalDescriptor(first: RelayDescriptorV1, second: RelayDescriptorV1): boolean {
  // Ed25519 signatures are deterministic, and the signature covers the
  // canonical descriptor body, so equality does not depend on JSON key order.
  return first.signature === second.signature;
}
