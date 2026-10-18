/** Select an existing collection under the desktop's stopped-runtime exclusion.
 * Selection never enrolls, removes a retained role or starts the service. */
import { isAbsolute, resolve } from 'node:path';
import { getDataDir } from '@resonance/node';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath, historySetupContains } from '@resonance/relay';
import { readOperatorFile, readOperatorSigningKey } from '../../../relay/src/admission-operator-files.js';
import { readHistoryVolunteerConfigurationFile } from '../../../relay/src/history-volunteer-config.js';
import { readHistoryVolunteerCollectionFile, openConfiguredHistoryVolunteerCollection, HISTORY_VOLUNTEER_COLLECTION_MAX_BYTES } from '../../../relay/src/history-volunteer-collection.js';
import { relayServiceRuntime, validateRelayServicePaths } from './relay-supervisor.js';
import { historyActivationServiceFiles } from './history-activation.js';
import type { RelayConfig } from './session.js';
import type { RelayVolunteerBinding } from './history-volunteer-activation.js';

export interface RelayHistoryCollectionInput { configurationFile: string }
export interface RelayHistoryCollectionBinding {
  histories: RelayVolunteerBinding[];
  files: Array<{ path: string; digest: string }>;
}
function path(value: unknown) {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Collection selection needs absolute local paths');
  return resolve(value);
}
export function parseRelayHistoryCollectionInput(value: unknown): RelayHistoryCollectionInput {
  if (!exactWitnessFields(value, ['configurationFile'])) throw new Error('Select exactly one existing collection configuration');
  return { configurationFile: path(value.configurationFile) };
}
export function parseRelayHistoryCollectionBinding(value: unknown): RelayHistoryCollectionBinding {
  if (!exactWitnessFields(value, ['histories', 'files']) || !Array.isArray(value.histories) || !value.histories.length || value.histories.length > 8
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 17) throw new Error('Invalid retained collection binding');
  const histories = value.histories.map(raw => {
    if (!exactWitnessFields(raw, ['contextId', 'genesisId', 'member', 'directory']) || !isHistoryDigest(raw.contextId) || !isHistoryDigest(raw.genesisId)
      || typeof raw.member !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.member)
      || Buffer.from(raw.member, 'base64url').toString('base64url') !== raw.member) throw new Error('Invalid retained collection member');
    return { contextId: raw.contextId, genesisId: raw.genesisId, member: raw.member, directory: path(raw.directory) };
  });
  const files = value.files.map(raw => {
    if (!exactWitnessFields(raw, ['path', 'digest']) || !isHistoryDigest(raw.digest)) throw new Error('Invalid retained collection file binding');
    return { path: path(raw.path), digest: raw.digest };
  });
  if (new Set(histories.map(h => h.contextId)).size !== histories.length || new Set(histories.map(h => h.directory)).size !== histories.length
    || new Set(files.map(f => f.path)).size !== files.length) throw new Error('Duplicate retained collection binding');
  return { histories, files };
}
function bindHistory(config: ReturnType<typeof readHistoryVolunteerConfigurationFile>): RelayVolunteerBinding {
  const key = readOperatorSigningKey(config.signingKeyFile);
  try { return { contextId: historyCheckpointContextId(config.context), genesisId: config.genesisId,
    member: Buffer.from(key.publicKey).toString('base64url'), directory: canonicalHistorySetupPath(config.directory) }; }
  finally { key.secretKey.fill(0); }
}
function snapshot(input: RelayHistoryCollectionInput) {
  const config = readHistoryVolunteerCollectionFile(input.configurationFile);
  const paths = [input.configurationFile, ...config.histories.flatMap(history => [history.signingKeyFile, history.storageKeyFile])];
  const layout = paths.map(value => [value, canonicalHistorySetupPath(value)]);
  const files = [...new Set(layout.map(([, actual]) => actual))].map(file => {
    const bytes = readOperatorFile(file, file === canonicalHistorySetupPath(input.configurationFile) ? HISTORY_VOLUNTEER_COLLECTION_MAX_BYTES : 4096);
    try { return { path: file, digest: historyDigest(bytes) }; } finally { bytes.fill(0); }
  });
  return { config, layout, binding: { histories: config.histories.map(bindHistory), files } };
}
function preserves(previous: RelayVolunteerBinding[], next: RelayVolunteerBinding[]) {
  for (const history of previous) {
    const selected = next.find(h => h.contextId === history.contextId);
    if (!selected || ['contextId', 'genesisId', 'member', 'directory'].some(field => selected[field as keyof RelayVolunteerBinding] !== history[field as keyof RelayVolunteerBinding])) {
      throw new Error('Collection selection must preserve every retained history, genesis, member and directory; use explicit recovery for replacements');
    }
  }
}
/** Reviewed paths take precedence over stale GUI environment overrides. */
export function historyCollectionActivationServiceFiles(previous: RelayConfig) {
  if (!previous.historyCollectionInput) return {};
  const input = parseRelayHistoryCollectionInput(previous.historyCollectionInput), binding = parseRelayHistoryCollectionBinding(previous.historyCollectionBinding);
  const current = snapshot(input);
  if (JSON.stringify(current.binding) !== JSON.stringify(binding)) throw new Error('Reviewed collection files changed; review the selection again before starting');
  return { historyVolunteerFile: '', historyVolunteerCollectionFile: input.configurationFile };
}

