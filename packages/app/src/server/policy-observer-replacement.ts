/** Hold an independently verified recovery workspace while selecting its successor. */
import { canonicalHistorySetupPath } from '@resonance/relay';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest } from '@resonance/core/history-checkpoint';
import { readOperatorFile, readOperatorSigningKey, readOperatorStorageKey } from '../../../relay/src/admission-operator-files.js';
import { readPolicyObserverConfigurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES } from '../../../relay/src/policy-observer-config.js';
import { openPolicyObserverRecovery } from '../../../relay/src/policy-observer-recovery.js';
import { parseRelayPolicyObserverRecoveryInput } from './policy-observer-recovery.js';
import type { RelayPolicyObserverBinding, RelayPolicyObserverInput } from './policy-observer-activation.js';
import type { RelayConfig } from './session.js';

export async function openDesktopPolicyObserverReplacement(previous: RelayConfig, prior: RelayPolicyObserverBinding,
  target: RelayPolicyObserverInput, next: ReturnType<typeof readPolicyObserverConfigurationFile>, signal: AbortSignal) {
  if (!previous.policyObserverRecoveryInput) throw new Error('Observer selection must retain its history and location; changing generation requires reviewed recovery');
  const recoveryInput = parseRelayPolicyObserverRecoveryInput(previous.policyObserverRecoveryInput);
  if (!recoveryInput.outputFile || canonicalHistorySetupPath(recoveryInput.outputFile) !== canonicalHistorySetupPath(target.configurationFile)
    || canonicalHistorySetupPath(recoveryInput.restoredDirectory) !== canonicalHistorySetupPath(next.directory)) {
    throw new Error('Select the restored configuration exported from the saved recovery workspace');
  }
  const config = readPolicyObserverConfigurationFile(recoveryInput.configurationFile);
  if (historyCheckpointContextId(config.historyContext) !== prior.contextId || historyCheckpointEnvelopeId(config.genesis) !== prior.genesisId
    || historyCheckpointEnvelopeId(config.root) !== prior.rootId || canonicalHistorySetupPath(config.directory) !== prior.directory
    || historyCheckpointContextId(next.historyContext) !== prior.contextId || historyCheckpointEnvelopeId(next.genesis) !== prior.genesisId
    || next.root.generation <= config.root.generation) throw new Error('Recovery replacement must continue the selected observer and original history');
  const sources: Array<[string, number]> = [[recoveryInput.configurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES],
    [config.signingKeyFile, 4096], [config.storageKeyFile, 128]];
  const capture = () => sources.map(([path, maximum]) => {
    const bytes = readOperatorFile(path, maximum);
    try { return [canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const captured = capture(), workspace = canonicalHistorySetupPath(recoveryInput.workspaceDirectory);
  const check = () => {
    signal.throwIfAborted();
    if (JSON.stringify(captured) !== JSON.stringify(capture()) || workspace !== canonicalHistorySetupPath(recoveryInput.workspaceDirectory)
      || JSON.stringify(config) !== JSON.stringify(readPolicyObserverConfigurationFile(recoveryInput.configurationFile))) {
      throw new Error('Recovery replacement inputs changed; review again');
    }
  };
  check(); const signingKey = readOperatorSigningKey(config.signingKeyFile);
  let key: Buffer | undefined, recovery: Awaited<ReturnType<typeof openPolicyObserverRecovery>> | undefined, closed = false;
  const close = () => { if (!closed) { closed = true; recovery?.close(); key?.fill(0); signingKey.secretKey.fill(0); } };
  try {
    key = readOperatorStorageKey(config.storageKeyFile);
    recovery = await openPolicyObserverRecovery({ directory: workspace, context: config.context, historyContext: config.historyContext,
      genesis: config.genesis, members: config.members, signingKey, encryptionKey: key });
    check(); const inspected = await recovery.inspectRestored(next.directory, signal); check();
    if (JSON.stringify(inspected.continuation) !== JSON.stringify(next.root)) throw new Error('Selected observer root does not match the independently verified recovery');
    return { close, assertCurrent() { if (closed) throw new Error('Recovery replacement review closed'); check(); },
      review: { kind: 'policy-observer-generation-replacement', workspaceDirectory: workspace,
        previousDirectory: prior.directory, previousRootId: prior.rootId, rootId: historyCheckpointEnvelopeId(next.root), generation: next.root.generation } };
  } catch (error) { close(); throw error; }
}
