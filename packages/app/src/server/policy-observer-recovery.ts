/** Reviewed, resumable observer recovery under desktop maintenance exclusion. */
import { isAbsolute, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_AGREEMENT_MAX_VIEW } from '@resonance/core/history-agreement';
import { historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath, historySetupContains } from '@resonance/relay';
import { readOperatorFile } from '../../../relay/src/admission-operator-files.js';
import { readPolicyObserverConfigurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES } from '../../../relay/src/policy-observer-config.js';
import { readHistoryOperatorTransportFile } from '../../../relay/src/history-operator-transport.js';
import { runPolicyObserverCommand } from '../../../relay/src/policy-observer-command.js';

// Browser/server compile as independent projects; validate this structural wire
// shape here rather than importing browser sources into the server build.
export interface RelayPolicyObserverRecoveryInput {
  configurationFile: string; workspaceDirectory: string; restoredDirectory: string; outputFile: string;
  operatorTransportFile: string; source: 'available' | 'unavailable'; view: number;
}
export const policyObserverRecoveryActions = ['plan', 'start', 'status', 'step', 'review', 'restore', 'resume-plan', 'resume', 'export-plan', 'export'] as const;
export type RelayPolicyObserverRecoveryAction = typeof policyObserverRecoveryActions[number];
const pathFields = ['configurationFile', 'workspaceDirectory', 'restoredDirectory', 'outputFile', 'operatorTransportFile'] as const;
export function parseRelayPolicyObserverRecoveryInput(value: unknown): RelayPolicyObserverRecoveryInput {
  if (!exactWitnessFields(value, [...pathFields, 'source', 'view']) || !['available', 'unavailable'].includes(value.source as string)
    || !Number.isSafeInteger(value.view) || (value.view as number) < 1 || (value.view as number) > HISTORY_AGREEMENT_MAX_VIEW) {
    throw new Error('Select an explicit source availability and valid recovery view');
  }
  const input = { source: value.source, view: value.view } as RelayPolicyObserverRecoveryInput;
  for (const field of pathFields) {
    const path = value[field];
    if (path === '' && (field === 'operatorTransportFile' || field === 'outputFile')) { input[field] = ''; continue; }
    if (typeof path !== 'string' || !path.length || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Observer recovery paths must be absolute local paths');
    input[field] = resolve(path);
  }
  return input;
}
export async function runDesktopPolicyObserverRecovery(action: RelayPolicyObserverRecoveryAction, raw: unknown, approved: unknown,
  signal: AbortSignal, runtimeDirectory: string, beforeWrite: (locations: { directories: string[]; files: string[] }) => void): Promise<{
    input: RelayPolicyObserverRecoveryInput; result: Record<string, unknown> & { readiness: 'unverified'; startsService: false };
  }> {
  if (!policyObserverRecoveryActions.includes(action)) throw new Error('Unsupported observer recovery action');
  const input = parseRelayPolicyObserverRecoveryInput(raw), applying = ['start', 'restore', 'resume', 'export'].includes(action);
  if (applying ? !isHistoryDigest(approved) : approved !== undefined) throw new Error('Supply matching reviewed approval only for the selected recovery mutation');
  if (action.startsWith('export') && !input.outputFile) throw new Error('Select a new restored observer configuration output');
  signal.throwIfAborted();
  const read = () => {
    const config = readPolicyObserverConfigurationFile(input.configurationFile);
    return { config, routing: input.operatorTransportFile ? readHistoryOperatorTransportFile(input.operatorTransportFile, config.historyContext) : null };
  };
  const selected = read(), config = selected.config;
  const inputs: Array<[string, number]> = [[input.configurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES], [config.signingKeyFile, 4096],
    [config.storageKeyFile, 128], ...(input.operatorTransportFile ? [[input.operatorTransportFile, 65536]] as Array<[string, number]> : [])];
  const directories = [config.directory, input.workspaceDirectory, input.restoredDirectory];
  const layout = () => ({ directories: [...directories, runtimeDirectory].map(canonicalHistorySetupPath),
    files: inputs.map(([path]) => canonicalHistorySetupPath(path)), output: input.outputFile ? canonicalHistorySetupPath(input.outputFile) : null });
  const paths = layout(), overlaps = (a: string, b: string) => historySetupContains(a, b) || historySetupContains(b, a);
  if (paths.directories.some((directory, i) => paths.directories.some((other, j) => i !== j && overlaps(directory, other))
    || [...paths.files, ...(paths.output ? [paths.output] : [])].some(file => overlaps(directory, file)))) {
    throw new Error('Observer recovery requires separate source, workspace, restored history and runtime folders, with input/output files outside them');
  }
  const fingerprints = () => inputs.map(([path, maximum]) => {
    const bytes = readOperatorFile(path, maximum);
    try { return [canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const files = fingerprints();
  const check = () => {
    signal.throwIfAborted();
    if (JSON.stringify(paths) !== JSON.stringify(layout()) || JSON.stringify(selected) !== JSON.stringify(read())
      || JSON.stringify(files) !== JSON.stringify(fingerprints())) throw new Error('Observer recovery selection changed; retain all history and review again');
  };
  const occupied = () => {
    try { return readdirSync(input.restoredDirectory).length > 0; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; }
  };
  if ((action === 'plan' || action === 'start') && occupied()) throw new Error('New observer recovery requires an empty restoration destination');
  const options = { transportFile: input.operatorTransportFile || undefined }, base = [input.configurationFile, input.workspaceDirectory];
  const run = async (name: string, args: string[]): Promise<Record<string, unknown>> => ({ ...(await runPolicyObserverCommand(`recovery-${name}`, args, signal, options)).result });
  const retain = () => { beforeWrite({ directories: paths.directories.slice(0, 3), files: paths.output ? [paths.output] : [] }); check(); };
  check(); let result: Record<string, unknown>;
  if (action === 'status' || action === 'step') {
    if (action === 'step') retain();
    result = await run(action, base);
    if (result.complete === true) result = { ...result, destinationOccupied: occupied() };
  } else {
    const freezing = action === 'plan' || action === 'start', exporting = action === 'export-plan' || action === 'export';
    const resuming = action === 'resume-plan' || action === 'resume' || exporting;
    const args = [...base, ...(freezing ? [input.source, String(input.view)] : [input.restoredDirectory])];
    const original = await run(freezing ? 'plan' : resuming ? 'resume-plan' : 'review', args); check();
    const review = { ...original, ...(exporting ? { kind: 'policy-observer-configuration-export', output: paths.output } : {}),
      approvalDigest: historyDigest(`resonance:desktop-policy-observer-recovery:v1\n${JSON.stringify([input, paths, files, selected, original, exporting])}`) };
    if (!applying) result = review;
    else {
      if (approved !== review.approvalDigest) throw new Error('Observer recovery approval or evidence changed; review again');
      retain();
      result = await run(action, exporting ? [...args, input.outputFile] : ['--approve', String(original.approvalDigest), ...args]);
    }
  }
  check(); return { input, result: { ...result, readiness: 'unverified' as const, startsService: false as const } };
}
