/** File selection and service intent for authenticated desktop activation. No
 * shell commands, service installation or implicit history initialization. */
import { isAbsolute, resolve, dirname } from 'node:path';
import { getDataDir } from '@resonance/node';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyDigest, historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { MAX_ADMISSION_POLICY_BYTES } from '@resonance/core/admission-policy';
import { openAdmissionHistoryActivation, readHistoryEnrollmentFile, readOperatorJson } from '@resonance/relay';
import { parseAdmissionHistoryConfiguration, readAdmissionHistoryLinksFile } from '../../../relay/src/admission-history-config.js';
import { readOperatorFile, readOperatorSigningKey, readOperatorStorageKey } from '../../../relay/src/admission-operator-files.js';
import { createHistoryOperatorTransport, readHistoryOperatorTransportFile } from '../../../relay/src/history-operator-transport.js';
import { relayServiceRuntime, validateRelayServicePaths, type RelayServiceRoleFiles } from './relay-supervisor.js';
import type { RelayConfig } from './session.js';

export interface RelayHistoryActivationInput {
  historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string;
  authorityFile: string; historyDirectory: string; linksFile: string; operatorTransportFile: string;
}
const fields = ['historyConfigFile', 'enrollmentFile', 'policyFile', 'storageKeyFile', 'authorityFile', 'historyDirectory', 'linksFile', 'operatorTransportFile'] as const;
export function parseRelayHistoryActivationInput(value: unknown): RelayHistoryActivationInput {
  if (!exactWitnessFields(value, [...fields])) throw new Error('Supply the complete history activation file selection');
  const result = {} as RelayHistoryActivationInput;
  for (const field of fields) {
    const path = value[field];
    if (path === '' && (field === 'linksFile' || field === 'operatorTransportFile')) { result[field] = ''; continue; }
    if (typeof path !== 'string' || !path.length || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) {
      throw new Error('History activation paths must be absolute local paths');
    }
    result[field] = resolve(path);
  }
  return result;
}
export function historyActivationServiceFiles(input: RelayHistoryActivationInput): RelayServiceRoleFiles {
  return { admissionHistoryFile: input.historyConfigFile, admissionHistoryDirectory: input.historyDirectory,
    admissionHistoryLinksFile: input.linksFile, admissionAuthorityFile: input.authorityFile,
    admissionPolicyFile: input.policyFile, admissionPolicyKeyFile: input.storageKeyFile };
}
export async function withRelayHistoryActivation<T>(raw: unknown, previous: RelayConfig, runtimeDirectory: string, signal: AbortSignal,
  operation: (prepared: { activation: Awaited<ReturnType<typeof openAdmissionHistoryActivation>>; runtime: ReturnType<typeof relayServiceRuntime>;
    reviewedHistoryFiles: RelayServiceRoleFiles; input: RelayHistoryActivationInput; checkInputs: () => void }) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); const input = parseRelayHistoryActivationInput(raw);
  // Capture before parsing, then recheck before returning a review and after
  // network work. A file changed between reading and hashing must not be approved.
  const fileDigests = () => fields.filter(field => field !== 'historyDirectory' && input[field]).map(field => {
    const maximum = field === 'policyFile' ? MAX_ADMISSION_POLICY_BYTES : field === 'enrollmentFile' ? HISTORY_ENVELOPE_MAX_BYTES + 65536 : 65536;
    const bytes = readOperatorFile(input[field], maximum);
    try { return [field, historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const files = fileDigests();
  const config = parseAdmissionHistoryConfiguration(readOperatorJson(input.historyConfigFile, 65536));
  const signingKey = readOperatorSigningKey(resolve(dirname(input.historyConfigFile), config.ownerKeyFile));
  let storageKey: Buffer | undefined;
  let transport: ReturnType<typeof createHistoryOperatorTransport> | undefined;
  let activation: Awaited<ReturnType<typeof openAdmissionHistoryActivation>> | undefined;
  try {
    if (Buffer.from(signingKey.publicKey).toString('base64url') !== config.context.owner) throw new Error('Owner key differs from history pins');
    storageKey = readOperatorStorageKey(input.storageKeyFile);
    const authorityBytes = readOperatorFile(input.authorityFile, 256);
    let authority: string; try { authority = authorityBytes.toString('utf8').trim(); } finally { authorityBytes.fill(0); }
    if (authority !== config.context.authority) throw new Error('Policy authority file differs from protected history');
    const enrollment = readHistoryEnrollmentFile(input.enrollmentFile);
    if (enrollment.contextId !== historyCheckpointContextId(config.context)) throw new Error('Enrollment and protected history pins differ');
    if (input.linksFile) readAdmissionHistoryLinksFile(input.linksFile, config.context);
    const operatorConfiguration = input.operatorTransportFile ? readHistoryOperatorTransportFile(input.operatorTransportFile, config.context) : null;
    const reviewedHistoryFiles = historyActivationServiceFiles(input);
    const runtime = relayServiceRuntime(previous.runtime, reviewedHistoryFiles);
    validateRelayServicePaths({ ...runtime, dataDir: getDataDir(), port: previous.port, adminKey: previous.adminKey ?? '', contacts: previous.contacts ?? [], controls: previous.controls });
    // Bind original file bytes as well as parsed context, key and destination.
    // Recheck after network work before persisting paths the service will reopen.
    const checkInputs = () => {
      signal.throwIfAborted();
      const operator = input.operatorTransportFile ? readHistoryOperatorTransportFile(input.operatorTransportFile, config.context) : null;
      if (JSON.stringify(fileDigests()) !== JSON.stringify(files) || JSON.stringify(operator) !== JSON.stringify(operatorConfiguration)) {
        throw new Error('Activation input files changed; retain maintenance and review again');
      }
    };
    const intentDigest = historyDigest(`resonance:desktop-history-activation:v1\n${JSON.stringify([input, previous, runtime, files, operatorConfiguration])}`);
    transport = createHistoryOperatorTransport({ context: config.context, members: config.members, signingKey }, input.operatorTransportFile || undefined, signal);
    activation = await openAdmissionHistoryActivation({ runtimeDirectory, historyDirectory: input.historyDirectory,
      policy: readOperatorJson(input.policyFile, MAX_ADMISSION_POLICY_BYTES), encryptionKey: storageKey, protection: transport.protection,
      genesis: enrollment.root, intentDigest, signal });
    checkInputs(); return await operation({ activation, runtime, reviewedHistoryFiles, input, checkInputs });
  } finally {
    try { activation?.close(); } finally { transport?.close(); storageKey?.fill(0); signingKey.secretKey.fill(0); }
  }
}
