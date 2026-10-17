/** Fixed offline desktop enrollment actions, under stopped-runtime exclusion. */
import { isAbsolute, resolve } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { MAX_ADMISSION_POLICY_BYTES } from '@resonance/core/admission-policy';
import { canonicalHistorySetupPath, historySetupContains, reviewAdmissionOwnerConfiguration, openAdmissionOwnerSetup, openAdmissionOwnerLimits, runAdmissionHistoryCommand } from '@resonance/relay';
import { readOperatorFile } from '../../../relay/src/admission-operator-files.js';
import { parseAdmissionHistoryConfiguration } from '../../../relay/src/admission-history-config.js';
import { readOperatorJson } from '../../../relay/src/admission-operator-files.js';
import { readHistoryOperatorTransportFile } from '../../../relay/src/history-operator-transport.js';

export type RelayHistorySetupInput =
  | { role: 'configuration'; ownerKeyFile: string; authorityFile: string; policyFile: string; membersFile: string; output: string; historyId: string }
  | { role: 'owner'; historyConfigFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; mode: 'new' | 'resume' | 'export' }
  | { role: 'volunteer'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'volunteer-resume'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'owner-limits'; historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; archiveMiB: number; archiveBlocks: number }
  | { role: 'readiness'; historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; operatorTransportFile: string };
const fields = {
  configuration: ['ownerKeyFile', 'authorityFile', 'policyFile', 'membersFile', 'output'],
  owner: ['historyConfigFile', 'policyFile', 'storageKeyFile', 'directory', 'output'],
  volunteer: ['enrollmentFile', 'signingKeyFile', 'storageKeyFile', 'directory'],
  'volunteer-resume': ['enrollmentFile', 'signingKeyFile', 'storageKeyFile', 'directory'],
  'owner-limits': ['historyConfigFile', 'enrollmentFile', 'policyFile', 'storageKeyFile', 'directory', 'output'],
  readiness: ['historyConfigFile', 'enrollmentFile', 'policyFile', 'storageKeyFile', 'directory', 'operatorTransportFile'],
} as const;
export function parseRelayHistorySetupInput(value: unknown): RelayHistorySetupInput {
  const raw = value as Record<string, unknown> | null;
  if (!raw || !['configuration', 'owner', 'volunteer', 'volunteer-resume', 'owner-limits', 'readiness'].includes(raw.role as string)) throw new Error('Select a supported initial setup role');
  const role = raw.role as RelayHistorySetupInput['role'];
  if (!exactWitnessFields(raw, ['role', ...fields[role], ...(role === 'configuration' ? ['historyId'] : role === 'owner' ? ['mode'] : role === 'owner-limits' ? ['archiveMiB', 'archiveBlocks'] : [])])) {
    throw new Error('Supply the exact fields for the selected setup role');
  }
  const input: Record<string, unknown> = { ...raw };
  for (const field of fields[role]) {
    const path = raw[field];
    if (field === 'operatorTransportFile' && path === '') continue;
    if (typeof path !== 'string' || !path.length || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) throw new Error('Setup paths must be absolute local paths');
    input[field] = resolve(path);
  }
  if (role === 'configuration' && (typeof raw.historyId !== 'string' || (raw.historyId !== '' && !/^[A-Za-z0-9_-]{43}$/.test(raw.historyId)))) throw new Error('Invalid initial history identifier');
  if (role === 'owner' && !['new', 'resume', 'export'].includes(raw.mode as string)) throw new Error('Select an explicit owner preparation mode');
  if (role === 'owner-limits' && (!Number.isSafeInteger(raw.archiveMiB) || (raw.archiveMiB as number) < 1 || (raw.archiveMiB as number) > 64
    || !Number.isSafeInteger(raw.archiveBlocks) || (raw.archiveBlocks as number) < 1 || (raw.archiveBlocks as number) > 10001)) throw new Error('Owner archive limits are outside supported bounds');
  return input as unknown as RelayHistorySetupInput;
}

