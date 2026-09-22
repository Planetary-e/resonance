#!/usr/bin/env node

/**
 * Relay server entry point. Configured via environment variables.
 */

import { createRelayContactHintV1 } from '@resonance/core';
import { log } from './logger.js';
import { createRelayServer } from './server.js';

const publicEndpoints = parseList(process.env.RELAY_PUBLIC_ENDPOINTS);
const configuredContacts = parseList(process.env.RELAY_CONTACTS);
const configuredHints = configuredContacts.map(endpoint => (
  createRelayContactHintV1('configured', endpoint)
));
const discoveryEnabled = process.env.RELAY_DISCOVERY === 'true'
  || publicEndpoints.length > 0
  || configuredHints.length > 0;
const storageCapacityBytes = parseNonNegativeInteger(
  process.env.RELAY_STORAGE_CAPACITY_BYTES,
  1024 * 1024 * 1024,
  'RELAY_STORAGE_CAPACITY_BYTES',
);
const storageAvailableBytes = parseNonNegativeInteger(
  process.env.RELAY_STORAGE_AVAILABLE_BYTES,
  storageCapacityBytes,
  'RELAY_STORAGE_AVAILABLE_BYTES',
);
const publicationStorageQuotaBytes = parseNonNegativeInteger(
  process.env.RELAY_PUBLICATION_STORAGE_QUOTA_BYTES,
  storageAvailableBytes,
  'RELAY_PUBLICATION_STORAGE_QUOTA_BYTES',
);
const maxReplicaStorageBytesPerRelay = parseNonNegativeInteger(
  process.env.RELAY_REPLICA_STORAGE_PER_RELAY_BYTES,
  publicationStorageQuotaBytes,
  'RELAY_REPLICA_STORAGE_PER_RELAY_BYTES',
);
if (discoveryEnabled && (storageCapacityBytes === 0 || storageAvailableBytes > storageCapacityBytes)) {
  throw new Error('Relay discovery storage capacity must be positive and available bytes cannot exceed it');
}
if (publicationStorageQuotaBytes > storageCapacityBytes
  || publicationStorageQuotaBytes > storageAvailableBytes
  || maxReplicaStorageBytesPerRelay > publicationStorageQuotaBytes) {
  throw new Error('Relay publication and per-relay storage quotas must fit within relay availability');
}

const server = createRelayServer({
  port: parseInt(process.env.RELAY_PORT ?? '9090'),
  host: process.env.RELAY_HOST ?? '0.0.0.0',
  persistDir: process.env.RELAY_DATA_DIR ?? './data',
  adminApiKey: process.env.RELAY_ADMIN_API_KEY || null,
  publicationStorageQuotaBytes,
  maxReplicaStorageBytesPerRelay,
  replicaOfflineReplacementDelayMs: parseNonNegativeInteger(
    process.env.RELAY_REPLICA_OFFLINE_REPLACEMENT_MS,
    5 * 60_000,
    'RELAY_REPLICA_OFFLINE_REPLACEMENT_MS',
  ),
  relayDiscovery: discoveryEnabled ? {
    endpoints: publicEndpoints,
    reachability: publicEndpoints.length > 0 ? 'direct' : 'outbound-only',
    supportedGroups: parseList(process.env.RELAY_SUPPORTED_GROUPS, ['public']),
    storage: {
      capacityBytes: storageCapacityBytes,
      availableBytes: storageAvailableBytes,
    },
  } : undefined,
  relayLinks: configuredHints.length > 0 ? { targets: configuredHints } : undefined,
});

await server.start();

await Promise.all(configuredHints.map(async (hint) => {
  try {
    const result = await server.discoverRelay(hint);
    log('info', 'relay_contact_discovered', {
      endpoint: result.hint.endpoint,
      responderId: result.responder.relayId,
      descriptors: result.descriptors.length,
    });
  } catch (error) {
    log('warn', 'relay_contact_failed', { endpoint: hint.endpoint, error: String(error) });
  }
}));

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}

function parseList(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
