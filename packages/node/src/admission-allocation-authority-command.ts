/** Explicit protected allocation-authority operations. No command infers missing owner state. */
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES } from '@resonance/core/admission-issuance-allocation';
import { MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES } from '@resonance/core/admission-claim-assignment';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, writeOperatorJsonNew } from '../../relay/src/admission-operator-files.js';
import { parseAdmissionHistoryArchiveLimits } from '../../relay/src/admission-history-config.js';
import { createPinnedHistoryOperatorTransport } from '../../relay/src/history-operator-transport.js';
import { allocationAuthorityHistoryAnchor, assertAdmissionAllocationAuthority, deriveAdmissionAllocationAuthorityEncryptionKey } from './admission-allocation-authority-state.js';
import { openProtectedAdmissionAllocationAuthority } from './protected-admission-allocation-authority.js';
import { openProtectedAllocationAuthorityRecovery, prepareProtectedAllocationAuthorityRecovery } from './admission-allocation-authority-recovery.js';

const defaults = { timeoutMs: 30000, maxReplayBlocks: 10001, maxReplayBytes: 256 * 1024 * 1024, replayTimeoutMs: 30000 };
const archiveDefaults = { archiveBytes: 64 * 1024 * 1024, archiveBlocks: 10001 };
function text(path: string, maximum = 256) {
  const bytes = readOperatorFile(path, maximum);
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } finally { bytes.fill(0); }
}
function privateRequest(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK), bytes = Buffer.alloc(MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES + 1);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Claim assignment request requires a bounded regular private file');
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    if (used > MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES) throw new Error('Claim assignment request exceeds its byte limit');
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, used))); }
    catch { throw new Error('Claim assignment request must contain valid UTF-8 JSON'); }
  } finally { bytes.fill(0); closeSync(fd); }
}
function recoveryConfiguration(value: unknown) {
  if (!exactWitnessFields(value, ['timeoutMs', 'maxReplayBlocks', 'maxReplayBytes', 'replayTimeoutMs'])
    || ![value.timeoutMs, value.maxReplayBlocks, value.maxReplayBytes, value.replayTimeoutMs].every(Number.isSafeInteger)
    || (value.timeoutMs as number) < 50 || (value.timeoutMs as number) > 30000 || (value.maxReplayBlocks as number) < 1 || (value.maxReplayBlocks as number) > 10001
    || (value.maxReplayBytes as number) < 1 || (value.maxReplayBytes as number) > 256 * 1024 * 1024
    || (value.replayTimeoutMs as number) < 50 || (value.replayTimeoutMs as number) > 300000) throw new Error('Invalid allocation authority recovery bounds');
  return { timeoutMs: value.timeoutMs as number, maxReplayBlocks: value.maxReplayBlocks as number, maxReplayBytes: value.maxReplayBytes as number, replayTimeoutMs: value.replayTimeoutMs as number };
}
function configuration(value: unknown) {
  const limits = !!value && typeof value === 'object' && Object.hasOwn(value, 'limits');
  const recovery = !!value && typeof value === 'object' && Object.hasOwn(value, 'recovery');
  if (!exactWitnessFields(value, ['version', 'context', 'members', 'ownerKeyFile', ...(limits ? ['limits'] : []), ...(recovery ? ['recovery'] : [])])
    || value.version !== 1 || typeof value.ownerKeyFile !== 'string' || !value.ownerKeyFile.length || value.ownerKeyFile.length > 4096
    || !Array.isArray(value.members) || value.members.length !== 5) throw new Error('Invalid protected allocation authority configuration');
  const context = parseHistoryCheckpointContext(value.context);
  if (context.role !== 'admission-allocation-authority' || context.policyDigest !== allocationAuthorityHistoryAnchor(context.authority)) throw new Error('Allocation authority configuration requires its own role and static genesis anchor');
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string' || !context.members.includes(member.publicKey)
      || typeof member.endpoint !== 'string') throw new Error('Invalid pinned allocation history member');
    assertSecureRelayTransportEndpoint(member.endpoint); const endpoint = new URL(member.endpoint);
    if (endpoint.pathname !== '/history-checkpoint' || endpoint.search || endpoint.hash) throw new Error('Allocation history requires standard pinned endpoints');
    return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (new Set(members.map(member => member.publicKey)).size !== 5 || new Set(members.map(member => member.endpoint)).size !== 5) throw new Error('Allocation history requires five distinct pinned members and endpoints');
  return { version: 1 as const, context, members, ownerKeyFile: value.ownerKeyFile,
    limits: parseAdmissionHistoryArchiveLimits(limits ? value.limits : archiveDefaults), recovery: recovery ? recoveryConfiguration(value.recovery) : undefined };
}
const recoveryCommands = ['recovery-plan', 'recovery-start', 'recovery-status', 'recovery-step', 'recovery-review', 'recovery-restore', 'recovery-resume-plan', 'recovery-resume'];
interface CommandOptions { transportFile?: string }
/** Same strict grammar for the recovery-only entry point and the main command dispatcher. */
export async function runProtectedAllocationAuthorityRecoveryCommand(command: string, raw: readonly string[], signal?: AbortSignal, options: CommandOptions = {}) {
  if (!recoveryCommands.includes(command)) throw new Error('Invalid protected allocation authority recovery command');
  return runProtectedAllocationAuthorityCommand(command, raw, signal, options);
}
export async function runProtectedAllocationAuthorityCommand(command: string, raw: readonly string[], signal?: AbortSignal, commandOptions: CommandOptions = {}) {
  const recoveryCommand = recoveryCommands.includes(command), planning = command === 'recovery-plan' || command === 'recovery-start';
  const digestWrite = ['sign', 'assign', 'recovery-start', 'recovery-restore', 'recovery-resume'].includes(command);
  const simpleWrite = ['config', 'init'].includes(command);
  const approved = digestWrite && raw[0] === '--approve' ? raw[1] : undefined;
  const args = digestWrite && approved ? raw.slice(2) : simpleWrite && raw[0] === '--approve' ? raw.slice(1) : raw;
  const count = { config: 4, init: 5, enrollment: 5, status: 4, ready: 4, review: 5, sign: 6, reexport: 6, 'assignment-review': 5, assign: 6, 'assignment-reexport': 6,
    'recovery-plan': 8, 'recovery-start': 8, 'recovery-status': 6, 'recovery-step': 6, 'recovery-review': 7, 'recovery-restore': 7, 'recovery-resume-plan': 7, 'recovery-resume': 7 }[command];
  if (!count || args.length !== count || digestWrite && !/^sha256:[a-f0-9]{64}$/.test(approved ?? '') || simpleWrite && raw[0] !== '--approve'
    || args.some(arg => typeof arg !== 'string' || !arg.length || arg.startsWith('--'))) throw new Error('Invalid protected allocation authority command or missing reviewed approval');
  if (process.env.RESONANCE_RELAY_STORAGE_SELECTION_FILE) throw new Error('Allocation authority tools require explicitly selected independent files');
  const cancelled = () => { if (signal?.aborted) throw new Error('Allocation authority command cancelled; preserve pending work'); };
  cancelled();
  if (planning && (!['available', 'unavailable'].includes(args[6]) || !/^[1-9][0-9]*$/.test(args[7]) || !Number.isSafeInteger(Number(args[7])))) throw new Error('Choose explicit allocation authority source availability and a positive view');
  if (command === 'config') {
    const [ownerFile, authorityFile, membersFile, output] = args, authority = text(authorityFile).trim(); assertAdmissionAllocationAuthority(authority);
    const members = readOperatorJson(membersFile, 65536), owner = readOperatorSigningKey(ownerFile);
    try {
      if (!Array.isArray(members)) throw new Error('Configuration requires five explicit history member records');
      const config = configuration({ version: 1, context: { version: 1, role: 'admission-allocation-authority', historyId: randomBytes(32).toString('base64url'),
        owner: Buffer.from(owner.publicKey).toString('base64url'), authority, policyDigest: allocationAuthorityHistoryAnchor(authority), members: members.map(member => member?.publicKey).sort(), quorum: 4 },
        members, ownerKeyFile: resolve(ownerFile), limits: archiveDefaults, recovery: defaults });
      writeOperatorJsonNew(output, config, 65536);
      return { result: { result: 'protected-allocation-authority-configuration', contextId: historyCheckpointContextId(config.context), output: resolve(output) } };
    } finally { owner.secretKey.fill(0); }
  }
  // Read every input file before the first await, including private requests and the original enrollment pin.
  const [configFile, authorityFile, privateFile, path, first, second, third, fourth] = args;
  const output = ['init', 'enrollment'].includes(command) ? first : ['sign', 'reexport', 'assign', 'assignment-reexport'].includes(command) ? second : undefined;
  if (output && existsSync(output)) throw new Error('Output already exists; select a new filename');
  const config = configuration(readOperatorJson(configFile, 65536)), authority = text(authorityFile).trim();
  if (authority !== config.context.authority) throw new Error('Allocation authority differs from its independent pin');
  const input = ['review', 'sign'].includes(command) ? readOperatorJson(first, MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES)
    : ['assignment-review', 'assign', 'assignment-reexport'].includes(command) ? privateRequest(first) : undefined;
  const enrollment = recoveryCommand ? readOperatorJson(first, HISTORY_ENVELOPE_MAX_BYTES + 65536) : undefined;
  const signingKey = readOperatorSigningKey(resolve(dirname(resolve(configFile)), config.ownerKeyFile));
  let authorityKey: ReturnType<typeof readOperatorSigningKey> | undefined, encryptionKey: Buffer | undefined;
  let ledger: Awaited<ReturnType<typeof openProtectedAdmissionAllocationAuthority>> | undefined;
  let recovery: Awaited<ReturnType<typeof openProtectedAllocationAuthorityRecovery>> | undefined;
  let resumption: { close(): void } | undefined;
  let transport: ReturnType<typeof createPinnedHistoryOperatorTransport> | undefined;
  const cancel = () => { ledger?.close(); recovery?.close(); resumption?.close(); transport?.close(); };
  try {
    signal?.addEventListener('abort', cancel, { once: true });
    authorityKey = readOperatorSigningKey(privateFile);
    if (Buffer.from(authorityKey.publicKey).toString('base64url') !== authority || Buffer.from(signingKey.publicKey).toString('base64url') !== config.context.owner) throw new Error('Allocation authority or history owner key differs from its independent pin');
    encryptionKey = deriveAdmissionAllocationAuthorityEncryptionKey(authorityKey.secretKey, authority);
    transport = createPinnedHistoryOperatorTransport({ context: config.context }, commandOptions.transportFile, signal);
    const timeoutMs = config.recovery?.timeoutMs ?? transport.maintenanceTimeoutMs ?? defaults.timeoutMs;
    const protection = { context: config.context, signingKey, members: config.members, transport: transport.protection.transport, timeoutMs,
      writerDirectory: `${resolve(path)}.history`, maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks };
    const openOwner = (mode: 'create-new' | 'open-existing') => openProtectedAdmissionAllocationAuthority({ path: resolve(path), authority, secretKey: authorityKey!.secretKey, mode, protection });
    if (!recoveryCommand) {
      ledger = await openOwner(command === 'init' ? 'create-new' : 'open-existing'); cancelled();
      if (command === 'status') return { result: ledger.status() };
      if (command === 'init' || command === 'enrollment') {
        writeOperatorJsonNew(first, { version: 1, kind: 'admission-history-enrollment', ...ledger.enrollment() }, HISTORY_ENVELOPE_MAX_BYTES + 65536);
        return { result: { result: 'protected-allocation-authority-enrollment', output: resolve(first), readiness: 'unverified' } };
      }
      if (command === 'ready') { await ledger.ready(); cancelled(); return { result: { result: 'protected-allocation-authority-ready', ...ledger.status() } }; }
      if (command === 'review' || command === 'sign') {
        const reviewed = await ledger.review(input); cancelled();
        if (command === 'review') return { result: { result: 'allocation-plan-reviewed', authority, ...reviewed } };
        if (approved !== reviewed.approvalDigest) throw new Error('Approval digest does not match this allocation plan; review it again');
        if (!ledger.current(reviewed.body.community, reviewed.body.epoch)) { await ledger.ready(); cancelled(); }
        const manifest = await ledger.sign(input, approved!); cancelled(); writeOperatorJsonNew(second, manifest, MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES);
        return { result: { result: 'signed-allocation-saved', epoch: manifest.epoch, allocationDigest: ledger.digest(manifest) } };
      }
      if (command === 'reexport') {
        const manifest = ledger.current('public', first); if (!manifest) throw new Error('No signed allocation retained for this epoch');
        writeOperatorJsonNew(second, manifest, MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES);
        return { result: { result: 'signed-allocation-saved', epoch: manifest.epoch, allocationDigest: ledger.digest(manifest) } };
      }
      const reviewed = await ledger.reviewAssignment(input); cancelled();
      if (command === 'assignment-review') return { result: { result: 'claim-assignment-reviewed', approvalDigest: reviewed.approvalDigest, allocationDigest: reviewed.body.allocationDigest, issuerKeyFingerprint: reviewed.body.issuerKeyFingerprint } };
      let assignment = ledger.currentAssignment(reviewed.body.community, reviewed.body.epoch, reviewed.body.claimHandle);
      if (command === 'assign') {
        if (approved !== reviewed.approvalDigest) throw new Error('Approval digest does not match this claim assignment; review it again');
        if (!assignment) { await ledger.ready(); cancelled(); }
        assignment = await ledger.assignClaim(input, approved!); cancelled();
      }
      if (!assignment) throw new Error('No signed claim assignment retained');
      if (assignment.issuerKeyFingerprint !== reviewed.body.issuerKeyFingerprint) throw new Error('Claim already assigned to a different issuer');
      writeOperatorJsonNew(second, assignment, MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES);
      return { result: { result: 'signed-claim-assignment-saved', allocationDigest: assignment.allocationDigest } };
    }
    if (!exactWitnessFields(enrollment, ['version', 'kind', 'context', 'root']) || enrollment.version !== 1 || enrollment.kind !== 'admission-history-enrollment'
      || historyCheckpointContextId(parseHistoryCheckpointContext(enrollment.context)) !== historyCheckpointContextId(config.context)) throw new Error('Recovery requires a separate matching original enrollment file');
    const genesis = parseHistoryCheckpointEnvelope(enrollment.root, config.context);
    if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Recovery requires the original generation-zero genesis enrollment');
    const options = { directory: resolve(second), context: config.context, authority, genesis, members: config.members, signingKey, encryptionKey,
      timeoutMs, maxReplayBlocks: config.recovery?.maxReplayBlocks ?? defaults.maxReplayBlocks, maxReplayBytes: config.recovery?.maxReplayBytes ?? defaults.maxReplayBytes,
      replayTimeoutMs: config.recovery?.replayTimeoutMs ?? defaults.replayTimeoutMs, maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks,
      transport: transport.protection.transport, agreementTransport: transport.agreementTransport, dataTransport: transport.dataTransport, provisionTransport: transport.provisionTransport };
    if (planning) {
      if (third === 'available') ledger = await openOwner('open-existing'); cancelled();
      const review = await prepareProtectedAllocationAuthorityRecovery({ ...options, source: ledger ? await ledger.reviewRecoverySource() : 'unavailable', view: Number(fourth), signal }); cancelled();
      if (command === 'recovery-plan') return { result: review };
      recovery = await openProtectedAllocationAuthorityRecovery({ ...options, initialize: { review, approvedDigest: approved! } }); cancelled();
      return { result: { result: 'protected-allocation-authority-recovery-created', ...recovery.status() } };
    }
    recovery = await openProtectedAllocationAuthorityRecovery(options); cancelled();
    if (command === 'recovery-status') return { result: recovery.status() };
    if (command === 'recovery-step') return { result: await recovery.advance({ signal }) };
    const destination = { path: resolve(third), writerDirectory: `${resolve(third)}.history` };
    if (command === 'recovery-resume-plan' || command === 'recovery-resume') {
      const handle = await recovery.reviewResumption(destination, { secretKey: authorityKey.secretKey, signal }); resumption = handle; cancelled();
      return { result: command === 'recovery-resume-plan' ? handle.review() : await handle.apply(approved!) };
    }
    const { preparation } = await recovery.reviewRestore(destination, signal); cancelled();
    if (command === 'recovery-review') return { result: preparation.review };
    ledger = await openProtectedAdmissionAllocationAuthority({ path: destination.path, authority, secretKey: authorityKey.secretKey, mode: 'create-new',
      protection: { ...protection, writerDirectory: destination.writerDirectory }, restore: { preparation, approvedDigest: approved! } }); cancelled();
    return { result: { result: 'protected-allocation-authority-history-restored', ...destination, status: ledger.status(), readiness: 'unverified', startsService: false } };
  } catch (error) { throw transport ? transport.failure(error) : error; }
  finally {
    encryptionKey?.fill(0); authorityKey?.secretKey.fill(0); signingKey.secretKey.fill(0);
    try { signal?.removeEventListener('abort', cancel); } finally { cancel(); }
  }
}
