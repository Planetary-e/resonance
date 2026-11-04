/** Fixed reviewed observer preparation/enrollment actions. No arbitrary commands. */
import { isAbsolute, resolve } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath, historySetupContains } from '@resonance/relay';
import { openPolicyObserverSetup, policyObserverEnrollment, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES } from '../../../relay/src/policy-observer-setup.js';
import { readPolicyObserverConfigurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES } from '../../../relay/src/policy-observer-config.js';
import { readOperatorFile, writeOperatorJsonNew } from '../../../relay/src/admission-operator-files.js';
import { readHistoryOperatorTransportFile } from '../../../relay/src/history-operator-transport.js';
import { runPolicyObserverCommand } from '../../../relay/src/policy-observer-command.js';
export type RelayPolicyObserverSetupInput =
  | { role: 'prepare'; setupFile: string; output: string }
  | { role: 'export-prepared'; setupFile: string; output: string }
  | { role: 'enrollment-export'; configurationFile: string; output: string }
  | { role: 'initialize'; configurationFile: string; operatorTransportFile: string }
  | { role: 'enroll'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'resume-enrollment'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string };
export interface RelayPolicyObserverSetupResult {
  kind?: string; result?: string; approvalDigest?: string; directory?: string; output?: string; anchor?: string;
  contextId?: string; genesisId?: string | null; owner?: string; member?: string; policyRevision?: number;
  members?: Array<{ publicKey: string; endpoint: string }>;
  readiness: 'unverified'; startsService: false;
}


