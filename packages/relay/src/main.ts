#!/usr/bin/env node

/**
 * Relay server entry point. Configured via environment variables.
 */

import { createRelayContactHintV1 } from '@resonance/core';
import { log } from './logger.js';
import { localRelayEndpoints, startLanDiscovery } from './lan-discovery.js';
import { OwnerResourcePolicy } from './owner-resource-policy.js';
import { createRelayServer } from './server.js';

const relayPort = parseNonNegativeInteger(process.env.RELAY_PORT, 9090, 'RELAY_PORT');
const lanEnabled = process.env.RELAY_LAN_DISCOVERY === 'true';
if (lanEnabled && (process.env.RELAY_HOST ?? '0.0.0.0') !== '0.0.0.0') {
  throw new Error('LAN discovery requires RELAY_HOST=0.0.0.0');
}
const localEndpoints = lanEnabled ? localRelayEndpoints(relayPort) : [];
if (lanEnabled && localEndpoints.length === 0) {
  throw new Error('LAN discovery needs a non-loopback IPv4 address');
}
const publicEndpoints = [...new Set([
  ...parseList(process.env.RELAY_PUBLIC_ENDPOINTS), ...localEndpoints,
])];
const configuredContacts = parseList(process.env.RELAY_CONTACTS);
const configuredHints = configuredContacts.map(endpoint => (
  createRelayContactHintV1('configured', endpoint)
));
const bootstrapHints = parseList(process.env.RELAY_BOOTSTRAP_CONTACTS).map(endpoint => (
  createRelayContactHintV1('bootstrap', endpoint)
));
const discoveryEnabled = process.env.RELAY_DISCOVERY === 'true'
  || publicEndpoints.length > 0
  || configuredHints.length > 0
  || bootstrapHints.length > 0;
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
const maxMailboxStorageBytes = parseNonNegativeInteger(
  process.env.RELAY_MAILBOX_STORAGE_QUOTA_BYTES,
  128 * 1024 * 1024,
  'RELAY_MAILBOX_STORAGE_QUOTA_BYTES',
);
const maxJournalStorageBytes = parseNonNegativeInteger(
  process.env.RELAY_JOURNAL_STORAGE_QUOTA_BYTES,
  storageAvailableBytes,
  'RELAY_JOURNAL_STORAGE_QUOTA_BYTES',
);
if (discoveryEnabled && (storageCapacityBytes === 0 || storageAvailableBytes > storageCapacityBytes)) {
  throw new Error('Relay discovery storage capacity must be positive and available bytes cannot exceed it');
}
if (publicationStorageQuotaBytes > storageCapacityBytes
  || publicationStorageQuotaBytes > storageAvailableBytes
  || maxReplicaStorageBytesPerRelay > publicationStorageQuotaBytes) {
  throw new Error('Relay publication and per-relay storage quotas must fit within relay availability');
}

const ownerBandwidth = parseOptionalNonNegativeInteger(
  process.env.RELAY_NEW_WORK_BANDWIDTH_BYTES_PER_HOUR,
  'RELAY_NEW_WORK_BANDWIDTH_BYTES_PER_HOUR',
);
const ownerCpu = parseOptionalNonNegativeInteger(
  process.env.RELAY_NEW_WORK_CPU_MS_PER_MINUTE,
  'RELAY_NEW_WORK_CPU_MS_PER_MINUTE',
);
const ownerSchedule = process.env.RELAY_ACTIVE_HOURS;
const ownerExternalPower = process.env.RELAY_ONLY_WHEN_CHARGING === 'true';
const ownerPolicy = ownerBandwidth !== undefined || ownerCpu !== undefined
  || ownerSchedule !== undefined || ownerExternalPower
  ? new OwnerResourcePolicy({
    maxNewWorkIngressBytesPerHour: ownerBandwidth,
    maxCpuMillisecondsPerMinute: ownerCpu,
    activeHours: ownerSchedule,
    requireExternalPower: ownerExternalPower,
  }) : null;

const server = createRelayServer({
  port: relayPort,
  host: process.env.RELAY_HOST ?? '0.0.0.0',
  persistDir: process.env.RELAY_DATA_DIR ?? './data',
  adminApiKey: process.env.RELAY_ADMIN_API_KEY || null,
  acceptNewWork: ownerPolicy ? bytes => ownerPolicy.allowNewWork(bytes) : undefined,
  maxPublishesPerMin: parseNonNegativeInteger(
    process.env.RELAY_MAX_PUBLISHES_PER_MIN, 10, 'RELAY_MAX_PUBLISHES_PER_MIN',
  ),
  maxSearchesPerMin: parseNonNegativeInteger(
    process.env.RELAY_MAX_SEARCHES_PER_MIN, 30, 'RELAY_MAX_SEARCHES_PER_MIN',
  ),
  publicationStorageQuotaBytes,
  maxReplicaStorageBytesPerRelay,
  maxMailboxStorageBytes,
  maxJournalStorageBytes,
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
  inboundReplicaTargetIds: parseList(process.env.RELAY_INBOUND_REPLICA_TARGET_IDS),
});

await server.start();

await Promise.all([...configuredHints, ...bootstrapHints].map(async (hint) => {
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

let lan: Awaited<ReturnType<typeof startLanDiscovery>> | null = null;
if (lanEnabled) {
  try {
    lan = await startLanDiscovery(relayPort, localEndpoints, endpoint => {
      void server.discoverRelay(createRelayContactHintV1('local', endpoint)).then(result => {
        log('info', 'relay_lan_discovered', {
          endpoint, responderId: result.responder.relayId,
        });
      }).catch(error => {
        log('warn', 'relay_lan_contact_failed', { endpoint, error: String(error) });
      });
    });
  } catch (error) {
    log('warn', 'relay_lan_listener_unavailable', { error: String(error) });
  }
}

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await lan?.stop();
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

function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : parseNonNegativeInteger(value, 0, name);
}
