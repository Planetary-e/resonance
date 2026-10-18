/** Reviewed configuration of an existing enrolled volunteer. No service starts here. */
import { isAbsolute, dirname, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { getDataDir } from '@resonance/node';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath, historySetupContains, openHistoryVolunteerService, readHistoryEnrollmentFile } from '@resonance/relay';
import { parseHistoryVolunteerConfiguration, readHistoryVolunteerConfigurationFile } from '../../../relay/src/history-volunteer-config.js';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from '../../../relay/src/admission-operator-files.js';
import { relayServiceRuntime, validateRelayServicePaths } from './relay-supervisor.js';
import type { RelayConfig } from './session.js';
import { historyActivationServiceFiles } from './history-activation.js';
import { historyCollectionActivationServiceFiles } from './history-collection-activation.js';

export interface RelayVolunteerActivationInput {
  enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string; controllersFile: string; output: string;
  generationMiB: number; blocksPerGeneration: number; maximumGenerations: number;
}
export interface RelayVolunteerBinding { contextId: string; genesisId: string; member: string; directory: string }
const pathFields = ['enrollmentFile', 'signingKeyFile', 'storageKeyFile', 'directory', 'controllersFile', 'output'] as const;
export function parseRelayVolunteerActivationInput(value: unknown): RelayVolunteerActivationInput {
  if (!exactWitnessFields(value, [...pathFields, 'generationMiB', 'blocksPerGeneration', 'maximumGenerations'])) throw new Error('Supply the complete volunteer activation selection');
  const input = { ...value } as unknown as RelayVolunteerActivationInput;
  for (const field of pathFields) {
    const path = value[field];
    if (typeof path !== 'string' || !path.length || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) throw new Error('Volunteer activation paths must be absolute local paths');
    input[field] = resolve(path);
  }
  for (const [field, minimum, maximum] of [['generationMiB', 5, 256], ['blocksPerGeneration', 1, 10001], ['maximumGenerations', 1, 65]] as const) {
    if (!Number.isSafeInteger(input[field]) || input[field] < minimum || input[field] > maximum) throw new Error('Volunteer history limits are outside supported bounds');
  }
  return input;
}
export function parseRelayVolunteerBinding(value: unknown): RelayVolunteerBinding {
  if (!exactWitnessFields(value, ['contextId', 'genesisId', 'member', 'directory']) || !isHistoryDigest(value.contextId) || !isHistoryDigest(value.genesisId)
    || typeof value.member !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.member)
    || typeof value.directory !== 'string' || !isAbsolute(value.directory) || value.directory.length > 4096 || /[\x00-\x1f\x7f]/.test(value.directory)) throw new Error('Invalid retained volunteer binding');
  return value as unknown as RelayVolunteerBinding;
}
function configurationBinding(path: string): RelayVolunteerBinding {
  const config = readHistoryVolunteerConfigurationFile(path), key = readOperatorSigningKey(config.signingKeyFile);
  try { return { contextId: historyCheckpointContextId(config.context), genesisId: config.genesisId, member: Buffer.from(key.publicKey).toString('base64url'),
    directory: canonicalHistorySetupPath(config.directory) }; }
  finally { key.secretKey.fill(0); }
}
function sameBinding(expected: RelayVolunteerBinding, actual: RelayVolunteerBinding) {
  if (['contextId', 'genesisId', 'member', 'directory'].some(field => expected[field as keyof RelayVolunteerBinding] !== actual[field as keyof RelayVolunteerBinding])) {
    throw new Error('Retained volunteer history cannot be replaced by another identity, genesis or directory; use explicit recovery');
  }
}
/** A later launch must retain the reviewed role even if an old GUI launch variable differs. */
export function volunteerActivationServiceFiles(previous: RelayConfig) {
  if (previous.historyCollectionInput) return historyCollectionActivationServiceFiles(previous);
  if (!previous.historyVolunteerActivationInput) return {};
  const input = parseRelayVolunteerActivationInput(previous.historyVolunteerActivationInput);
  if (!previous.historyVolunteerBinding) throw new Error('Reviewed volunteer binding is missing; retain settings for recovery');
  sameBinding(parseRelayVolunteerBinding(previous.historyVolunteerBinding), configurationBinding(input.output));
  return { historyVolunteerFile: input.output };
}

