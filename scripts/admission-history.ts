/** Explicit preparation/enrollment. No command resets missing accepted history or chooses new members. */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAX_ADMISSION_POLICY_BYTES, admissionPolicyDigest, assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { loadAdmissionHistoryProtectionFile, parseAdmissionHistoryConfiguration } from '../packages/relay/src/admission-history-config.js';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from '../packages/relay/src/admission-operator-files.js';
import { openProtectedAdmissionSpendHistory } from '../packages/relay/src/protected-admission-history.js';
import { openHistoryVolunteerService } from '../packages/relay/src/history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../packages/relay/src/history-agreement-exchange.js';
import { discoverHistoryContinuations } from '../packages/relay/src/history-continuation-discovery.js';

const ENROLLMENT_MAX = HISTORY_ENVELOPE_MAX_BYTES + 65536;
const cleanup: Array<() => void> = [];
let serving: { service: ReturnType<typeof openHistoryVolunteerService>; listener?: Awaited<ReturnType<typeof listenHistoryAgreementReplica>> } | undefined;
function empty(path: string) { if (existsSync(path) && readdirSync(path).length) throw new Error('New enrollment requires an empty destination'); }
function enrollment(path: string) {
  const raw = readOperatorJson(path, ENROLLMENT_MAX);
  if (!exactWitnessFields(raw, ['version', 'kind', 'context', 'root']) || raw.version !== 1 || raw.kind !== 'admission-history-enrollment') {
    throw new Error('Invalid history enrollment file');
  }
  const context = parseHistoryCheckpointContext(raw.context), root = parseHistoryCheckpointEnvelope(raw.root, context);
  if (root.kind !== 'checkpoint' || root.generation !== 0 || root.sequence !== 0) throw new Error('Volunteer enrollment needs its independently pinned genesis');
  return { context, root, contextId: historyCheckpointContextId(context), genesisId: historyCheckpointEnvelopeId(root) };
}
try {
  const [command, ...raw] = process.argv.slice(2);
  if (command === 'owner-config' && raw.length === 5) {
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
    console.log(JSON.stringify({ result: 'new-owner-configuration', contextId: historyCheckpointContextId(config.context), output: resolve(output) }));
  } else if (['owner-prepare', 'owner-export', 'owner-resume-setup'].includes(command) && raw.length === 5) {
    const [configPath, policyPath, keyPath, directory, output] = raw;
    if (existsSync(output)) throw new Error('Enrollment output exists; choose another output path');
    if (command === 'owner-prepare') empty(directory);
    const protection = loadAdmissionHistoryProtectionFile(configPath); cleanup.push(() => protection.signingKey.secretKey.fill(0));
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
    console.log(JSON.stringify({ result: 'enrollment-exported', contextId: historyCheckpointContextId(value.context),
      genesisId: historyCheckpointEnvelopeId(value.root), output: resolve(output), readiness: 'unverified' }));
  } else if (command === 'owner-inspect' && raw.length === 2) {
    const protection = loadAdmissionHistoryProtectionFile(raw[0]); cleanup.push(() => protection.signingKey.secretKey.fill(0));
    const pinned = enrollment(raw[1]);
    if (pinned.contextId !== historyCheckpointContextId(protection.context)) throw new Error('Enrollment and owner configuration differ');
    const observation = await discoverHistoryContinuations({ ...protection, genesisId: pinned.genesisId });
    console.log(JSON.stringify({ result: 'history-observed', contextId: observation.contextId, genesisId: pinned.genesisId,
      certifiedBoundaries: observation.continuations.length, observedGeneration: observation.observedLeaf.generation,
      readiness: 'unverified', mutation: 'none' }));
  } else if (['replica-plan', 'replica-enroll', 'replica-serve'].includes(command)) {
    const approved = command === 'replica-enroll' && raw[0] === '--approve' ? raw[1] : undefined;
    const args = approved ? raw.slice(2) : raw;
    if (args.length !== (command === 'replica-serve' ? 5 : 4) || (command === 'replica-enroll' && !approved)) throw new Error('Invalid replica command or missing digest approval');
    const [enrollmentPath, memberPath, keyPath, target, portText] = args, directory = resolve(target);
    const pinned = enrollment(enrollmentPath), signingKey = readOperatorSigningKey(memberPath); cleanup.push(() => signingKey.secretKey.fill(0));
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
      console.log(JSON.stringify({ ...review, approvalDigest, result: command === 'replica-plan' ? 'review-required' : 'enrolled' }));
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(portText) || Number(portText) > 65535) throw new Error('Volunteer listener port must be an integer from 0 to 65535');
      serving = { service: openHistoryVolunteerService(options) };
      serving.listener = await listenHistoryAgreementReplica(serving.service, { port: Number(portText) });
      console.log(JSON.stringify({ event: 'history_volunteer_listening', contextId: pinned.contextId, genesisId: pinned.genesisId, member,
        agreementEndpoint: serving.listener.endpoint, checkpointEndpoint: serving.listener.checkpointEndpoint,
        generations: serving.service.describe().generations }));
    }
  } else throw new Error('Invalid admission history command');
} catch (error) {
  await serving?.listener?.close(); serving?.service.close(); serving = undefined;
  console.error(error instanceof Error ? error.message : 'Admission history operation failed');
  console.error('Usage: node --import tsx scripts/admission-history.ts');
  console.error('  owner-config owner-private.json authority.pub policy.json members.json owner-config.json');
  console.error('  owner-prepare|owner-export|owner-resume-setup owner-config.json policy.json owner-storage.hex owner-directory enrollment.json');
  console.error('  owner-inspect owner-config.json enrollment.json');
  console.error('  replica-plan enrollment.json member-private.json member-storage.hex replica-directory');
  console.error('  replica-enroll --approve <digest> enrollment.json member-private.json member-storage.hex replica-directory');
  console.error('  replica-serve enrollment.json member-private.json member-storage.hex replica-directory <port>');
  process.exitCode = 1;
} finally { for (const close of cleanup.reverse()) close(); }

if (serving?.listener) {
  const running = serving; let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await running.listener!.close(); running.service.close(); process.exitCode = 0; }
    catch { running.service.close(); process.exitCode = 1; }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
