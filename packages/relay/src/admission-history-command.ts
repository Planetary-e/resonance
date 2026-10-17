/** Explicit preparation/enrollment. No command resets missing accepted history or chooses new members. */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAX_ADMISSION_POLICY_BYTES, admissionPolicyDigest, assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { loadAdmissionHistoryProtectionFile, parseAdmissionHistoryConfiguration } from './admission-history-config.js';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';
import { openHistoryVolunteerEnrollmentResume } from './history-volunteer-enrollment.js';
import { openHistoryVolunteerService } from './history-volunteer-service.js';
import { listenHistoryAgreementReplica } from './history-agreement-exchange.js';
import { discoverHistoryContinuations } from './history-continuation-discovery.js';
import { createHistoryOperatorTransport } from './history-operator-transport.js';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from './admission-history-recovery.js';
import { reviewAdmissionOwnerConfiguration, openAdmissionOwnerSetup, canonicalHistorySetupPath, type AdmissionOwnerSetupMode } from './admission-history-setup.js';
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
      emit(await measureStorageDirectories(raw.map(path => resolve(path)), { signal: commandOptions.signal }));
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
    } else if (command?.startsWith('owner-recovery-')) {
      const mutation = ['owner-recovery-start', 'owner-recovery-restore', 'owner-recovery-ready'].includes(command);
      const approved = mutation && raw[0] === '--approve' ? raw[1] : undefined;
      const args = approved ? raw.slice(2) : raw;
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
      const options = { directory, ...transport, encryptionKey, genesis: pinned.root };
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
    } else if (['owner-retirement-plan', 'owner-retire', 'owner-legacy-plan', 'owner-legacy-recover'].includes(command)) {
      const mutating = command === 'owner-retire' || command === 'owner-legacy-recover';
      const approved = mutating && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
      if (args.length !== 5 || (mutating && !approved)) throw new Error('Invalid protected maintenance command or missing approval');
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
      const proofs = retiring ? undefined : readOperatorJson(target, 65536);
      const plan = retiring ? history.planRetirement(target) : await history.planLegacyRecovery(proofs);
      if (mutating) {
        if (approved !== plan.approvalDigest) throw new Error('Maintenance approval does not match; review the current history again');
        await history.ready(); // Fresh quorum is independent of the offline review.
        if (retiring) await history.retire(target, approved!);
        else await history.recoverLegacy(proofs, approved!); // Rechecks evidence/digest after readiness.
      }
      emit({ ...plan, durability: 'protected-four-of-five', readiness: mutating ? 'confirmed' : 'unverified',
        result: !mutating ? 'review-required' : retiring ? 'permanently-retired' : 'legacy-spends-recovered' });
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
