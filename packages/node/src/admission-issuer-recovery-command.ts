/** Explicit issuer recovery commands. Original enrollment and source loss are independent operator pins. */
import { dirname, resolve } from 'node:path';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey } from '../../relay/src/admission-operator-files.js';
import { parseAdmissionHistoryArchiveLimits } from '../../relay/src/admission-history-config.js';
import { createPinnedHistoryOperatorTransport } from '../../relay/src/history-operator-transport.js';
import { prepareAdmissionBatchIssuer } from './blind-admission-issuance.js';
import { deriveAdmissionIssuerEncryptionKey } from './admission-issuer-state.js';
import { openProtectedAdmissionIssuerLedger } from './protected-admission-issuer-ledger.js';
import { openProtectedIssuerRecovery, prepareProtectedIssuerRecovery } from './admission-issuer-recovery.js';

function text(path: string, limit = 32768) {
  const bytes = readOperatorFile(path, limit);
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); }
  finally { bytes.fill(0); }
}
function configuration(file: string) {
  const value = readOperatorJson(file, 64 * 1024), hasLimits = !!value && typeof value === 'object' && Object.hasOwn(value, 'limits');
  if (!exactWitnessFields(value, ['version', 'context', 'members', 'ownerKeyFile', ...(hasLimits ? ['limits'] : [])]) || value.version !== 1
    || typeof value.ownerKeyFile !== 'string' || !value.ownerKeyFile.length || value.ownerKeyFile.length > 4096
    || !Array.isArray(value.members) || value.members.length !== 5) throw new Error('Invalid protected issuer configuration');
  const context = parseHistoryCheckpointContext(value.context);
  if (context.role !== 'admission-issuer') throw new Error('Issuer recovery requires its own admission-issuer role');
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string'
      || !context.members.includes(member.publicKey) || typeof member.endpoint !== 'string') throw new Error('Invalid pinned issuer history member');
    assertSecureRelayTransportEndpoint(member.endpoint); return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(member => member.publicKey)).size !== 5 || new Set(members.map(member => member.endpoint)).size !== 5) throw new Error('Issuer recovery requires five distinct pinned members and endpoints');
  return { context, members, ownerKeyFile: resolve(dirname(resolve(file)), value.ownerKeyFile),
    limits: parseAdmissionHistoryArchiveLimits(hasLimits ? value.limits : { archiveBytes: 64 * 1024 * 1024, archiveBlocks: 10001 }) };
}

