/** Explicit preparation/enrollment. No command resets missing accepted history or chooses new members. */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAX_ADMISSION_POLICY_BYTES, admissionPolicyDigest, assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { HISTORY_COMPACTION_MAX_BYTES, parseHistoryCompactionAttestation } from '@resonance/core/history-compaction';
import { historyCompactionCertificateId } from '@resonance/core/history-compaction-control';
import { HISTORY_COMPACTION_RETENTION_MAX_BYTES, parseHistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { retainHistoryCompactionCertificate } from './history-compaction-coordinator.js';
import { discoverHistoryCompactionFrontier } from './history-frontier-discovery.js';
import { loadAdmissionHistoryProtectionFile, parseAdmissionHistoryConfiguration } from './admission-history-config.js';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';
import { openAdmissionRoleCapture } from './admission-role-capture.js';
import { openAdmissionRoleSetup, openAdmissionRoleKeyExport } from './admission-role-setup.js';
import { openHistoryVolunteerEnrollmentResume } from './history-volunteer-enrollment.js';
import { openHistoryVolunteerService } from './history-volunteer-service.js';
import { listenHistoryAgreementReplica } from './history-agreement-exchange.js';
import { discoverHistoryContinuations } from './history-continuation-discovery.js';
import { createHistoryOperatorTransport } from './history-operator-transport.js';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from './admission-history-recovery.js';
import { reviewAdmissionOwnerConfiguration, openAdmissionOwnerSetup, canonicalHistorySetupPath, historySetupContains, type AdmissionOwnerSetupMode } from './admission-history-setup.js';
import { measureStorageDirectories } from './storage-inventory.js';
import { openAdmissionOwnerLimits } from './admission-history-limits.js';
import { openAdmissionInitialReadiness } from './admission-history-readiness.js';


const ENROLLMENT_MAX = HISTORY_ENVELOPE_MAX_BYTES + 65536;
function empty(path: string) { if (existsSync(path) && readdirSync(path).length) throw new Error('New enrollment requires an empty destination'); }
export function readHistoryEnrollmentFile(path: string) {
  const raw = readOperatorJson(path, ENROLLMENT_MAX);
  if (!exactWitnessFields(raw, ['version', 'kind', 'context', 'root']) || raw.version !== 1 || raw.kind !== 'admission-history-enrollment') {
    throw new Error('Invalid history enrollment file');
  }
  const context = parseHistoryCheckpointContext(raw.context), root = parseHistoryCheckpointEnvelope(raw.root, context);
  if (context.role !== 'relay-admission-spends') throw new Error('Admission history requires its own history role');
  if (root.kind !== 'checkpoint' || root.generation !== 0 || root.sequence !== 0) throw new Error('Volunteer enrollment needs its independently pinned genesis');
  return { context, root, contextId: historyCheckpointContextId(context), genesisId: historyCheckpointEnvelopeId(root) };
}

export interface AdmissionHistoryCommandOptions { transportFile?: string; signal?: AbortSignal }
/** Shared command implementation for the CLI and authenticated desktop workflow.
 * Approval digests remain mandatory; no environment, output stream or process exit is owned here. */
export async function runAdmissionHistoryCommand(command: string, raw: readonly string[], commandOptions: AdmissionHistoryCommandOptions = {}) {
  const cleanup: Array<() => void> = [];
  const transports: Array<ReturnType<typeof createHistoryOperatorTransport>> = [];
  let serving: { service: ReturnType<typeof openHistoryVolunteerService>; listener?: Awaited<ReturnType<typeof listenHistoryAgreementReplica>> } | undefined;
  let result: Record<string, unknown> | undefined;
  function emit(value: object) { result = value as Record<string, unknown>; }
  function operatorTransport(protection: ReturnType<typeof loadAdmissionHistoryProtectionFile>) {
    if (commandOptions.signal?.aborted) throw new Error('History operation cancelled');
    const transport = createHistoryOperatorTransport(protection, commandOptions.transportFile, commandOptions.signal);
    transports.push(transport); cleanup.push(() => transport.close()); return transport;
  }
  function checkCancelled() { if (commandOptions.signal?.aborted) throw new Error('History operation cancelled; retain any pending work'); }
  const cancel = () => { for (const transport of transports) transport.close(); };
  commandOptions.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (commandOptions.signal?.aborted) throw new Error('History operation cancelled');
    if (command === 'storage-inventory') {
      const directories: string[] = [], files: string[] = [];
      for (let index = 0; index < raw.length; index++) {
        if (raw[index] === '--file') {
          const file = raw[++index];
          if (!file || file.startsWith('--')) throw new Error('Storage inventory --file needs one explicit path');
          files.push(resolve(file));
        } else {
          if (raw[index].startsWith('--')) throw new Error('Unknown storage inventory option');
          directories.push(resolve(raw[index]));
        }
      }
      emit(await measureStorageDirectories(directories, { signal: commandOptions.signal, files }));
    } else if (['owner-config-plan', 'owner-config-create', 'owner-setup-plan', 'owner-setup-apply'].includes(command)) {
      const applying = command === 'owner-config-create' || command === 'owner-setup-apply';
      const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if ((applying && !approved) || (args.length !== 6 && !(command === 'owner-config-plan' && args.length === 5))) throw new Error('Invalid reviewed setup command or missing approval');
      if (command.startsWith('owner-config-')) {
        const [ownerKeyFile, authorityFile, policyFile, membersFile, output, historyId] = args;
        const preparation = await reviewAdmissionOwnerConfiguration({ ownerKeyFile, authorityFile, policyFile, membersFile, output, historyId }, commandOptions.signal);
        emit(applying ? preparation.apply(approved!) : preparation.review);
      } else {
        const [mode, historyConfigFile, policyFile, storageKeyFile, directory, output] = args;
        const preparation = await openAdmissionOwnerSetup({ mode: mode as AdmissionOwnerSetupMode, historyConfigFile, policyFile, storageKeyFile, directory, output }, commandOptions.signal);
        cleanup.push(() => preparation.close()); emit(applying ? await preparation.apply(approved!) : preparation.review());
      }
    } else if (['role-setup-plan', 'role-setup'].includes(command)) {
      const applying = command === 'role-setup', approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if (args.length !== 5 || (applying && !approved)) throw new Error('Invalid fresh role setup command or missing approval');
      const [mode, selection, storageKeyFile, directory, output] = args;
      const prepared = openAdmissionRoleSetup({ mode: mode as 'new' | 'resume', selection: selection as 'witness' | 'coordinator', storageKeyFile, directory, output }, commandOptions.signal);
      cleanup.push(prepared.close); emit(applying ? prepared.apply(approved!) : prepared.review);
    } else if (['owner-limits-plan', 'owner-limits'].includes(command)) {
      const applying = command === 'owner-limits', approved = applying && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (args.length !== 8 || (applying && !approved) || !args.slice(6).every(n => /^[1-9][0-9]*$/.test(n))) throw new Error('Invalid owner limit command or missing approval');
      const [historyConfigFile, enrollmentFile, policyFile, storageKeyFile, directory, output, mib, blocks] = args;
      const prepared = await openAdmissionOwnerLimits({ historyConfigFile, enrollmentFile, policyFile, storageKeyFile, directory, output,
        archiveMiB: Number(mib), archiveBlocks: Number(blocks) }, commandOptions.signal);
      cleanup.push(prepared.close); emit(applying ? prepared.apply(approved!) : prepared.review);
    } else if (command === 'owner-config' && raw.length === 5) {
      const [ownerPath, authorityPath, policyPath, membersPath, output] = raw;
      if (existsSync(output)) throw new Error('Owner configuration output already exists');
      const key = readOperatorSigningKey(ownerPath); cleanup.push(() => key.secretKey.fill(0));
      const authorityBytes = readOperatorFile(authorityPath, 256);
      let authority: string; try { authority = authorityBytes.toString('utf8').trim(); } finally { authorityBytes.fill(0); }
      const policy = await verifyAdmissionPolicy(readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES), authority);
      assertAdmissionPolicyCurrent(policy, Date.now());
      const members = readOperatorJson(membersPath, 64 * 1024);
      if (!Array.isArray(members) || members.length !== 5 || members.some(m => !exactWitnessFields(m, ['publicKey', 'endpoint'])
        || typeof m.publicKey !== 'string')) throw new Error('Supply five explicit pinned member records');
      const context = { version: 1, role: 'relay-admission-spends', historyId: randomBytes(32).toString('base64url'),
        owner: Buffer.from(key.publicKey).toString('base64url'), authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}`,
        members: members.map(m => m.publicKey).sort(), quorum: 4 };
      const config = parseAdmissionHistoryConfiguration({ version: 1, context, members, ownerKeyFile: resolve(ownerPath) });
      writeOperatorJsonNew(output, config, 64 * 1024);
      emit({ result: 'new-owner-configuration', contextId: historyCheckpointContextId(config.context), output: resolve(output) });
    } else if (['owner-prepare', 'owner-export', 'owner-resume-setup'].includes(command) && raw.length === 5) {
      const [configPath, policyPath, keyPath, directory, output] = raw;
      if (existsSync(output)) throw new Error('Enrollment output exists; choose another output path');
      if (command === 'owner-prepare') empty(directory);
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const transport = operatorTransport(loaded), { protection } = transport;
      const encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const writer = join(directory, 'admission-history-writer');
      const history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey, authority: protection.context.authority,
        policy: readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES), initialize: command === 'owner-prepare',
        protection: { ...protection,
          initializeWriter: command === 'owner-prepare' || (command === 'owner-resume-setup' && !existsSync(join(writer, 'history-writer.json'))),
          initializeArchive: command === 'owner-resume-setup' && !existsSync(join(writer, 'payloads', 'history-writer-payloads.json')) } });
      cleanup.push(() => history.close());
      const value = history.enrollment();
      if (value.root.kind !== 'checkpoint' || value.root.generation !== 0) throw new Error('A restored history needs retained ancestors; it cannot enroll a replacement genesis');
      writeOperatorJsonNew(output, { version: 1, kind: 'admission-history-enrollment', ...value }, ENROLLMENT_MAX);
      emit({ result: 'enrollment-exported', contextId: historyCheckpointContextId(value.context),
        genesisId: historyCheckpointEnvelopeId(value.root), output: resolve(output), readiness: 'unverified' });
    } else if (['owner-initial-readiness-plan', 'owner-initial-ready'].includes(command)) {
      const applying = command === 'owner-initial-ready', approved = applying && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (args.length !== 5 || (applying && !approved)) throw new Error('Invalid initial readiness command or missing approval');
      const [configPath, enrollmentPath, policyPath, keyPath, directory] = args;
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const { protection } = operatorTransport(loaded), pinned = readHistoryEnrollmentFile(enrollmentPath);
      if (pinned.contextId !== historyCheckpointContextId(protection.context)) throw new Error('Enrollment and owner configuration differ');
      const encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const readiness = await openAdmissionInitialReadiness({ directory, policy: readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES),
        encryptionKey, protection, genesisId: pinned.genesisId, signal: commandOptions.signal }); cleanup.push(readiness.close);
      emit(applying ? await readiness.apply(approved!) : readiness.review());
    } else if (command === 'owner-checkpoint-discover') {
      if (raw.length !== 3) throw new Error('Checkpoint discovery needs owner configuration, original enrollment and a new proof output');
      const [configPath, enrollmentPath, target] = raw, output = canonicalHistorySetupPath(target);
      function checkOutput() {
        if (canonicalHistorySetupPath(target) !== output) throw new Error('Checkpoint discovery output selection changed');
        try { lstatSync(output); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!lstatSync(dirname(output)).isDirectory()) throw new Error('Checkpoint discovery output needs an existing parent');
          return;
        }
        throw new Error('Checkpoint discovery output already exists; retain it and select another path');
      }
      checkOutput();
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const pinned = readHistoryEnrollmentFile(enrollmentPath), transport = operatorTransport(loaded), { protection } = transport;
      if (pinned.contextId !== historyCheckpointContextId(protection.context)) throw new Error('Enrollment and owner configuration differ');
      const reservation = reserveManagedStorage({ path: output, component: 'operator-output', scope: 'file', maximumBytes: HISTORY_COMPACTION_MAX_BYTES });
      const discovered = await discoverHistoryCompactionFrontier({ context: protection.context, genesisId: pinned.genesisId,
        signingKey: protection.signingKey, members: protection.members, timeoutMs: protection.timeoutMs,
        signal: commandOptions.signal, transport: transport.frontierTransport });
      checkCancelled(); checkOutput();
      if (!discovered.certificate) emit({ result: 'no-checkpoint-proof-observed', observations: discovered.receipts.length,
        output: null, admissionReadiness: 'unverified' });
      else {
        writeOperatorJsonNew(output, discovered.certificate, HISTORY_COMPACTION_MAX_BYTES, reservation ? { reservation } : undefined);
        checkCancelled();
        const p = discovered.certificate.proposal;
        emit({ result: 'checkpoint-proof-discovered', contextId: pinned.contextId, genesisId: pinned.genesisId,
          rootId: p.rootId, generation: p.generation, sequence: p.sequence, envelopeId: p.envelopeId,
          certificateId: historyCompactionCertificateId(discovered.certificate, protection.context, pinned.genesisId),
          observations: discovered.receipts.length, output, authority: 'historical-only', admissionReadiness: 'unverified' });
      }
    } else if (command?.startsWith('owner-recovery-')) {
      const mutation = ['owner-recovery-start', 'owner-recovery-restore', 'owner-recovery-ready'].includes(command);
      const approved = mutation && raw[0] === '--approve' ? raw[1] : undefined;
      let args = approved ? raw.slice(2) : raw;
      let compaction: unknown;
      if (args[0] === '--checkpoint-proof') {
        if (!args[1] || args[1].startsWith('--')) throw new Error('Recovery --checkpoint-proof needs one explicit certificate file');
        compaction = readOperatorJson(args[1], HISTORY_COMPACTION_MAX_BYTES); args = args.slice(2);
      }
      const planning = ['owner-recovery-plan', 'owner-recovery-start'].includes(command);
      const readiness = ['owner-recovery-readiness-plan', 'owner-recovery-ready'].includes(command);
      const reviewing = ['owner-recovery-review', 'owner-recovery-restore'].includes(command) || readiness;
      if ((!planning && !reviewing && !['owner-recovery-status', 'owner-recovery-step'].includes(command))
        || args.length !== (planning ? 5 : reviewing ? 6 : 4)
        || (mutation && !approved)) throw new Error('Invalid recovery command or missing approval');
      const [configPath, enrollmentPath, keyPath, directory] = args;
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const transport = operatorTransport(loaded), { protection } = transport;
      const pinned = readHistoryEnrollmentFile(enrollmentPath);
      if (pinned.contextId !== historyCheckpointContextId(protection.context)) throw new Error('Enrollment and owner configuration differ');
      const encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const options = { directory, ...transport, encryptionKey, genesis: pinned.root, compaction };
      if (planning) {
        if (!/^[1-9][0-9]*$/.test(args[4])) throw new Error('Recovery view must be a positive integer');
        const review = await prepareAdmissionHistoryRecovery({ ...options, view: Number(args[4]), signal: commandOptions.signal });
        if (command === 'owner-recovery-plan') emit(review);
        else {
          checkCancelled();
          const recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: approved! } });
          cleanup.push(() => recovery.close()); emit({ result: 'recovery-created', ...recovery.status() });
        }
      } else {
        const recovery = await openAdmissionHistoryRecovery(options); cleanup.push(() => recovery.close());
        if (command === 'owner-recovery-status') emit(recovery.status());
        else if (command === 'owner-recovery-step') emit(await recovery.advance({ signal: commandOptions.signal }));
        else {
          const policy = readOperatorJson(args[4], MAX_ADMISSION_POLICY_BYTES), destination = args[5];
          if (readiness) {
            const retained = await recovery.reviewReadiness(destination, policy, commandOptions.signal); cleanup.push(() => retained.close());
            emit(command === 'owner-recovery-readiness-plan' ? retained.review() : await retained.apply(approved!));
          } else {
            const preparation = await recovery.reviewRestore(destination, policy);
            if (command === 'owner-recovery-review') emit(preparation.review);
            else {
              checkCancelled();
              const history = await openProtectedAdmissionSpendHistory({ directory: destination, encryptionKey,
                authority: protection.context.authority, policy, initialize: true,
                protection: { ...protection, initializeWriter: true, restore: { preparation, approvedDigest: approved! } } });
              cleanup.push(() => history.close()); await history.ready();
              emit({ result: 'history-restored', generation: history.read().root.generation, readiness: 'confirmed' });
            }
          }
        }
      }
    } else if (['owner-checkpoint-retention-plan', 'owner-checkpoint-retain'].includes(command)) {
      const applying = command === 'owner-checkpoint-retain';
      const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if (![3, 4].includes(args.length) || (applying && !approved)) throw new Error('Invalid checkpoint retention command or missing approval');
      const [configPath, enrollmentPath, certificatePath, target] = args;
      const output = target === undefined ? undefined : canonicalHistorySetupPath(target);
      function checkOutput() {
        if (target === undefined) return;
        if (canonicalHistorySetupPath(target) !== output) throw new Error('Checkpoint retention output selection changed');
        try { lstatSync(output!); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!lstatSync(dirname(output!)).isDirectory()) throw new Error('Checkpoint retention output needs an existing parent');
          return;
        }
        throw new Error('Checkpoint retention output already exists; retain it and select another path');
      }
      checkOutput();
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const pinned = readHistoryEnrollmentFile(enrollmentPath), transport = operatorTransport(loaded), { protection } = transport;
      if (pinned.contextId !== historyCheckpointContextId(protection.context)) throw new Error('Enrollment and owner configuration differ');
      const certificate = parseHistoryCompactionAttestation(readOperatorJson(certificatePath, HISTORY_COMPACTION_MAX_BYTES), protection.context, pinned.genesisId);
      const details = { kind: 'admission-history-checkpoint-retention' as const, contextId: pinned.contextId, genesisId: pinned.genesisId,
        rootId: certificate.proposal.rootId, generation: certificate.proposal.generation, sequence: certificate.proposal.sequence,
        envelopeId: certificate.proposal.envelopeId, certificateId: historyCompactionCertificateId(certificate, protection.context, pinned.genesisId),
        requestedCopies: 4, filesRemoved: 0, bytesReclaimed: 0, admissionReadiness: 'unverified' as const,
        ...(output === undefined ? {} : { output }) };
      const review = { ...details, approvalDigest: historyDigest(`resonance:checkpoint-certificate-retention-review:v1\n${JSON.stringify([details, protection.members])}`) };
      if (!applying) emit({ ...review, result: 'review-required' });
      else {
        if (approved !== review.approvalDigest) throw new Error('Checkpoint retention approval does not match the proof and pinned members');
        checkCancelled(); checkOutput();
        const reservation = output === undefined ? undefined : reserveManagedStorage({ path: output, component: 'operator-output', scope: 'file',
          maximumBytes: HISTORY_COMPACTION_RETENTION_MAX_BYTES });
        const responses = await retainHistoryCompactionCertificate({ context: protection.context, genesisId: pinned.genesisId,
          certificate, signingKey: protection.signingKey, members: protection.members, signal: commandOptions.signal,
          timeoutMs: protection.timeoutMs, transport: transport.compactionControlTransport });
        checkCancelled(); checkOutput();
        if (output !== undefined) {
          const retained = parseHistoryCompactionRetention({ version: 1, kind: 'history-compaction-retention', certificate, receipts: responses }, protection.context, pinned.genesisId);
          writeOperatorJsonNew(output, retained, HISTORY_COMPACTION_RETENTION_MAX_BYTES, reservation ? { reservation } : undefined);
          checkCancelled();
        }
        emit({ ...review, result: 'checkpoint-proof-retained', retainedCopies: responses.length,
          authority: 'historical-only' });
      }
    } else if (['owner-checkpoint-certification-plan', 'owner-checkpoint-certify'].includes(command)) {
      const applying = command === 'owner-checkpoint-certify';
      const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if (args.length !== 5 || (applying && !approved)) throw new Error('Invalid checkpoint certification command or missing approval');
      const [configPath, policyPath, keyPath, directory, target] = args, output = canonicalHistorySetupPath(target);
      function checkOutput() {
        if (canonicalHistorySetupPath(target) !== output) throw new Error('Certificate output selection changed; review again');
        try { lstatSync(output); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!lstatSync(dirname(output)).isDirectory()) throw new Error('Certificate output needs an existing parent');
          return;
        }
        throw new Error('Certificate output already exists; retain it and select another path');
      }
      checkOutput();
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const transport = operatorTransport(loaded), { protection } = transport;
      const encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const policy = await verifyAdmissionPolicy(readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES), protection.context.authority);
      const history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey, authority: protection.context.authority, policy, protection });
      cleanup.push(history.close);
      if (admissionPolicyDigest(history.read().image.policy) !== admissionPolicyDigest(policy)) throw new Error('Certification requires the retained policy');
      const plan = history.planCheckpointCertification(), review = { ...plan, output,
        approvalDigest: historyDigest(`resonance:checkpoint-certificate-export-review:v1\n${JSON.stringify([plan.approvalDigest, output])}`) };
      if (!applying) emit({ ...review, result: 'review-required', readiness: 'unverified' });
      else {
        if (approved !== review.approvalDigest) throw new Error('Certificate approval does not match current history and output');
        checkCancelled(); checkOutput();
        const reservation = reserveManagedStorage({ path: output, component: 'operator-output', scope: 'file', maximumBytes: HISTORY_COMPACTION_MAX_BYTES });
        await history.ready();
        const certificate = await history.certifyCheckpoint(plan.approvalDigest, { signal: commandOptions.signal,
          transport: transport.compactionTransport });
        checkCancelled(); checkOutput();
        writeOperatorJsonNew(output, certificate, HISTORY_COMPACTION_MAX_BYTES, reservation ? { reservation } : undefined);
        checkCancelled();
        emit({ ...review, result: 'checkpoint-certificate-exported', endorsements: certificate.votes.length,
          authority: 'historical-only', remotelyRetained: false });
      }
    } else if (['owner-role-capture-plan', 'owner-role-capture', 'owner-role-retirement-plan', 'owner-role-retire', 'owner-role-key-plan', 'owner-role-key-export'].includes(command)) {
      const capturing = command === 'owner-role-capture-plan' || command === 'owner-role-capture';
      const exporting = command === 'owner-role-key-plan' || command === 'owner-role-key-export';
      const applying = command === 'owner-role-capture' || command === 'owner-role-retire' || command === 'owner-role-key-export';
      const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if (args.length !== (exporting ? 7 : 6) || (applying && !approved)) throw new Error('Invalid protected role command or missing approval');
      const [configPath, policyPath, keyPath, directory, target, selection, output] = args;
      if (capturing ? !['witness', 'coordinator', 'both'].includes(selection) : !['witness', 'coordinator'].includes(exporting ? selection : target)) throw new Error('Select an explicit admission role');
      if (exporting && historySetupContains(canonicalHistorySetupPath(directory), canonicalHistorySetupPath(output))) throw new Error('Export the role signing key outside the owner history');
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const { protection } = operatorTransport(loaded), encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const policy = await verifyAdmissionPolicy(readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES), protection.context.authority);
      const history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey, authority: protection.context.authority, policy, protection });
      cleanup.push(history.close);
      if (admissionPolicyDigest(history.read().image.policy) !== admissionPolicyDigest(policy)) throw new Error('Role maintenance requires the retained policy; apply its successor explicitly');
      if (exporting) {
        const prepared = await openAdmissionRoleKeyExport({ directory: target, output, selection: selection as 'witness' | 'coordinator', encryptionKey, history, signal: commandOptions.signal });
        cleanup.push(prepared.close); emit(applying ? await prepared.apply(approved!) : prepared.review);
      } else if (capturing) {
        const capture = await openAdmissionRoleCapture({ directory: target, encryptionKey, history,
          roles: selection === 'both' ? ['witness', 'coordinator'] : [selection as 'witness' | 'coordinator'] });
        cleanup.push(capture.close);
        emit(applying ? { ...await capture.apply(approved!), result: 'admission-roles-protected' }
          : { ...await capture.review(), result: 'review-required' });
      } else {
        const role = target as 'witness' | 'coordinator', plan = history.planRoleRetirement(role, selection);
        if (applying) {
          if (approved !== plan.approvalDigest) throw new Error('Role retirement approval changed');
          await history.ready(); await history.retireRole(role, selection, approved!);
        }
        emit({ ...plan, result: applying ? 'admission-role-permanently-retired' : 'review-required', durability: 'protected-four-of-five' });
      }
    } else if (['owner-retirement-plan', 'owner-retire', 'owner-legacy-plan', 'owner-legacy-recover', 'owner-checkpoint-plan', 'owner-checkpoint', 'owner-prefix-plan', 'owner-prefix-retire'].includes(command)) {
      const checkpoint = command === 'owner-checkpoint-plan' || command === 'owner-checkpoint';
      const prefix = command === 'owner-prefix-plan' || command === 'owner-prefix-retire';
      const mutating = command === 'owner-retire' || command === 'owner-legacy-recover' || command === 'owner-checkpoint' || command === 'owner-prefix-retire';
      const approved = mutating && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if (args.length !== (checkpoint || prefix ? 4 : 5) || (mutating && !approved)) throw new Error('Invalid protected maintenance command or missing approval');
      const [configPath, policyPath, keyPath, directory, target] = args;
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const transport = operatorTransport(loaded), { protection } = transport;
      const encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const policy = await verifyAdmissionPolicy(readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES), protection.context.authority);
      const history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey, authority: protection.context.authority, policy, protection });
      cleanup.push(() => history.close());
      // Planning is offline and cannot implicitly apply a policy or finish a pending mutation.
      if (admissionPolicyDigest(history.read().image.policy) !== admissionPolicyDigest(policy)) {
        throw new Error('Maintenance requires the retained policy; apply its successor explicitly before reviewing');
      }
      const retiring = command === 'owner-retirement-plan' || command === 'owner-retire';
      const proofs = retiring || checkpoint || prefix ? undefined : readOperatorJson(target, 65536);
      const plan = prefix ? history.planPrefixRetirement() : checkpoint ? history.planCheckpoint() : retiring ? history.planRetirement(target) : await history.planLegacyRecovery(proofs);
      let checkpointResult: Awaited<ReturnType<typeof history.checkpoint>> | undefined;
      if (mutating) {
        if (approved !== plan.approvalDigest) throw new Error('Maintenance approval does not match; review the current history again');
        if (!prefix) await history.ready(); // Prefix retirement is local maintenance, never readiness.
        if (prefix) await history.retirePrefix(approved!);
        else if (checkpoint) checkpointResult = await history.checkpoint(approved!);
        else if (retiring) await history.retire(target, approved!);
        else await history.recoverLegacy(proofs, approved!); // Rechecks evidence/digest after readiness.
      }
      emit({ ...plan, ...checkpointResult, durability: 'protected-four-of-five', readiness: mutating && !prefix ? 'confirmed' : 'unverified',
        result: !mutating ? 'review-required' : prefix ? 'history-prefix-retired' : checkpoint ? 'state-checkpoint-published' : retiring ? 'permanently-retired' : 'legacy-spends-recovered' });
    } else if (command === 'owner-ready' && raw.length === 4) {
      const [configPath, policyPath, keyPath, directory] = raw;
      const loaded = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const transport = operatorTransport(loaded), { protection } = transport;
      const encryptionKey = readOperatorStorageKey(keyPath); cleanup.push(() => encryptionKey.fill(0));
      const writer = join(directory, 'admission-history-writer');
      const history = await openProtectedAdmissionSpendHistory({ directory, encryptionKey, authority: protection.context.authority,
        policy: readOperatorJson(policyPath, MAX_ADMISSION_POLICY_BYTES), protection: { ...protection,
          initializeWriter: !existsSync(join(writer, 'history-writer.json')),
          initializeArchive: !existsSync(join(writer, 'payloads', 'history-writer-payloads.json')) } });
      cleanup.push(() => history.close()); await history.ready();
      emit({ result: 'history-ready', generation: history.read().root.generation, readiness: 'confirmed' });
    } else if (command === 'owner-inspect' && raw.length === 2) {
      const loaded = loadAdmissionHistoryProtectionFile(raw[0]); cleanup.push(() => loaded.signingKey.secretKey.fill(0));
      const { protection } = operatorTransport(loaded);
      const pinned = readHistoryEnrollmentFile(raw[1]);
      if (pinned.contextId !== historyCheckpointContextId(protection.context)) throw new Error('Enrollment and owner configuration differ');
      const observation = await discoverHistoryContinuations({ ...protection, genesisId: pinned.genesisId, signal: commandOptions.signal });
      emit({ result: 'history-observed', contextId: observation.contextId, genesisId: pinned.genesisId,
        certifiedBoundaries: observation.continuations.length, observedGeneration: observation.observedLeaf.generation,
        readiness: 'unverified', mutation: 'none' });
    } else if (['replica-resume-plan', 'replica-resume'].includes(command)) {
      const applying = command === 'replica-resume', approved = applying && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (args.length !== 4 || (applying && !approved)) throw new Error('Invalid enrollment resumption or missing approval');
      const [enrollmentPath, memberPath, keyPath, target] = args;
      const capture = () => args.slice(0, 3).map((path, i) => {
        const bytes = readOperatorFile(path, i === 0 ? ENROLLMENT_MAX : 65536);
        try { return [resolve(path), canonicalHistorySetupPath(path), historyDigest(bytes)]; } finally { bytes.fill(0); }
      });
      const files = capture(), pinned = readHistoryEnrollmentFile(enrollmentPath), signingKey = readOperatorSigningKey(memberPath);
      cleanup.push(() => signingKey.secretKey.fill(0));
      const localKey = readOperatorStorageKey(keyPath); cleanup.push(() => localKey.fill(0));
      const prepared = openHistoryVolunteerEnrollmentResume({ directory: target, context: pinned.context, genesis: pinned.root, signingKey, localKey }, commandOptions.signal);
      cleanup.push(prepared.close);
      const review = { ...prepared.review, approvalDigest: historyDigest(`resonance:replica-resume-files:v1\n${JSON.stringify([prepared.review, files])}`) };
      const check = () => { checkCancelled(); if (JSON.stringify(files) !== JSON.stringify(capture())) throw new Error('Enrollment files changed; review again'); };
      check();
      if (applying) {
        if (approved !== review.approvalDigest) throw new Error('Enrollment resumption approval changed; review again');
        const resumed = prepared.apply(prepared.review.approvalDigest); check(); emit(resumed);
      } else emit(review);
    } else if (['replica-pool-plan', 'replica-pool-enable'].includes(command)) {
      const applying = command === 'replica-pool-enable', approved = applying && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (![5, 6].includes(args.length) || applying && !approved) throw new Error('Invalid fixed history pool command or missing approval');
      const [enrollmentPath, memberPath, keyPath, target, countText, evidencePath] = args;
      if (!/^[1-9][0-9]*$/.test(countText) || Number(countText) < 2 || Number(countText) > 64) throw new Error('History pool requires between two and 64 slots');
      const pinned = readHistoryEnrollmentFile(enrollmentPath), signingKey = readOperatorSigningKey(memberPath);
      cleanup.push(() => signingKey.secretKey.fill(0));
      const localKey = readOperatorStorageKey(keyPath); cleanup.push(() => localKey.fill(0));
      const service = openHistoryVolunteerService({ directory: resolve(target), localKey, context: pinned.context, signingKey, genesisId: pinned.genesisId });
      cleanup.push(service.close);
      const evidence = evidencePath ? readOperatorJson(evidencePath, HISTORY_COMPACTION_RETENTION_MAX_BYTES) : undefined;
      const plan = service.planPool(Number(countText), evidence); checkCancelled();
      if (applying) service.enablePool(Number(countText), approved!, evidence);
      emit({ ...plan, result: applying ? 'history-pool-enabled' : 'review-required', readiness: 'unverified' });
    } else if (['replica-generations-plan', 'replica-generations-retire'].includes(command)) {
      const applying = command === 'replica-generations-retire', approved = applying && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (args.length !== 5 || applying && !approved) throw new Error('Invalid generation retirement command or missing approval');
      const [enrollmentPath, memberPath, keyPath, target, evidencePath] = args;
      const pinned = readHistoryEnrollmentFile(enrollmentPath), signingKey = readOperatorSigningKey(memberPath);
      cleanup.push(() => signingKey.secretKey.fill(0));
      const localKey = readOperatorStorageKey(keyPath); cleanup.push(() => localKey.fill(0));
      const evidence = readOperatorJson(evidencePath, HISTORY_COMPACTION_RETENTION_MAX_BYTES);
      const service = openHistoryVolunteerService({ directory: resolve(target), localKey, context: pinned.context, signingKey, genesisId: pinned.genesisId });
      cleanup.push(service.close); const plan = service.planGenerationRetirement(evidence); checkCancelled();
      if (applying) service.retireGenerations(evidence, approved!);
      emit({ ...plan, result: applying ? 'history-generations-retired' : 'review-required', readiness: 'unverified' });
    } else if (['replica-prefix-plan', 'replica-prefix-retire'].includes(command)) {
      const applying = command === 'replica-prefix-retire', approved = applying && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (args.length !== 5 || applying && !approved) throw new Error('Invalid replica prefix retirement command or missing approval');
      const [enrollmentPath, memberPath, keyPath, target, rootId] = args;
      const pinned = readHistoryEnrollmentFile(enrollmentPath), signingKey = readOperatorSigningKey(memberPath);
      cleanup.push(() => signingKey.secretKey.fill(0));
      const localKey = readOperatorStorageKey(keyPath); cleanup.push(() => localKey.fill(0));
      const service = openHistoryVolunteerService({ directory: resolve(target), localKey, context: pinned.context, signingKey, genesisId: pinned.genesisId });
      cleanup.push(service.close);
      const plan = service.planPrefixRetirement(rootId); checkCancelled();
      if (applying) service.retirePrefix(rootId, approved!);
      emit({ ...plan, result: applying ? 'history-prefix-retired' : 'review-required', readiness: 'unverified' });
    } else if (['replica-plan', 'replica-enroll', 'replica-serve'].includes(command)) {
      const approved = command === 'replica-enroll' && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
      if (args.length !== (command === 'replica-serve' ? 5 : 4) || (command === 'replica-enroll' && !approved)) throw new Error('Invalid replica command or missing digest approval');
      const [enrollmentPath, memberPath, keyPath, target, portText] = args, directory = resolve(target);
      const pinned = readHistoryEnrollmentFile(enrollmentPath), signingKey = readOperatorSigningKey(memberPath); cleanup.push(() => signingKey.secretKey.fill(0));
      const localKey = readOperatorStorageKey(keyPath); cleanup.push(() => localKey.fill(0));
      const member = Buffer.from(signingKey.publicKey).toString('base64url');
      if (!pinned.context.members.includes(member)) throw new Error('Volunteer key is not one of the five pinned members');
      const options = { directory, localKey, context: pinned.context, signingKey, genesisId: pinned.genesisId };
      if (command !== 'replica-serve') {
        empty(directory);
        const review = { kind: 'history-volunteer-enrollment', directory, contextId: pinned.contextId, genesisId: pinned.genesisId,
          member, owner: pinned.context.owner, authority: pinned.context.authority,
          maximumGenerations: 65, generationByteLimit: 64 * 1024 * 1024, ancestryByteLimit: 256 * 1024 * 1024 };
        const approvalDigest = historyDigest(`resonance:history-volunteer-enrollment:v1\n${JSON.stringify([review, historyDigest(localKey)])}`);
        if (command === 'replica-enroll') {
          if (approved !== approvalDigest) throw new Error('Enrollment pins, destination, key or approval changed; review again');
          openHistoryVolunteerService({ ...options, initialize: pinned.root }).close();
        }
        emit({ ...review, approvalDigest, result: command === 'replica-plan' ? 'review-required' : 'enrolled' });
      } else {
        if (!/^(0|[1-9][0-9]*)$/.test(portText) || Number(portText) > 65535) throw new Error('Volunteer listener port must be an integer from 0 to 65535');
        serving = { service: openHistoryVolunteerService(options) };
        serving.listener = await listenHistoryAgreementReplica(serving.service, { port: Number(portText) });
        emit({ event: 'history_volunteer_listening', contextId: pinned.contextId, genesisId: pinned.genesisId, member,
          agreementEndpoint: serving.listener.endpoint, checkpointEndpoint: serving.listener.checkpointEndpoint,
          generations: serving.service.describe().generations });
      }
    } else throw new Error('Invalid admission history command');
    checkCancelled();
    if (!result) throw new Error('History command produced no result');
    const running = serving;
    return { result, ...(running?.listener ? { stop: async () => {
      try { await running.listener!.close(); } finally { running.service.close(); }
    } } : {}) };
  } catch (error) {
    try { await serving?.listener?.close(); } finally { serving?.service.close(); }
    throw error;
  } finally {
    commandOptions.signal?.removeEventListener('abort', cancel);
    for (const close of cleanup.reverse()) close();
  }
}