export async function withRelayVolunteerActivation<T>(raw: unknown, previous: RelayConfig, runtimeDirectory: string, signal: AbortSignal,
  operation: (prepared: { review: Record<string, unknown>; input: RelayVolunteerActivationInput; binding: RelayVolunteerBinding;
    apply: (digest: string, beforeWrite?: () => void) => { result: 'volunteer-service-configured'; startsService: false; readiness: 'unverified' };
    runtime: ReturnType<typeof relayServiceRuntime> }) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); const input = parseRelayVolunteerActivationInput(raw);
  if (previous.historyCollectionInput) throw new Error('Review the complete selected collection; single-history activation cannot drop its other histories');
  const canonical = () => pathFields.map(field => [field, canonicalHistorySetupPath(input[field])]);
  const layout = canonical(), directory = canonicalHistorySetupPath(input.directory), output = canonicalHistorySetupPath(input.output), runtimeDirectoryCanonical = canonicalHistorySetupPath(runtimeDirectory);
  if (historySetupContains(directory, runtimeDirectoryCanonical) || historySetupContains(runtimeDirectoryCanonical, directory)
    || pathFields.filter(field => field !== 'directory').some(field => historySetupContains(directory, canonicalHistorySetupPath(input[field])))
    || historySetupContains(runtimeDirectoryCanonical, output)) throw new Error('Volunteer history, runtime and configuration files must use separate locations');
  const outputAbsent = () => {
    try { lstatSync(output); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('Volunteer configuration output exists; retain it and select a new output');
  };
  outputAbsent(); if (!lstatSync(dirname(output)).isDirectory()) throw new Error('Volunteer configuration needs an existing parent directory');
  const fileDigests = () => pathFields.filter(field => field !== 'directory' && field !== 'output').map(field => {
    const bytes = readOperatorFile(input[field], field === 'enrollmentFile' ? HISTORY_ENVELOPE_MAX_BYTES + 65536 : 65536);
    try { return [field, historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const files = fileDigests(), enrollment = readHistoryEnrollmentFile(input.enrollmentFile), signingKey = readOperatorSigningKey(input.signingKeyFile);
  let localKey: Buffer | undefined, service: ReturnType<typeof openHistoryVolunteerService> | undefined;
  try {
    localKey = readOperatorStorageKey(input.storageKeyFile);
    const binding: RelayVolunteerBinding = { contextId: enrollment.contextId, genesisId: enrollment.genesisId,
      member: Buffer.from(signingKey.publicKey).toString('base64url'), directory };
    const ownerFiles = previous.historyActivationInput ? historyActivationServiceFiles(previous.historyActivationInput) : {};
    const existingRuntime = relayServiceRuntime(previous.runtime, { ...ownerFiles, ...volunteerActivationServiceFiles(previous) });
    const priorBinding = previous.historyVolunteerBinding ?? (existingRuntime.historyVolunteerFile ? configurationBinding(existingRuntime.historyVolunteerFile) : undefined);
    if (priorBinding) sameBinding(priorBinding, binding);
    const rawConfig = { version: 1, context: enrollment.context, genesisId: enrollment.genesisId, directory,
      signingKeyFile: canonicalHistorySetupPath(input.signingKeyFile), storageKeyFile: canonicalHistorySetupPath(input.storageKeyFile),
      controllers: readOperatorJson(input.controllersFile, 65536),
      limits: { bytesPerGeneration: input.generationMiB * 1048576, blocksPerGeneration: input.blocksPerGeneration, generations: input.maximumGenerations } };
    const config = parseHistoryVolunteerConfiguration(rawConfig, dirname(output));
    // Ordinary reopening validates all retained generations and can complete only
    // a provably unactivated empty successor slot. It never enrolls a missing genesis.
    service = openHistoryVolunteerService({ directory, localKey, signingKey, context: enrollment.context, genesisId: enrollment.genesisId,
      maxBytes: config.maxBytes, maxBlocks: config.maxBlocks, maxGenerations: config.maxGenerations });
    const retainedDigest = service.reviewDigest(), health = service.health();
    const runtime = relayServiceRuntime(existingRuntime, { ...ownerFiles, historyVolunteerFile: output });
    validateRelayServicePaths({ ...runtime, historyVolunteerFile: '', dataDir: getDataDir(), port: previous.port, adminKey: previous.adminKey ?? '', contacts: previous.contacts ?? [], controls: previous.controls });
    const details = { kind: 'history-volunteer-activation', contextId: binding.contextId, genesisId: binding.genesisId, member: binding.member,
      directory, output, owner: enrollment.context.owner, authority: enrollment.context.authority, controllers: rawConfig.controllers,
      retainedDigest, health, readiness: 'unverified', startsService: false };
    const review = { ...details, approvalDigest: historyDigest(`resonance:desktop-volunteer-activation:v1\n${JSON.stringify([details, input, layout, files, previous, runtime, rawConfig])}`) };
    const check = () => {
      signal.throwIfAborted();
      if (JSON.stringify(layout) !== JSON.stringify(canonical()) || JSON.stringify(files) !== JSON.stringify(fileDigests()) || service!.reviewDigest() !== retainedDigest) {
        throw new Error('Volunteer activation files or retained history changed; review again');
      }
    };
    check(); let applied = false;
    return await operation({ input, binding, runtime, review,
      apply(approved: string, beforeWrite?: () => void) {
        if (applied || approved !== review.approvalDigest) throw new Error('Volunteer activation approval changed or was already applied');
        check(); outputAbsent(); beforeWrite?.(); check(); outputAbsent();
        writeOperatorJsonNew(output, rawConfig, 65536); check();
        validateRelayServicePaths({ ...runtime, dataDir: getDataDir(), port: previous.port, adminKey: previous.adminKey ?? '', contacts: previous.contacts ?? [], controls: previous.controls });
        applied = true; return { result: 'volunteer-service-configured', startsService: false, readiness: 'unverified' };
      } });
  } finally { service?.close(); localKey?.fill(0); signingKey.secretKey.fill(0); }
}