export async function runProtectedIssuerRecoveryCommand(command: string, raw: readonly string[], signal?: AbortSignal, commandOptions: { transportFile?: string } = {}) {
  const commands = ['recovery-plan', 'recovery-start', 'recovery-status', 'recovery-step', 'recovery-review', 'recovery-restore', 'recovery-resume-plan', 'recovery-resume'];
  const applying = ['recovery-start', 'recovery-restore', 'recovery-resume'].includes(command);
  const approved = applying && raw[0] === '--approve' ? raw[1] : undefined, args = approved ? raw.slice(2) : raw;
  const planning = command === 'recovery-plan' || command === 'recovery-start', resuming = command === 'recovery-resume-plan' || command === 'recovery-resume';
  const length = planning ? 9 : command === 'recovery-status' || command === 'recovery-step' ? 7 : 8;
  if (!commands.includes(command) || applying && !/^sha256:[a-f0-9]{64}$/.test(approved ?? '') || args.length !== length
    || args.some(arg => typeof arg !== 'string' || !arg.length || arg.startsWith('--'))) throw new Error('Invalid protected issuer recovery command or missing reviewed approval');
  if (process.env.RESONANCE_RELAY_STORAGE_SELECTION_FILE) throw new Error('Issuer tools require explicitly selected issuer files');
  const cancelled = () => { if (signal?.aborted) throw new Error('Issuer recovery command cancelled; preserve pending work'); };
  cancelled();
  const [configFile, profileFile, privateFile, sourcePath, authorityFile, genesisFile, directory, first, second] = args;
  if (planning && (!['available', 'unavailable'].includes(first) || !/^[1-9][0-9]*$/.test(second))) throw new Error('Choose explicit issuer source availability and a positive view');
  const config = configuration(configFile), signingKey = readOperatorSigningKey(config.ownerKeyFile);
  let encryptionKey: Buffer | undefined;
  let source: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>> | undefined;
  let recovery: Awaited<ReturnType<typeof openProtectedIssuerRecovery>> | undefined;
  let restored: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>> | undefined;
  let resumption: { close(): void } | undefined;
  let transport: ReturnType<typeof createPinnedHistoryOperatorTransport> | undefined;
  const cancel = () => { source?.close(); recovery?.close(); restored?.close(); resumption?.close(); transport?.close(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const authority = text(authorityFile, 256).trim();
    if (authority !== config.context.authority || Buffer.from(signingKey.publicKey).toString('base64url') !== config.context.owner) throw new Error('Issuer recovery authority or owner differs from its independent pin');
    const enrollment = readOperatorJson(genesisFile, HISTORY_ENVELOPE_MAX_BYTES + 65536);
    if (!exactWitnessFields(enrollment, ['version', 'kind', 'context', 'root']) || enrollment.version !== 1 || enrollment.kind !== 'admission-history-enrollment'
      || historyCheckpointContextId(parseHistoryCheckpointContext(enrollment.context)) !== historyCheckpointContextId(config.context)) throw new Error('Issuer recovery requires a separate matching original enrollment file');
    const genesis = parseHistoryCheckpointEnvelope(enrollment.root, config.context);
    if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Issuer recovery requires the original generation-zero genesis enrollment');
    const pem = text(privateFile).trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
    if (!pem) throw new Error('Expected one PKCS8 issuer private key');
    const bytes = Buffer.from(pem[1].replace(/\s/g, ''), 'base64'); let privateKey: CryptoKey;
    try { privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']); }
    finally { bytes.fill(0); }
    const { profile } = await prepareAdmissionBatchIssuer({ expectedProfile: readOperatorJson(profileFile, 32768), privateKey }); cancelled();
    encryptionKey = await deriveAdmissionIssuerEncryptionKey(privateKey); cancelled();
    transport = createPinnedHistoryOperatorTransport({ context: config.context }, commandOptions.transportFile, signal);
    const timeoutMs = transport.maintenanceTimeoutMs ?? 30000;
    const options = { directory: resolve(directory), context: config.context, profile, authority, genesis, members: config.members,
      signingKey, encryptionKey, timeoutMs, transport: transport.protection.transport, agreementTransport: transport.agreementTransport,
      dataTransport: transport.dataTransport, provisionTransport: transport.provisionTransport };
    const protection = { context: config.context, signingKey, members: config.members, transport: transport.protection.transport, timeoutMs,
      maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks };
    if (planning) {
      if (first === 'available') source = await openProtectedAdmissionIssuerLedger({ path: resolve(sourcePath), expectedProfile: profile, privateKey,
        expectedAllocationAuthority: authority, protection: { ...protection, writerDirectory: `${resolve(sourcePath)}.history` } });
      cancelled();
      const review = await prepareProtectedIssuerRecovery({ ...options, source: source ? await source.reviewRecoverySource() : 'unavailable', view: Number(second), signal });
      cancelled(); if (command === 'recovery-plan') return { result: review };
      recovery = await openProtectedIssuerRecovery({ ...options, initialize: { review, approvedDigest: approved! } }); cancelled();
      return { result: { result: 'protected-issuer-recovery-created', ...recovery.status() } };
    }
    recovery = await openProtectedIssuerRecovery(options); cancelled();
    if (command === 'recovery-status') return { result: recovery.status() };
    if (command === 'recovery-step') return { result: await recovery.advance({ signal }) };
    const destination = { path: resolve(first), writerDirectory: `${resolve(first)}.history` };
    if (resuming) {
      const handle = await recovery.reviewResumption(destination, { privateKey, maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks, signal });
      resumption = handle; cancelled(); return { result: command === 'recovery-resume-plan' ? handle.review() : await handle.apply(approved!) };
    }
    const { preparation } = await recovery.reviewRestore(destination, signal); cancelled();
    if (command === 'recovery-review') return { result: preparation.review };
    restored = await openProtectedAdmissionIssuerLedger({ path: destination.path, expectedProfile: profile, privateKey, expectedAllocationAuthority: authority,
      protection: { ...protection, writerDirectory: destination.writerDirectory, initializeWriter: true, initializeArchive: true },
      restore: { preparation, approvedDigest: approved! } }); cancelled();
    return { result: { result: 'protected-issuer-history-restored', ...destination, status: restored.status(), readiness: 'unverified', startsService: false } };
  } catch (error) { throw transport ? transport.failure(error) : error; }
  finally { signal?.removeEventListener('abort', cancel); cancel(); encryptionKey?.fill(0); signingKey.secretKey.fill(0); }
}
