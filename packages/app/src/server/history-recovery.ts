/** The desktop exposes fixed recovery operations, never arbitrary CLI commands. */
import { isAbsolute, resolve, dirname, basename, relative } from 'node:path';
import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_AGREEMENT_MAX_VIEW } from '@resonance/core/history-agreement';
import { MAX_ADMISSION_POLICY_BYTES, verifyAdmissionPolicy, assertAdmissionPolicyCurrent } from '@resonance/core/admission-policy';
import { HISTORY_ENVELOPE_MAX_BYTES, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { runAdmissionHistoryCommand, readOperatorJson } from '@resonance/relay';
import { readOperatorFile } from '../../../relay/src/admission-operator-files.js';
import { parseAdmissionHistoryConfiguration } from '../../../relay/src/admission-history-config.js';
import { readHistoryOperatorTransportFile } from '../../../relay/src/history-operator-transport.js';
// The server and browser compile as separate projects; keep this wire shape
// structural and validate it at the server boundary.
export interface RelayHistoryRecoveryInput {
  historyConfigFile: string; enrollmentFile: string; storageKeyFile: string; workspaceDirectory: string;
  policyFile: string; historyDirectory: string; operatorTransportFile: string; view: number;
}
export const historyRecoveryActions = ['plan', 'start', 'status', 'step', 'review', 'restore', 'readiness-plan', 'ready'] as const;
export type RelayHistoryRecoveryAction = typeof historyRecoveryActions[number];
const paths = ['historyConfigFile', 'enrollmentFile', 'storageKeyFile', 'workspaceDirectory', 'policyFile', 'historyDirectory', 'operatorTransportFile'] as const;
export function parseRelayHistoryRecoveryInput(value: unknown): RelayHistoryRecoveryInput {
  if (!exactWitnessFields(value, [...paths, 'view']) || !Number.isSafeInteger(value.view)
    || (value.view as number) < 1 || (value.view as number) > HISTORY_AGREEMENT_MAX_VIEW) throw new Error('Supply the complete recovery selection and an explicit valid view');
  const input = { view: value.view } as RelayHistoryRecoveryInput;
  for (const field of paths) {
    const path = value[field];
    if (path === '' && field === 'operatorTransportFile') { input[field] = ''; continue; }
    if (typeof path !== 'string' || !path.length || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) {
      throw new Error('Recovery paths must be absolute local paths');
    }
    input[field] = resolve(path);
  }
  return input;
}

function canonicalDirectory(path: string): string {
  const missing: string[] = []; let ancestor = path;
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  return resolve(realpathSync(ancestor), ...missing);
}
function contains(parent: string, child: string) {
  const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}
export async function runDesktopHistoryRecovery(action: RelayHistoryRecoveryAction, raw: unknown, approved: unknown, signal: AbortSignal, runtimeDirectory: string) {
  if (!historyRecoveryActions.includes(action)) throw new Error('Unsupported history recovery operation');
  const input = parseRelayHistoryRecoveryInput(raw), mutating = ['start', 'restore', 'ready'].includes(action);
  if (mutating ? !isHistoryDigest(approved) : approved !== undefined) throw new Error('Supply the exact reviewed approval only when starting or restoring');
  signal.throwIfAborted();
  const directories = () => [input.workspaceDirectory, input.historyDirectory, runtimeDirectory].map(canonicalDirectory);
  const layout = directories();
  if (layout.some((path, i) => layout.some((other, j) => i !== j && contains(path, other)))) {
    throw new Error('Recovery workspace, restored history and relay runtime must use separate nonoverlapping folders');
  }
  if (action === 'plan' || action === 'start') {
    try { if (readdirSync(input.historyDirectory).length) throw new Error('Restoration requires a new empty history folder'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Selection includes policy/destination even during freeze review, so edits
  // invalidate the displayed approval. Status/steps reopen the retained journal.
  const fileDigests = () => paths.filter(field => field !== 'workspaceDirectory' && field !== 'historyDirectory' && input[field]).map(field => {
    const maximum = field === 'policyFile' ? MAX_ADMISSION_POLICY_BYTES : field === 'enrollmentFile' ? HISTORY_ENVELOPE_MAX_BYTES + 65536 : 65536;
    const bytes = readOperatorFile(input[field], maximum);
    try { return [field, historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const files = fileDigests(), configuration = parseAdmissionHistoryConfiguration(readOperatorJson(input.historyConfigFile, 65536));
  if (action === 'plan' || action === 'start') {
    const policy = await verifyAdmissionPolicy(readOperatorJson(input.policyFile, MAX_ADMISSION_POLICY_BYTES), configuration.context.authority);
    assertAdmissionPolicyCurrent(policy, Date.now());
  }
  const routing = () => input.operatorTransportFile ? readHistoryOperatorTransportFile(input.operatorTransportFile, configuration.context) : null;
  const operator = routing();
  const check = () => {
    signal.throwIfAborted();
    if (JSON.stringify(files) !== JSON.stringify(fileDigests()) || JSON.stringify(operator) !== JSON.stringify(routing())
      || JSON.stringify(layout) !== JSON.stringify(directories())) {
      throw new Error('Recovery input files changed; retain pending work and review the selection again');
    }
  };
  const args = [input.historyConfigFile, input.enrollmentFile, input.storageKeyFile, input.workspaceDirectory];
  const commandOptions = { transportFile: input.operatorTransportFile || undefined, signal };
  const run = async (name: string, arguments_: string[]) => (await runAdmissionHistoryCommand(`owner-recovery-${name}`, arguments_, commandOptions)).result;
  const bind = (review: Record<string, unknown>) => ({ ...review, approvalDigest: historyDigest(
    `resonance:desktop-history-recovery:v1\n${JSON.stringify([input, layout, files, operator, review])}`) });
  let result: Record<string, unknown>;
  if (['plan', 'start', 'review', 'restore', 'readiness-plan', 'ready'].includes(action)) {
    const freeze = action === 'plan' || action === 'start';
    const readiness = action === 'readiness-plan' || action === 'ready';
    const arguments_ = [...args, ...(freeze ? [String(input.view)] : [input.policyFile, input.historyDirectory])];
    const original = await run(freeze ? 'plan' : readiness ? 'readiness-plan' : 'review', arguments_); check();
    const review = bind(original);
    if (mutating) {
      if (review.approvalDigest !== approved) throw new Error('Recovery approval or selection changed; review again');
      result = await run(action, ['--approve', String(original.approvalDigest), ...arguments_]);
    } else result = review;
  } else {
    result = await run(action, args);
    if (result.complete === true) {
      let destinationOccupied = false;
      try { destinationOccupied = readdirSync(input.historyDirectory).length > 0; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      result = { ...result, destinationOccupied };
    }
  }
  check(); return { input, result };
}
