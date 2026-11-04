/** Offline, reviewed initial setup. None of these operations establishes quorum
 * readiness, replaces accepted history, or starts a service. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAX_ADMISSION_POLICY_BYTES, admissionPolicyDigest, assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest } from '@resonance/core/history-checkpoint';
import { loadAdmissionHistoryProtectionFile, parseAdmissionHistoryConfiguration } from './admission-history-config.js';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { inspectProtectedAdmissionSpendHistory, openProtectedAdmissionSpendHistory } from './protected-admission-history.js';

export function canonicalHistorySetupPath(path: string): string {
  const missing: string[] = []; let ancestor = resolve(path);
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  return resolve(realpathSync(ancestor), ...missing);
}
export function historySetupContains(parent: string, child: string) {
  const suffix = relative(parent, child);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\') && !isAbsolute(suffix));
}
function present(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function newOutput(path: string) {
  if (present(path)) throw new Error('Setup output already exists; retain it and select another output path');
  if (!lstatSync(dirname(path)).isDirectory()) throw new Error('Setup output needs an existing parent directory');
}
function emptyDirectory(path: string) {
  if (present(path) && readdirSync(path).length) throw new Error('New owner setup requires an empty directory; use recovery for retained history');
}
function capture(files: Array<[string, number]>) {
  return files.map(([path, maximum]) => {
    const bytes = readOperatorFile(path, maximum);
    try { return [resolve(path), canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
}

export interface AdmissionOwnerConfigurationInput {
  ownerKeyFile: string; authorityFile: string; policyFile: string; membersFile: string; output: string; historyId?: string;
}
export async function reviewAdmissionOwnerConfiguration(input: AdmissionOwnerConfigurationInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const output = canonicalHistorySetupPath(input.output); newOutput(output);
  const files: Array<[string, number]> = [[input.ownerKeyFile, 4096], [input.authorityFile, 256], [input.policyFile, MAX_ADMISSION_POLICY_BYTES], [input.membersFile, 65536]];
  const captured = capture(files), signingKey = readOperatorSigningKey(input.ownerKeyFile);
  let owner: string;
  try { owner = Buffer.from(signingKey.publicKey).toString('base64url'); } finally { signingKey.secretKey.fill(0); }
  const authorityBytes = readOperatorFile(input.authorityFile, 256);
  let authority: string;
  try { authority = authorityBytes.toString('utf8').trim(); } finally { authorityBytes.fill(0); }
  const policy = await verifyAdmissionPolicy(readOperatorJson(input.policyFile, MAX_ADMISSION_POLICY_BYTES), authority);
  assertAdmissionPolicyCurrent(policy, Date.now()); signal?.throwIfAborted();
  const members = readOperatorJson(input.membersFile, 65536);
  if (!Array.isArray(members) || members.length !== 5 || members.some(member => !exactWitnessFields(member, ['publicKey', 'endpoint']))) {
    throw new Error('Supply five explicit pinned member records');
  }
  const context = { version: 1, role: 'relay-admission-spends', historyId: input.historyId ?? randomBytes(32).toString('base64url'),
    owner, authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}`, members: members.map(member => member.publicKey).sort(), quorum: 4 };
  const configuration = parseAdmissionHistoryConfiguration({ version: 1, context, members, ownerKeyFile: resolve(input.ownerKeyFile) });
  const details = { kind: 'new-owner-configuration' as const, output, contextId: historyCheckpointContextId(configuration.context),
    historyId: configuration.context.historyId, owner, authority, members: configuration.members, policyRevision: policy.revision,
    readiness: 'unverified' as const, startsService: false as const };
  const review = { ...details, approvalDigest: historyDigest(`resonance:owner-configuration-review:v1\n${JSON.stringify([details, captured, configuration])}`) };
  const check = () => {
    signal?.throwIfAborted(); assertAdmissionPolicyCurrent(policy, Date.now());
    if (output !== canonicalHistorySetupPath(input.output) || JSON.stringify(captured) !== JSON.stringify(capture(files))) throw new Error('Owner configuration selection changed; review again');
    newOutput(output);
  };
  check(); let applied = false;
  return { review: structuredClone(review), apply(approved: string) {
    if (applied || approved !== review.approvalDigest) throw new Error('Owner configuration approval changed or was already applied');
    check(); writeOperatorJsonNew(output, configuration, 65536); applied = true;
    return { ...details, result: 'new-owner-configuration' as const };
  } };
}

export type AdmissionOwnerSetupMode = 'new' | 'resume' | 'export';
export interface AdmissionOwnerSetupInput {
  historyConfigFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; mode: AdmissionOwnerSetupMode;
}
export async function openAdmissionOwnerSetup(input: AdmissionOwnerSetupInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!['new', 'resume', 'export'].includes(input.mode)) throw new Error('Invalid owner setup mode');
  const directory = canonicalHistorySetupPath(input.directory), output = canonicalHistorySetupPath(input.output);
  newOutput(output); if (input.mode === 'new') emptyDirectory(directory);
  const sourceFiles: Array<[string, number]> = [[input.historyConfigFile, 65536], [input.policyFile, MAX_ADMISSION_POLICY_BYTES], [input.storageKeyFile, 128]];
  const sources = capture(sourceFiles);
  const config = parseAdmissionHistoryConfiguration(readOperatorJson(input.historyConfigFile, 65536));
  const ownerKeyFile = resolve(dirname(resolve(input.historyConfigFile)), config.ownerKeyFile);
  const files: Array<[string, number]> = [...sourceFiles, [ownerKeyFile, 4096]];
  const captured = [...sources, ...capture([[ownerKeyFile, 4096]])];
  if ([output, ...files.map(([path]) => canonicalHistorySetupPath(path))].some(path => historySetupContains(directory, path))) {
    throw new Error('Keep owner setup keys, configuration, policy and enrollment backup outside its history directory');
  }
  const protection = loadAdmissionHistoryProtectionFile(input.historyConfigFile);
  // Initial setup and export are entirely offline, including apply.
  protection.transport = async () => { throw new Error('Owner setup cannot contact volunteers'); };
  let encryptionKey: Buffer | undefined, inspection: Awaited<ReturnType<typeof inspectProtectedAdmissionSpendHistory>> | undefined;
  let history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined, closed = false, busy = false, applied = false;
  function close() {
    if (closed) return; closed = true;
    try { inspection?.close(); } finally { try { history?.close(); } finally { protection.signingKey.secretKey.fill(0); encryptionKey?.fill(0); } }
  }
  try {
    encryptionKey = readOperatorStorageKey(input.storageKeyFile);
    const policy = await verifyAdmissionPolicy(readOperatorJson(input.policyFile, MAX_ADMISSION_POLICY_BYTES), protection.context.authority);
    assertAdmissionPolicyCurrent(policy, Date.now());
    let stateDigest: string | undefined, genesisId: string | null = null, spends = 0, permanentDenials = 0;
    let initializeWriter = input.mode === 'new', initializeArchive = input.mode === 'new';
    if (input.mode === 'new') {
      if (`sha256:${admissionPolicyDigest(policy)}` !== config.context.policyDigest) throw new Error('New owner policy differs from its pinned initial policy');
    } else {
      inspection = await inspectProtectedAdmissionSpendHistory({ directory, encryptionKey, authority: protection.context.authority, policy, protection });
      const state = inspection.read();
      if (state.version !== 3) throw new Error('Restored histories require retained ancestry; use the recovery workflow');
      stateDigest = historyDigest(JSON.stringify(state)); genesisId = historyCheckpointEnvelopeId(state.root);
      spends = state.image.state.spends.length; permanentDenials = state.image.state.retiredIssuerKeys.length;
      const writer = join(directory, 'admission-history-writer');
      initializeWriter = !present(join(writer, 'history-writer.json'));
      initializeArchive = !present(join(writer, 'payloads', 'history-writer-payloads.json'));
      if ((initializeWriter || initializeArchive) && (input.mode !== 'resume' || state.applied !== null)) {
        throw new Error('Missing writer/archive needs explicit pristine resumption; committed missing history cannot be recreated');
      }
    }
    const details = { kind: 'owner-history-setup' as const, mode: input.mode, directory, output,
      contextId: historyCheckpointContextId(protection.context), genesisId, stateDigest: stateDigest ?? null,
      owner: protection.context.owner, authority: protection.context.authority, members: config.members,
      policyRevision: policy.revision, spends, permanentDenials, initializeWriter, initializeArchive,
      readiness: 'unverified' as const, startsService: false as const };
    const review = { ...details, approvalDigest: historyDigest(`resonance:owner-history-setup:v1\n${JSON.stringify([details, captured])}`) };
    const checkFiles = () => {
      signal?.throwIfAborted(); assertAdmissionPolicyCurrent(policy, Date.now());
      if (directory !== canonicalHistorySetupPath(input.directory) || output !== canonicalHistorySetupPath(input.output)
        || JSON.stringify(captured) !== JSON.stringify(capture(files))) throw new Error('Owner setup selection changed; retain files and review again');
      newOutput(output);
    };
    checkFiles(); if (input.mode === 'new') emptyDirectory(directory);
    return { review() { if (closed) throw new Error('Owner setup review is closed'); return structuredClone(review); },
      async apply(approved: string) {
        if (closed || busy || applied || approved !== review.approvalDigest) throw new Error('Owner setup approval changed, is closed or already applied');
        checkFiles(); if (input.mode === 'new') emptyDirectory(directory); busy = true;
        try {
          inspection?.close();
          history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey: encryptionKey!, policy, authority: protection.context.authority,
            initialize: input.mode === 'new', expectedStateDigest: stateDigest,
            protection: { ...protection, initializeWriter, initializeArchive, resumePristineArchive: input.mode === 'resume' && initializeArchive } });
          if (closed) { history.close(); throw new Error('Owner setup review is closed'); }
          checkFiles();
          const enrollment = history.enrollment();
          writeOperatorJsonNew(output, { version: 1, kind: 'admission-history-enrollment', ...enrollment }, HISTORY_ENVELOPE_MAX_BYTES + 65536);
          applied = true;
          return { result: 'enrollment-exported' as const, contextId: details.contextId,
            genesisId: historyCheckpointEnvelopeId(enrollment.root), output, readiness: 'unverified' as const, startsService: false as const };
        } finally { busy = false; }
      }, close };
  } catch (error) { close(); throw error; }
}