export async function withRelayHistoryCollectionActivation<T>(raw: unknown, previous: RelayConfig, runtimeDirectory: string, signal: AbortSignal,
  operation: (prepared: { input: RelayHistoryCollectionInput; binding: RelayHistoryCollectionBinding; runtime: ReturnType<typeof relayServiceRuntime>;
    review: Record<string, unknown>; apply(digest: string, beforeSave?: () => void): { result: 'history-collection-selected'; startsService: false; readiness: 'unverified' } }) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); const input = parseRelayHistoryCollectionInput(raw), original = snapshot(input);
  const directory = canonicalHistorySetupPath(runtimeDirectory), histories = original.binding.histories;
  for (const history of histories) {
    if (historySetupContains(directory, history.directory) || historySetupContains(history.directory, directory)
      || original.binding.files.some(file => historySetupContains(history.directory, file.path))) throw new Error('Keep collection configuration, keys, histories and relay runtime in separate locations');
  }
  if (original.binding.files.some(file => historySetupContains(directory, file.path))) throw new Error('Keep collection configuration and keys outside the relay runtime');
  const prior: RelayVolunteerBinding[] = [...previous.historyCollectionBinding?.histories ?? [], ...previous.historyVolunteerBinding ? [previous.historyVolunteerBinding] : []];
  if (!previous.historyCollectionBinding && previous.runtime?.historyVolunteerCollectionFile) prior.push(...snapshot({ configurationFile: previous.runtime.historyVolunteerCollectionFile }).binding.histories);
  if (!previous.historyVolunteerBinding && previous.runtime?.historyVolunteerFile) prior.push(bindHistory(readHistoryVolunteerConfigurationFile(previous.runtime.historyVolunteerFile)));
  preserves(prior, histories);
  const collection = openConfiguredHistoryVolunteerCollection(original.config);
  try {
    const retainedDigest = collection.reviewDigest(), runtime = relayServiceRuntime(previous.runtime,
      { ...(previous.historyActivationInput ? historyActivationServiceFiles(previous.historyActivationInput) : {}),
        historyVolunteerFile: '', historyVolunteerCollectionFile: input.configurationFile });
    const service = { ...runtime, dataDir: getDataDir(), port: previous.port, adminKey: previous.adminKey ?? '', contacts: previous.contacts ?? [], controls: previous.controls };
    validateRelayServicePaths(service);
    const details = { kind: 'history-collection-activation', configurationFile: input.configurationFile,
      histories, health: collection.health(), controllers: original.config.contacts.map(c => ({ relayId: c.expectedRelayId, endpoint: c.endpoint })),
      retainedDigest, startsService: false, readiness: 'unverified' };
    const review = { ...details, approvalDigest: historyDigest(`resonance:desktop-history-collection:v1\n${JSON.stringify([details, original.binding, original.layout, previous, runtime])}`) };
    const check = () => {
      signal.throwIfAborted(); const current = snapshot(input);
      validateRelayServicePaths(service);
      if (JSON.stringify(current.binding) !== JSON.stringify(original.binding) || JSON.stringify(current.layout) !== JSON.stringify(original.layout)
        || collection.reviewDigest() !== retainedDigest || canonicalHistorySetupPath(runtimeDirectory) !== directory) throw new Error('Collection inputs or retained history changed; review again');
    };
    check(); let applied = false;
    return await operation({ input, binding: original.binding, runtime, review, apply(digest, beforeSave) {
      if (applied || digest !== review.approvalDigest) throw new Error('Collection approval changed or was already used');
      check(); beforeSave?.(); check(); applied = true;
      return { result: 'history-collection-selected', startsService: false, readiness: 'unverified' };
    } });
  } finally { collection.close(); }
}