const fields = {
  prepare: ['setupFile', 'output'], 'export-prepared': ['setupFile', 'output'],
  'enrollment-export': ['configurationFile', 'output'], initialize: ['configurationFile', 'operatorTransportFile'],
  enroll: ['enrollmentFile', 'signingKeyFile', 'storageKeyFile', 'directory'],
  'resume-enrollment': ['enrollmentFile', 'signingKeyFile', 'storageKeyFile', 'directory'],
} as const;
export function parseRelayPolicyObserverSetupInput(value: unknown): RelayPolicyObserverSetupInput {
  const raw = value as Record<string, unknown> | null;
  if (!raw || !Object.hasOwn(fields, raw.role as string)) throw new Error('Choose a supported observer setup operation');
  const role = raw.role as RelayPolicyObserverSetupInput['role'];
  if (!exactWitnessFields(raw, ['role', ...fields[role]])) throw new Error('Supply the exact fields for this observer setup operation');
  const input: Record<string, unknown> = { role };
  for (const field of fields[role]) {
    const path = raw[field]; if (field === 'operatorTransportFile' && path === '') { input[field] = ''; continue; }
    if (typeof path !== 'string' || !path.length || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Observer setup paths must be absolute local paths');
    input[field] = resolve(path);
  }
  return input as unknown as RelayPolicyObserverSetupInput;
}
export async function runDesktopPolicyObserverSetup(action: 'review' | 'apply', raw: unknown, approved: unknown,
  signal: AbortSignal, runtimeDirectory: string, beforeWrite: (locations: { directories: string[]; files: string[] }) => void) {
  if (!['review', 'apply'].includes(action) || (action === 'apply' ? !isHistoryDigest(approved) : approved !== undefined)) throw new Error('Observer setup requires matching reviewed approval');
  const input = parseRelayPolicyObserverSetupInput(raw); signal.throwIfAborted();
  let close = () => {}, original: Record<string, unknown>, apply: (digest: string) => Promise<object> | object;
  let directories: string[] = [], files: string[] = [], inputs: Array<[string, number]> = [], parsed: unknown;
  let readParsed = (): unknown => undefined;
  try {
    if (input.role === 'prepare' || input.role === 'export-prepared') {
      const setup = await openPolicyObserverSetup({ setupFile: input.setupFile, output: input.output,
        mode: input.role === 'prepare' ? 'new' : 'export' }, signal); close = setup.close;
      original = setup.review(); apply = setup.apply;
      const locations = setup.locations(); directories = locations.directories; files = locations.files;
      // The shared setup owns the exact limits and independently binds every
      // referenced file. Here they are also checked against the runtime layout.
      inputs = locations.inputs.map(path => [path, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES]);
    } else if (input.role === 'enrollment-export' || input.role === 'initialize') {
      readParsed = () => {
        const config = readPolicyObserverConfigurationFile(input.configurationFile);
        const routing = input.role === 'initialize' && input.operatorTransportFile
          ? readHistoryOperatorTransportFile(input.operatorTransportFile, config.historyContext) : null;
        return { config, routing };
      };
      const selected = readParsed() as { config: ReturnType<typeof readPolicyObserverConfigurationFile> }; parsed = selected;
      const config = selected.config;
      directories = input.role === 'initialize' ? [config.directory] : [];
      inputs = [[input.configurationFile, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES],
        ...(input.role === 'initialize' ? [[config.signingKeyFile, 4096], [config.storageKeyFile, 128],
          ...(input.operatorTransportFile ? [[input.operatorTransportFile, 65536]] : [])] as Array<[string, number]> : [])];
      if (input.role === 'enrollment-export') {
        const enrollment = policyObserverEnrollment(config); files = [input.output];
        original = { kind: 'policy-observer-enrollment-export', output: canonicalHistorySetupPath(input.output),
          contextId: historyCheckpointContextId(config.historyContext), genesisId: historyCheckpointEnvelopeId(config.genesis), owner: config.historyContext.owner };
        apply = () => { writeOperatorJsonNew(input.output, enrollment, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES); return { result: 'policy-enrollment-exported', output: input.output }; };
      } else {
        const args = [input.configurationFile], options = { transportFile: input.operatorTransportFile || undefined };
        original = { ...(await runPolicyObserverCommand('initialize-plan', args, signal, options)).result };
        apply = async digest => (await runPolicyObserverCommand('initialize', ['--approve', digest, ...args], signal, options)).result;
      }
    } else {
      directories = [input.directory]; inputs = [[input.enrollmentFile, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES], [input.signingKeyFile, 4096], [input.storageKeyFile, 128]];
      const args = [input.enrollmentFile, input.signingKeyFile, input.storageKeyFile, input.directory], resume = input.role === 'resume-enrollment';
      original = { ...(await runPolicyObserverCommand(resume ? 'replica-resume-plan' : 'replica-plan', args, signal)).result };
      apply = async digest => (await runPolicyObserverCommand(resume ? 'replica-resume' : 'replica-enroll', ['--approve', digest, ...args], signal)).result;
    }
    const layout = () => ({ runtime: canonicalHistorySetupPath(runtimeDirectory), directories: directories.map(canonicalHistorySetupPath),
      files: files.map(canonicalHistorySetupPath), inputs: inputs.map(([path]) => canonicalHistorySetupPath(path)) });
    const paths = layout();
    const overlaps = (a: string, b: string) => historySetupContains(a, b) || historySetupContains(b, a);
    if ([...paths.directories, ...paths.files, ...paths.inputs].some(path => overlaps(paths.runtime, path))
      || paths.directories.some(directory => [...paths.files, ...paths.inputs].some(path => overlaps(directory, path)))) {
      throw new Error('Keep observer history, inputs and outputs separate from the relay runtime and keep files outside history directories');
    }
    const fingerprints = () => inputs.map(([path, maximum]) => {
      const bytes = readOperatorFile(path, maximum);
      try { return [canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
    });
    const captured = fingerprints();
    const check = () => {
      signal.throwIfAborted();
      if (JSON.stringify(paths) !== JSON.stringify(layout()) || JSON.stringify(captured) !== JSON.stringify(fingerprints())
        || JSON.stringify(parsed) !== JSON.stringify(readParsed())) throw new Error('Observer setup selection changed; retain created files and review again');
    };
    check();
    const approvalDigest = historyDigest(`resonance:desktop-policy-observer-setup:v1\n${JSON.stringify([input, paths, captured, parsed, original])}`);
    let result: object = { ...original, approvalDigest };
    if (action === 'apply') {
      if (approved !== approvalDigest) throw new Error('Observer setup approval changed; review again');
      beforeWrite({ directories: paths.directories, files: paths.files }); check();
      result = await apply(String(original.approvalDigest)); check();
      if ('approvalDigest' in result) { const { approvalDigest: _, ...completed } = result; result = completed; }
    }
    return { input, result: { ...result, readiness: 'unverified', startsService: false } as RelayPolicyObserverSetupResult };
  } finally { close(); }
}
