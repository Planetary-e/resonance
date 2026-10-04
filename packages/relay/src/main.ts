#!/usr/bin/env node

/**
 * Relay server entry point. Configured via environment variables.
 */

import { readFileSync, statSync } from 'node:fs';
import { createRelayContactHintV1 } from '@resonance/core';
import { MAX_ADMISSION_POLICY_BYTES } from '@resonance/core/admission-policy';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { log } from './logger.js';
import { localRelayEndpoints, startLanDiscovery } from './lan-discovery.js';
import { OwnerResourcePolicy } from './owner-resource-policy.js';
import { RelayTrafficMeter } from './relay-resource-meter.js';
import { createRelayServer } from './server.js';
import { createConfiguredAdmissionVerifier } from './configured-admission-verifier.js';
import type { AdmissionCapabilityVerifierV2 } from './admission.js';
import type { AdmissionWitness } from './admission-witness.js';
import { createLocalBlindAdmissionVerifierV2 } from './blind-admission-verifier.js';

const relayPort = parseNonNegativeInteger(process.env.RELAY_PORT, 9090, 'RELAY_PORT');
const tlsCertFile = process.env.RELAY_TLS_CERT_FILE;
const tlsKeyFile = process.env.RELAY_TLS_KEY_FILE;
if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
  throw new Error('RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be set together');
}
const tls = tlsCertFile && tlsKeyFile
  ? { cert: readFileSync(tlsCertFile), key: readFileSync(tlsKeyFile) }
  : undefined;