export async function runDesktopHistorySetup(action: 'review' | 'apply', raw: unknown, approved: unknown, signal: AbortSignal, runtimeDirectory: string) {
  if (!['review', 'apply'].includes(action) || (action === 'apply' ? !isHistoryDigest(approved) : approved !== undefined)) throw new Error('Setup apply needs the exact reviewed approval');
  let input = parseRelayHistorySetupInput(raw); signal.throwIfAborted();
  const target = input.role === 'configuration' ? input.output : input.directory;
  const layout = () => [canonicalHistorySetupPath(target), canonicalHistorySetupPath(runtimeDirectory)];
  const paths = layout();
  if (historySetupContains(paths[0], paths[1]) || historySetupContains(paths[1], paths[0])) throw new Error('Initial history setup must use a separate location from the relay runtime');
  if (input.role !== 'configuration') {
    for (const field of fields[input.role].filter(field => field !== 'directory')) {
      const path = (input as unknown as Record<string, string>)[field];
      if (path === '' && field === 'operatorTransportFile') continue;
      if (historySetupContains(paths[0], canonicalHistorySetupPath(path))) throw new Error('Keep enrollment, keys and configuration outside the dedicated history directory');
    }
    if ((input.role === 'owner' || input.role === 'owner-limits') && historySetupContains(paths[1], canonicalHistorySetupPath(input.output))) throw new Error('Keep the enrollment backup outside the relay runtime');
  }
  const digestFiles = () => fields[input.role].filter(field => !['directory', 'output'].includes(field)
    && (input as unknown as Record<string, string>)[field]).map(field => {
    const path = (input as unknown as Record<string, string>)[field];
    const maximum = field === 'policyFile' ? MAX_ADMISSION_POLICY_BYTES : field === 'enrollmentFile' ? HISTORY_ENVELOPE_MAX_BYTES + 65536 : 65536;
    const bytes = readOperatorFile(path, maximum);
    try { return [field, canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const files = digestFiles();
  const routing = () => input.role === 'readiness' && input.operatorTransportFile
    ? readHistoryOperatorTransportFile(input.operatorTransportFile, parseAdmissionHistoryConfiguration(readOperatorJson(input.historyConfigFile, 65536)).context) : null;
  const operator = routing();
  const check = () => {
    signal.throwIfAborted();
    if (JSON.stringify(paths) !== JSON.stringify(layout()) || JSON.stringify(files) !== JSON.stringify(digestFiles())
      || JSON.stringify(operator) !== JSON.stringify(routing())) throw new Error('Setup selection changed; retain any created files and review again');
  };
  let original: Record<string, unknown>, apply: (digest: string) => Promise<object> | object, close = () => {};
  try {
    if (input.role === 'configuration') {
      if (action === 'apply' && !input.historyId) throw new Error('Apply needs the identifier returned by configuration review');
      const preparation = await reviewAdmissionOwnerConfiguration({ ...input, historyId: input.historyId || undefined }, signal);
      input = { ...input, historyId: preparation.review.historyId }; original = preparation.review; apply = preparation.apply;
    } else if (input.role === 'owner') {
      const preparation = await openAdmissionOwnerSetup(input, signal); close = preparation.close;
      original = preparation.review(); apply = preparation.apply;
    } else if (input.role === 'owner-limits') {
      const preparation = await openAdmissionOwnerLimits(input, signal); close = preparation.close;
      original = preparation.review; apply = preparation.apply;
    } else if (input.role === 'volunteer' || input.role === 'volunteer-resume') {
      const args = [input.enrollmentFile, input.signingKeyFile, input.storageKeyFile, input.directory];
      original = (await runAdmissionHistoryCommand(input.role === 'volunteer-resume' ? 'replica-resume-plan' : 'replica-plan', args, { signal })).result;
      const command = input.role === 'volunteer-resume' ? 'replica-resume' : 'replica-enroll';
      apply = async digest => (await runAdmissionHistoryCommand(command, ['--approve', digest, ...args], { signal })).result;
    } else {
      const args = [input.historyConfigFile, input.enrollmentFile, input.policyFile, input.storageKeyFile, input.directory];
      const options = { signal, transportFile: input.operatorTransportFile || undefined };
      original = (await runAdmissionHistoryCommand('owner-initial-readiness-plan', args, options)).result;
      apply = async digest => (await runAdmissionHistoryCommand('owner-initial-ready', ['--approve', digest, ...args], options)).result;
    }
    check();
    const review = { ...original, approvalDigest: historyDigest(`resonance:desktop-history-setup:v1\n${JSON.stringify([input, paths, files, operator, original])}`) };
    let result: object = review;
    if (action === 'apply') {
      if (approved !== review.approvalDigest) throw new Error('Setup approval or selection changed; review again');
      result = await apply(String(original.approvalDigest)); check();
      if ('approvalDigest' in result) { const { approvalDigest: _, ...completed } = result; result = completed; }
    }
    return { input, result: { ...result, readiness: input.role === 'readiness' && action === 'apply' ? 'confirmed' as const : 'unverified' as const, startsService: false as const } };
  } finally { close(); }
}
