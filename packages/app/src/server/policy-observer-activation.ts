/** Reviewed selection of an already prepared observer; never creates a history. */
import { isAbsolute, resolve } from 'node:path';
import { getDataDir } from '@resonance/node';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { assertAdmissionPolicyCurrent } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath, historySetupContains } from '@resonance/relay';
import { readOperatorFile } from '../../../relay/src/admission-operator-files.js';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES } from '../../../relay/src/policy-observer-config.js';
import { readAdmissionHistoryLinksFile } from '../../../relay/src/admission-history-config.js';
import { relayServiceRuntime, validateRelayServicePaths, type RelayServiceRoleFiles } from './relay-supervisor.js';
import type { RelayConfig } from './session.js';
import { openDesktopPolicyObserverReplacement } from './policy-observer-replacement.js';

export interface RelayPolicyObserverInput { configurationFile: string; linksFile: string }
export interface RelayPolicyObserverBinding {
  contextId: string; genesisId: string; rootId: string; directory: string;
  archiveDirectory?: string;
  files: Array<{ path: string; digest: string }>;
}
function absolute(value: unknown) {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Observer selection requires absolute local paths');
  return resolve(value);
}
export function parseRelayPolicyObserverInput(value: unknown): RelayPolicyObserverInput {
  if (!exactWitnessFields(value, ['configurationFile', 'linksFile'])) throw new Error('Select the prepared observer configuration and optional pinned routing');
  return { configurationFile: absolute(value.configurationFile), linksFile: value.linksFile === '' ? '' : absolute(value.linksFile) };
}
export function parseRelayPolicyObserverBinding(value: unknown): RelayPolicyObserverBinding {
  const hasArchive = !!value && typeof value === 'object' && Object.hasOwn(value, 'archiveDirectory');
  if (!exactWitnessFields(value, ['contextId', 'genesisId', 'rootId', 'directory', 'files', ...(hasArchive ? ['archiveDirectory'] : [])])
    || !isHistoryDigest(value.contextId) || !isHistoryDigest(value.genesisId) || !isHistoryDigest(value.rootId)
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 4) throw new Error('Invalid retained observer binding');
  const files = value.files.map(raw => {
    if (!exactWitnessFields(raw, ['path', 'digest']) || !isHistoryDigest(raw.digest)) throw new Error('Invalid retained observer file binding');
    return { path: absolute(raw.path), digest: raw.digest };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate retained observer file');
  return { contextId: value.contextId, genesisId: value.genesisId, rootId: value.rootId, directory: absolute(value.directory), files,
    ...(hasArchive ? { archiveDirectory: absolute(value.archiveDirectory) } : {}) };
}
function snapshot(input: RelayPolicyObserverInput) {
  const config = readPolicyObserverConfigurationFile(input.configurationFile);
  const paths = [input.configurationFile, config.signingKeyFile, config.storageKeyFile, ...(input.linksFile ? [input.linksFile] : [])];
  const layout = paths.map(path => [path, canonicalHistorySetupPath(path)]);
  const files = [...new Set(layout.map(([, actual]) => actual))].map(path => {
    const maximum = path === canonicalHistorySetupPath(input.configurationFile) ? POLICY_OBSERVER_CONFIGURATION_MAX_BYTES : 65536;
    const bytes = readOperatorFile(path, maximum);
    try { return { path, digest: historyDigest(bytes) }; } finally { bytes.fill(0); }
  });
  const routing = input.linksFile ? readAdmissionHistoryLinksFile(input.linksFile, config.historyContext) : undefined;
  const binding: RelayPolicyObserverBinding = { contextId: historyCheckpointContextId(config.historyContext),
    genesisId: historyCheckpointEnvelopeId(config.genesis), rootId: historyCheckpointEnvelopeId(config.root),
    directory: canonicalHistorySetupPath(config.directory), files,
    ...(config.archiveDirectory ? { archiveDirectory: canonicalHistorySetupPath(config.archiveDirectory) } : {}) };
  return { config, routing, layout, binding };
}
export function policyObserverActivationServiceFiles(previous: RelayConfig): RelayServiceRoleFiles {
  if (!previous.policyObserverInput) return {};
  const input = parseRelayPolicyObserverInput(previous.policyObserverInput), binding = parseRelayPolicyObserverBinding(previous.policyObserverBinding);
  if (JSON.stringify(snapshot(input).binding) !== JSON.stringify(binding)) throw new Error('Reviewed observer files changed; review before starting');
  return { policyObserverFile: input.configurationFile, policyObserverLinksFile: input.linksFile };
}
export async function withRelayPolicyObserverActivation<T>(raw: unknown, previous: RelayConfig, runtimeDirectory: string,
  signal: AbortSignal, retainedRoleFiles: RelayServiceRoleFiles,
  operation: (prepared: { input: RelayPolicyObserverInput; binding: RelayPolicyObserverBinding; runtime: ReturnType<typeof relayServiceRuntime>;
    review: Record<string, unknown>; apply(digest: string, beforeSave?: () => void): { result: 'policy-observer-selected'; startsService: false; readiness: 'unverified' } }) => Promise<T>) {
  signal.throwIfAborted(); const input = parseRelayPolicyObserverInput(raw), original = snapshot(input);
  const runtimePath = canonicalHistorySetupPath(runtimeDirectory), directory = original.binding.directory;
  const archive = original.binding.archiveDirectory;
  if (historySetupContains(runtimePath, directory) || historySetupContains(directory, runtimePath)
    || original.binding.files.some(file => historySetupContains(directory, file.path) || historySetupContains(runtimePath, file.path))
    || archive && ([runtimePath, directory].some(path => historySetupContains(path, archive) || historySetupContains(archive, path))
      || original.binding.files.some(file => historySetupContains(archive, file.path)))) {
    throw new Error('Keep observer history, configuration, keys and relay runtime in separate locations');
  }
  const prior = previous.policyObserverBinding ?? (previous.runtime?.policyObserverFile
    ? snapshot({ configurationFile: previous.runtime.policyObserverFile, linksFile: previous.runtime.policyObserverLinksFile ?? '' }).binding : undefined);
  const replacing = prior && ['contextId', 'genesisId', 'rootId', 'directory'].some(field => prior[field as keyof RelayPolicyObserverBinding] !== original.binding[field as keyof RelayPolicyObserverBinding]);
  const runtime = relayServiceRuntime(previous.runtime, { ...retainedRoleFiles,
    policyObserverFile: input.configurationFile, policyObserverLinksFile: input.linksFile });
  const service = { ...runtime, dataDir: getDataDir(), port: previous.port, adminKey: previous.adminKey ?? '', contacts: previous.contacts ?? [], controls: previous.controls };
  validateRelayServicePaths(service);
  let replacement: Awaited<ReturnType<typeof openDesktopPolicyObserverReplacement>> | undefined;
  try {
  if (replacing) replacement = await openDesktopPolicyObserverReplacement(previous, prior!, input, original.config, signal);
  const observer = await openConfiguredPolicyObserver(original.config);
  try {
    const status = observer.status(), retained = observer.reviewRecoverySource(), policy = observer.policy();
    let policyCurrent = true; try { assertAdmissionPolicyCurrent(policy, Date.now()); } catch { policyCurrent = false; }
    const details = { kind: 'policy-observer-activation', configurationFile: input.configurationFile,
      contextId: original.binding.contextId, genesisId: original.binding.genesisId, rootId: original.binding.rootId, directory,
      archiveDirectory: archive ?? null,
      owner: original.config.historyContext.owner, authority: original.config.context.authority, generation: original.config.root.generation,
      head: status.head, pending: status.pending, blocked: status.blocked, fenced: status.fenced,
      policyCurrent, policyExpiresAt: policy.expiresAt,
      members: original.config.members, routing: original.routing?.members ?? null,
      replacement: replacement?.review ?? null,
      retainedDigest: retained.stateDigest, startsService: false, readiness: 'unverified' };
    const review = { ...details, approvalDigest: historyDigest(`resonance:desktop-policy-observer:v1\n${JSON.stringify([input, original.binding, original.layout, previous, runtime, details])}`) };
    const check = () => {
      signal.throwIfAborted(); const current = snapshot(input);
      replacement?.assertCurrent();
      validateRelayServicePaths(service);
      if (JSON.stringify(current.binding) !== JSON.stringify(original.binding) || JSON.stringify(current.layout) !== JSON.stringify(original.layout)
        || JSON.stringify(current.config) !== JSON.stringify(original.config) || JSON.stringify(current.routing) !== JSON.stringify(original.routing)
        || JSON.stringify(observer.reviewRecoverySource()) !== JSON.stringify(retained) || runtimePath !== canonicalHistorySetupPath(runtimeDirectory)) {
        throw new Error('Observer inputs or retained evidence changed; review again');
      }
    };
    check(); let applied = false;
    return await operation({ input, binding: original.binding, runtime, review, apply(digest, beforeSave) {
      if (applied || digest !== review.approvalDigest) throw new Error('Observer selection requires matching unused approval');
      if (status.blocked || status.fenced) throw new Error('This observer is blocked or permanently fenced; retain its evidence and inspect its conflict or recovery status');
      check(); assertAdmissionPolicyCurrent(observer.policy(), Date.now()); beforeSave?.(); check();
      assertAdmissionPolicyCurrent(observer.policy(), Date.now()); applied = true;
      return { result: 'policy-observer-selected', startsService: false, readiness: 'unverified' };
    } });
  } finally { observer.close(); }
  } finally { replacement?.close(); }
}
