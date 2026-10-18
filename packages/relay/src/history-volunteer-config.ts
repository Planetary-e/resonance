/** Explicit startup configuration for an already-enrolled history volunteer. */
import { dirname, resolve } from 'node:path';
import { assertSecureRelayTransportEndpoint, createRelayContactHintV1 } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { isHistoryDigest, parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { readOperatorJson, readOperatorSigningKey, readOperatorStorageKey } from './admission-operator-files.js';
import { openHistoryVolunteerService } from './history-volunteer-service.js';
import type { HistoryRelayMemberRoute, HistoryRelayBridgeRoute } from './history-relay-bridge.js';
import { HistoryRelayRouter } from './history-relay-router.js';

/** Read-only. Every path is relative to this configuration, never the process cwd. */
export function readHistoryVolunteerConfigurationFile(path: string) {
  return parseHistoryVolunteerConfiguration(readOperatorJson(path, 64 * 1024), dirname(resolve(path)));
}
/** Pure validation used before publishing a reviewed runtime configuration. */
export function parseHistoryVolunteerConfiguration(raw: unknown, base: string) {
  if (!exactWitnessFields(raw, ['version', 'context', 'genesisId', 'directory', 'signingKeyFile', 'storageKeyFile', 'controllers', 'limits'])
    || raw.version !== 1 || !isHistoryDigest(raw.genesisId) || !Array.isArray(raw.controllers)
    || raw.controllers.length < 1 || raw.controllers.length > 5
    || !exactWitnessFields(raw.limits, ['bytesPerGeneration', 'blocksPerGeneration', 'generations'])) throw new Error('Invalid history volunteer configuration');
  const context = parseHistoryCheckpointContext(raw.context);
  function file(value: unknown) {
    if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid history volunteer path');
    return resolve(base, value);
  }
  const limits = raw.limits;
  for (const [field, maximum] of [['bytesPerGeneration', 256 * 1024 * 1024], ['blocksPerGeneration', 10001], ['generations', 65]] as const) {
    if (!Number.isSafeInteger(limits[field]) || (limits[field] as number) < 1 || (limits[field] as number) > maximum) throw new Error('Invalid history volunteer capacity');
  }
  // The store reserves two maximum 2 MiB manifests before retaining any block.
  if ((limits.bytesPerGeneration as number) <= 4 * 1024 * 1024) throw new Error('History capacity must include manifest and block storage');
  const contacts = raw.controllers.map(controller => {
    if (!exactWitnessFields(controller, ['relayId', 'endpoint']) || typeof controller.relayId !== 'string'
      || typeof controller.endpoint !== 'string' || controller.endpoint.length > 2048) throw new Error('Invalid history controller pin');
    assertSecureRelayTransportEndpoint(controller.endpoint);
    return createRelayContactHintV1('configured', controller.endpoint, controller.relayId);
  });
  if (new Set(contacts.map(c => c.expectedRelayId)).size !== contacts.length
    || new Set(contacts.map(c => c.endpoint)).size !== contacts.length) throw new Error('History controllers must have distinct identities and endpoints');
  return { context, genesisId: raw.genesisId as string, directory: file(raw.directory), signingKeyFile: file(raw.signingKeyFile),
    storageKeyFile: file(raw.storageKeyFile), contacts, maxBytes: limits.bytesPerGeneration as number,
    maxBlocks: limits.blocksPerGeneration as number, maxGenerations: limits.generations as number };
}

/** Opens existing state only. Enrollment/initialization remains an explicit operator operation. */
export function openConfiguredHistoryVolunteerStore(config: ReturnType<typeof readHistoryVolunteerConfigurationFile>, acceptNew?: () => boolean) {
  const signingKey = readOperatorSigningKey(config.signingKeyFile);
  let localKey: Buffer | undefined;
  try {
    localKey = readOperatorStorageKey(config.storageKeyFile);
    return openHistoryVolunteerService({ context: config.context, genesisId: config.genesisId, directory: config.directory,
      localKey, signingKey, maxBytes: config.maxBytes, maxBlocks: config.maxBlocks, maxGenerations: config.maxGenerations,
      acceptNew });
  } finally { localKey?.fill(0); signingKey.secretKey.fill(0); }
}
export function openConfiguredHistoryVolunteer(config: ReturnType<typeof readHistoryVolunteerConfigurationFile>, acceptNew?: (bytes: number) => boolean,
  ownerMembers?: readonly HistoryRelayMemberRoute[], bridgeRoutes?: readonly HistoryRelayBridgeRoute[]) {
  let requestBytes = 0;
  const enrolled = openConfiguredHistoryVolunteerStore(config, acceptNew ? () => acceptNew(requestBytes) : undefined);
  try {
    const router = new HistoryRelayRouter({ members: ownerMembers, bridgeRoutes, acceptForward: acceptNew, waitForConnection: !!ownerMembers || !!bridgeRoutes,
      acceptedRelayIds: config.contacts.map(c => c.expectedRelayId!),
      handler(method, value) {
        // All enrolled role methods are synchronous. Charge logical request bytes
        // only when that role asks to admit new storage; reads/retries remain available.
        requestBytes = Buffer.byteLength(JSON.stringify(value));
        try { return method === 'agreement' ? enrolled.exchange(value) : enrolled[method](value); }
        finally { requestBytes = 0; }
      } });
    return { router, describe: () => enrolled.describe(), health: () => enrolled.health(), close() { router.close(); enrolled.close(); } };
  } catch (error) { enrolled.close(); throw error; }
}
