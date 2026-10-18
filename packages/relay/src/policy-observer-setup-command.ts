/** Explicit initial preparation and independently pinned volunteer operation. */
import { existsSync, readdirSync } from 'node:fs';
import { canonicalHistorySetupPath } from './admission-history-setup.js';
import { readOperatorFile, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { historyDigest } from '@resonance/core/history-checkpoint';
import { readPolicyObserverConfigurationFile } from './policy-observer-config.js';
import { openPolicyObserverSetup, policyObserverEnrollment, readPolicyObserverEnrollment, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES } from './policy-observer-setup.js';
import { openPolicyObserverInitialSetup } from './policy-observer-restore-resumption.js';
import { openHistoryVolunteerService } from './history-volunteer-service.js';
import { openHistoryVolunteerEnrollmentResume } from './history-volunteer-enrollment.js';
import { listenHistoryAgreementReplica } from './history-agreement-exchange.js';
import { createPinnedHistoryOperatorTransport } from './history-operator-transport.js';

export async function runPolicyObserverSetupCommand(command: string, raw: readonly string[], signal?: AbortSignal, commandOptions: { transportFile?: string } = {}): Promise<{ result: object; close?: () => Promise<void> }> {
  const applying = ['setup-create', 'initialize', 'replica-enroll', 'replica-resume'].includes(command);
  const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
  if (applying && !approved || args.some(arg => !arg || arg.startsWith('--'))) throw new Error('Invalid policy setup command or missing approval');
  signal?.throwIfAborted();
  if (['setup-plan', 'setup-create', 'setup-export'].includes(command)) {
    if (args.length !== 2) throw new Error('Policy preparation requires setup input and a new configuration output');
    const setup = await openPolicyObserverSetup({ setupFile: args[0], output: args[1], mode: command === 'setup-export' ? 'export' : 'new' }, signal);
    try {
      return { result: command === 'setup-plan' ? setup.review() : await setup.apply(command === 'setup-export' ? setup.review().approvalDigest : approved!) };
    } finally { setup.close(); }
  }
  if (command === 'enrollment-export') {
    if (args.length !== 2) throw new Error('Policy enrollment export requires configuration and a new public output');
    const value = policyObserverEnrollment(readPolicyObserverConfigurationFile(args[0])), output = canonicalHistorySetupPath(args[1]);
    signal?.throwIfAborted(); writeOperatorJsonNew(output, value, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES);
    return { result: { result: 'policy-enrollment-exported', output, readiness: 'unverified', startsService: false } };
  }
  if (['initialize-plan', 'initialize'].includes(command)) {
    if (args.length !== 1) throw new Error('Policy initialization needs its exact prepared configuration');
    const config = readPolicyObserverConfigurationFile(args[0]), signingKey = readOperatorSigningKey(config.signingKeyFile);
    let encryptionKey: Buffer | undefined, setup: Awaited<ReturnType<typeof openPolicyObserverInitialSetup>> | undefined;
    let transport: ReturnType<typeof createPinnedHistoryOperatorTransport> | undefined;
    try {
      transport = createPinnedHistoryOperatorTransport({ context: config.historyContext }, commandOptions.transportFile, signal);
      encryptionKey = readOperatorStorageKey(config.storageKeyFile);
      setup = await openPolicyObserverInitialSetup({ directory: config.directory, context: config.context, historyContext: config.historyContext,
        root: config.root, genesis: config.genesis, signingKey, encryptionKey, members: config.members,
        maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks, signal, transport: transport.protection.transport });
      return { result: command === 'initialize-plan' ? setup.review() : await setup.apply(approved!) };
    } finally { setup?.close(); transport?.close(); encryptionKey?.fill(0); signingKey.secretKey.fill(0); }
  }
  if (!['replica-plan', 'replica-enroll', 'replica-resume-plan', 'replica-resume', 'replica-serve'].includes(command)
    || args.length !== (command === 'replica-serve' ? 5 : 4)) throw new Error('Invalid policy volunteer command');
  if (command === 'replica-serve' && commandOptions.transportFile !== undefined) throw new Error('Policy volunteer background routing needs its enrolled relay configuration, not an owner operator transport');
  const [enrollment, signingPath, storagePath, target, portText] = args;
  const directory = canonicalHistorySetupPath(target), pinned = readPolicyObserverEnrollment(enrollment), signer = readOperatorSigningKey(signingPath);
  let key: Buffer | undefined, service: ReturnType<typeof openHistoryVolunteerService> | undefined;
  let resume: ReturnType<typeof openHistoryVolunteerEnrollmentResume> | undefined, listener: Awaited<ReturnType<typeof listenHistoryAgreementReplica>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { signal?.removeEventListener('abort', abort); try { await listener?.close(); } finally { service?.close(); resume?.close(); } })();
  const abort = () => { void close().catch(() => {}); };
  const cancelled = () => { signal?.throwIfAborted(); if (closing) throw new Error('Policy volunteer command closed'); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    key = readOperatorStorageKey(storagePath); cancelled();
    const member = Buffer.from(signer.publicKey).toString('base64url');
    if (!pinned.historyContext.members.includes(member)) throw new Error('Volunteer is not an independently pinned member');
    const options = { directory, context: pinned.historyContext, genesisId: pinned.genesisId, signingKey: signer, localKey: key };
    if (command === 'replica-serve') {
      if (!/^(0|[1-9][0-9]*)$/.test(portText) || Number(portText) > 65535) throw new Error('Invalid policy volunteer port');
      service = openHistoryVolunteerService(options);
      listener = await listenHistoryAgreementReplica(service, { port: Number(portText) });
      if (signal?.aborted || closing) { await listener.close(); service.close(); cancelled(); }
      return { result: { event: 'policy_history_volunteer_listening', contextId: pinned.contextId, genesisId: pinned.genesisId, member,
        checkpointEndpoint: listener.checkpointEndpoint, agreementEndpoint: listener.endpoint }, close };
    }
    const fingerprints = () => [[enrollment, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES], [signingPath, 4096], [storagePath, 128]].map(([p, maximum]) => {
      const bytes = readOperatorFile(p as string, maximum as number);
      try { return [canonicalHistorySetupPath(p as string), historyDigest(bytes)]; } finally { bytes.fill(0); }
    });
    const files = fingerprints(), resuming = command.startsWith('replica-resume');
    const empty = () => { if (existsSync(directory) && readdirSync(directory).length) throw new Error('Policy volunteer enrollment needs an empty directory'); };
    if (resuming) resume = openHistoryVolunteerEnrollmentResume({ ...options, genesis: pinned.root }, signal);
    else empty();
    const details = resume?.review ?? { kind: 'policy-volunteer-enrollment', directory, contextId: pinned.contextId, genesisId: pinned.genesisId,
      member, owner: pinned.historyContext.owner, maximumGenerations: 65, generationByteLimit: 64 * 1024 * 1024,
      ancestryByteLimit: 256 * 1024 * 1024, readiness: 'unverified', startsService: false };
    const review = { ...details, approvalDigest: historyDigest(`resonance:policy-volunteer-setup:v1\n${JSON.stringify([details, files])}`) };
    if (applying) {
      cancelled();
      if (approved !== review.approvalDigest || directory !== canonicalHistorySetupPath(target) || JSON.stringify(files) !== JSON.stringify(fingerprints())) {
        throw new Error('Policy volunteer setup requires matching reviewed approval');
      }
      if (resume) resume.apply(resume.review.approvalDigest);
      else { empty(); service = openHistoryVolunteerService({ ...options, initialize: pinned.root }); }
    }
    await close(); return { result: { ...review, result: applying ? 'policy-volunteer-enrolled' : 'review-required' } };
  } catch (error) { await close(); throw error; }
  finally { key?.fill(0); signer.secretKey.fill(0); }
}
