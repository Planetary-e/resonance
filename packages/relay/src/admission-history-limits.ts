/** Offline owner archive-capacity editing; a new config is activated separately. */
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MAX_ADMISSION_POLICY_BYTES } from '@resonance/core/admission-policy';
import { HISTORY_ENVELOPE_MAX_BYTES, historyDigest, historyCheckpointEnvelopeId, historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath, historySetupContains } from './admission-history-setup.js';
import { loadAdmissionHistoryProtectionFile, parseAdmissionHistoryConfiguration, parseAdmissionHistoryArchiveLimits } from './admission-history-config.js';
import { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';
import { readHistoryEnrollmentFile } from './admission-history-command.js';
import { readOperatorFile, readOperatorJson, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';

export interface AdmissionOwnerLimitsInput {
  historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string;
  archiveMiB: number; archiveBlocks: number;
}
export async function openAdmissionOwnerLimits(input: AdmissionOwnerLimitsInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(input.archiveMiB)) throw new Error('Owner archive size must use whole MiB');
  const limits = parseAdmissionHistoryArchiveLimits({ archiveBytes: input.archiveMiB * 1048576, archiveBlocks: input.archiveBlocks });
  const directory = canonicalHistorySetupPath(input.directory), output = canonicalHistorySetupPath(input.output);
  function outputAbsent() {
    try { lstatSync(output); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('Owner limit configuration already exists; retain it and choose a new output');
  }
  outputAbsent(); if (!lstatSync(dirname(output)).isDirectory()) throw new Error('Owner limit output needs an existing parent directory');
  const sourceFiles: Array<[string, number]> = [[input.historyConfigFile, 65536], [input.enrollmentFile, HISTORY_ENVELOPE_MAX_BYTES + 65536],
    [input.policyFile, MAX_ADMISSION_POLICY_BYTES], [input.storageKeyFile, 128]];
  const capture = (files: Array<[string, number]>) => files.map(([path, maximum]) => {
    const bytes = readOperatorFile(path, maximum);
    try { return [resolve(path), canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const sources = capture(sourceFiles), config = parseAdmissionHistoryConfiguration(readOperatorJson(input.historyConfigFile, 65536));
  const keyPath = resolve(dirname(resolve(input.historyConfigFile)), config.ownerKeyFile), files: Array<[string, number]> = [...sourceFiles, [keyPath, 4096]];
  const captured = [...sources, ...capture([[keyPath, 4096]])];
  if ([output, ...files.map(([path]) => canonicalHistorySetupPath(path))].some(path => historySetupContains(directory, path))) throw new Error('Keep owner limit files outside retained history');
  const enrollment = readHistoryEnrollmentFile(input.enrollmentFile);
  if (enrollment.contextId !== historyCheckpointContextId(config.context)) throw new Error('Owner limit enrollment pins differ');
  const protection = loadAdmissionHistoryProtectionFile(input.historyConfigFile);
  protection.maxArchiveBytes = limits.archiveBytes; protection.maxArchiveBlocks = limits.archiveBlocks;
  protection.transport = async () => { throw new Error('Owner limit review cannot contact volunteers'); };
  let key: Buffer | undefined, history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined, closed = false, applied = false;
  const close = () => { if (!closed) { closed = true; try { history?.close(); } finally { key?.fill(0); protection.signingKey.secretKey.fill(0); } } };
  try {
    key = readOperatorStorageKey(input.storageKeyFile);
    history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey: key, authority: config.context.authority,
      policy: readOperatorJson(input.policyFile, MAX_ADMISSION_POLICY_BYTES), protection });
    const state = history.read(), retainedGenesis = state.version === 4 ? state.restoration.genesis : state.root;
    if (historyCheckpointEnvelopeId(retainedGenesis) !== enrollment.genesisId) throw new Error('Owner limit history differs from independent genesis');
    const usage = history.health();
    // Pending intent may be durable locally before its ciphertext reaches the archive.
    const pendingBytes = history.pendingUnarchivedBytes();
    if (usage.retainedBlocks + (pendingBytes ? 1 : 0) > limits.archiveBlocks || usage.retainedCiphertextBytes + pendingBytes > limits.archiveBytes) {
      throw new Error('Owner archive limits must retain pending ciphertext as well as accepted records');
    }
    const candidate = { ...config, ownerKeyFile: canonicalHistorySetupPath(keyPath), limits }, stateDigest = historyDigest(JSON.stringify(state));
    const details = { kind: 'owner-history-limits' as const, directory, output, contextId: enrollment.contextId, genesisId: enrollment.genesisId,
      owner: config.context.owner, authority: config.context.authority, retainedBlocks: usage.retainedBlocks,
      retainedCiphertextBytes: usage.retainedCiphertextBytes, pending: !!state.pending, pendingUnarchivedBytes: pendingBytes,
      archiveBytes: limits.archiveBytes, archiveBlocks: limits.archiveBlocks, readiness: 'unverified' as const, startsService: false as const };
    const review = { ...details, approvalDigest: historyDigest(`resonance:owner-history-limits:v1\n${JSON.stringify([details, stateDigest, captured, candidate])}`) };
    const check = () => {
      signal?.throwIfAborted();
      if (closed || canonicalHistorySetupPath(input.directory) !== directory || canonicalHistorySetupPath(input.output) !== output
        || JSON.stringify(captured) !== JSON.stringify(capture(files)) || historyDigest(JSON.stringify(history!.read())) !== stateDigest) throw new Error('Owner limit selection or retained history changed; review again');
    };
    check();
    return { review, apply(approved: string) {
      if (applied || approved !== review.approvalDigest) throw new Error('Owner limit approval changed; review again');
      check(); outputAbsent(); writeOperatorJsonNew(output, candidate, 65536); check(); applied = true;
      return { ...details, result: 'owner-limits-configured' as const };
    }, close };
  } catch (error) { close(); throw error; }
}