const lanEnabled = process.env.RELAY_LAN_DISCOVERY === 'true';
if (lanEnabled && tls) throw new Error('LAN discovery requires a plain private-LAN listener');
const relayHost = process.env.RELAY_HOST ?? '127.0.0.1';
if (lanEnabled && relayHost !== '0.0.0.0') {
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
const ownerTotalBandwidth = parseOptionalNonNegativeInteger(
  process.env.RELAY_TOTAL_BANDWIDTH_BYTES_PER_HOUR,
  'RELAY_TOTAL_BANDWIDTH_BYTES_PER_HOUR',
);
const ownerCpu = parseOptionalNonNegativeInteger(
  process.env.RELAY_NEW_WORK_CPU_MS_PER_MINUTE,
  'RELAY_NEW_WORK_CPU_MS_PER_MINUTE',
);
const ownerSchedule = process.env.RELAY_ACTIVE_HOURS;
const ownerExternalPower = process.env.RELAY_ONLY_WHEN_CHARGING === 'true';
const relayDataDir = process.env.RELAY_DATA_DIR ?? './data';
const admissionSettings = [
  process.env.RELAY_ADMISSION_PUBLIC_KEY_FILE,
  process.env.RELAY_ADMISSION_ISSUER,
  process.env.RELAY_ADMISSION_COMMUNITY,
  process.env.RELAY_ADMISSION_EPOCH,
];
if (admissionSettings.some(Boolean) && !admissionSettings.every(Boolean)) {
  throw new Error('All RELAY_ADMISSION_* settings must be supplied together');
}
const policyFiles = [process.env.RELAY_ADMISSION_AUTHORITY_FILE, process.env.RELAY_ADMISSION_POLICY_FILE, process.env.RELAY_ADMISSION_POLICY_KEY_FILE];
if (policyFiles.some(Boolean) && (!policyFiles.every(Boolean) || admissionSettings.some(Boolean))) {
  throw new Error('Supply all three signed admission policy files and omit the manual issuer settings');
}
function policyFile(path: string, maximum = 64 * 1024) { if (statSync(path).size > maximum) throw new Error('Admission policy input is too large'); return readFileSync(path, 'utf8'); }
const policyKeyHex = policyFiles.every(Boolean) ? policyFile(policyFiles[2]!).trim() : undefined;
if (policyKeyHex !== undefined && !/^[a-f0-9]{64}$/.test(policyKeyHex)) throw new Error('Policy storage key must be 32 bytes encoded as lowercase hex');
const witnessKeyFile = process.env.RELAY_ADMISSION_WITNESS_KEY_FILE;
const coordinatorKeyFile = process.env.RELAY_ADMISSION_COORDINATOR_KEY_FILE;
if ((witnessKeyFile || coordinatorKeyFile || process.env.RELAY_ADMISSION_WITNESS_INITIALIZE === 'true') && !policyFiles.every(Boolean)) {
  throw new Error('Admission witness roles require signed community policy');
}
function signingKeyFile(path: string) {
  const value = JSON.parse(policyFile(path));
  if (typeof value.publicKey !== 'string' || typeof value.secretKey !== 'string') throw new Error('Invalid admission signing key file');
  const secretKey = Buffer.from(value.secretKey, 'base64url');
  try { return copyAdmissionSigningKey({ publicKey: Buffer.from(value.publicKey, 'base64url'), secretKey }); }
  finally { secretKey.fill(0); }
}
const witnessKey = witnessKeyFile ? signingKeyFile(witnessKeyFile) : undefined;
const coordinatorKey = coordinatorKeyFile ? signingKeyFile(coordinatorKeyFile) : undefined;
const resourceMeter = new RelayTrafficMeter(relayDataDir);
const admissionVerifier: (AdmissionCapabilityVerifierV2 & { close(): void; witness?: AdmissionWitness }) | undefined = policyFiles.every(Boolean)
  ? await createConfiguredAdmissionVerifier({ directory: relayDataDir, authority: policyFile(policyFiles[0]!).trim(),
    policy: JSON.parse(policyFile(policyFiles[1]!, MAX_ADMISSION_POLICY_BYTES)), encryptionKey: Buffer.from(policyKeyHex!, 'hex'),
    initialize: process.env.RELAY_ADMISSION_POLICY_INITIALIZE === 'true', witnessKey, coordinatorKey,
    onWitnessSocket: socket => resourceMeter.observe(socket),
    initializeWitnessState: process.env.RELAY_ADMISSION_WITNESS_INITIALIZE === 'true' ? true : undefined })
  : admissionSettings.every(Boolean)
  ? createLocalBlindAdmissionVerifierV2({
    directory: relayDataDir,
    scope: {
      issuer: process.env.RELAY_ADMISSION_ISSUER!,
      community: process.env.RELAY_ADMISSION_COMMUNITY!,
      epoch: process.env.RELAY_ADMISSION_EPOCH!,
    },
    issuerPublicKey: await importAdmissionPublicKey(process.env.RELAY_ADMISSION_PUBLIC_KEY_FILE!),
  }) : undefined;
witnessKey?.secretKey.fill(0); coordinatorKey?.secretKey.fill(0);
const ownerPolicy = ownerBandwidth !== undefined || ownerTotalBandwidth !== undefined || ownerCpu !== undefined
  || ownerSchedule !== undefined || ownerExternalPower
  ? new OwnerResourcePolicy({
    maxNewWorkIngressBytesPerHour: ownerBandwidth,
    maxTotalBandwidthBytesPerHour: ownerTotalBandwidth,
    maxCpuMillisecondsPerMinute: ownerCpu,
    activeHours: ownerSchedule,
    requireExternalPower: ownerExternalPower,
    cpuMicros: () => resourceMeter.snapshot().cpuMicros,
    totalBandwidthBytes: () => resourceMeter.snapshot().totalBandwidthBytes,
    checkpointUsage: () => resourceMeter.checkpoint(),
    persistDir: relayDataDir,
  }) : null;

const server = createRelayServer({
  tls,
  identityPassphrase: process.env.RELAY_IDENTITY_PASSPHRASE,
  port: relayPort,
  host: relayHost,
  persistDir: relayDataDir,
  admissionVerifier,
  admissionWitness: admissionVerifier?.witness,
  resourceMeter,
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
    }, (direction, bytes) => {
      if (direction === 'ingress') resourceMeter.recordLanIngress(bytes);
      else resourceMeter.recordLanEgress(bytes);
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
    admissionVerifier?.close();
    process.exit(0);
  });
}

async function importAdmissionPublicKey(path: string): Promise<CryptoKey> {
  const pem = readFileSync(path, 'utf8');
  const body = pem.match(/^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*$/);
  if (!body) throw new Error('RELAY_ADMISSION_PUBLIC_KEY_FILE must contain one SPKI PEM public key');
  const bytes = Buffer.from(body[1].replace(/\s/g, ''), 'base64');
  const key = await crypto.subtle.importKey(
    'spki', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify'],
  );
  if ((key.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 2048) {
    throw new Error('Admission issuer key must use 2048-bit RSA');
  }
  return key;
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
