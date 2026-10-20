/** Explicit issuer recovery commands. Original enrollment and source loss are independent operator pins. */
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { assertExistingHistoryAncestryFunding, captureHistoryAncestrySource, type OwnedHistoryAncestrySource } from '../../relay/src/history-ancestry-source.js';
import { parseProtectedIssuerConfiguration } from './protected-issuer-configuration.js';
import { dirname, join, resolve } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey } from '../../relay/src/admission-operator-files.js';
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
  const parsed = parseProtectedIssuerConfiguration(readOperatorJson(file, 64 * 1024));
  return { ...parsed, ownerKeyFile: resolve(dirname(resolve(file)), parsed.ownerKeyFile) };
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
  const config = configuration(configFile), ancestry = config.ancestry && captureHistoryAncestrySource(config.ancestry, configFile, config.context);
  const funding = ancestry && openStorageReservationAuthority({ directory: ancestry.funding.authorityDirectory, authorityId: ancestry.funding.authorityId, mode: 'open-existing' });
  let signingKey: ReturnType<typeof readOperatorSigningKey>;
  try { signingKey = readOperatorSigningKey(config.ownerKeyFile); } catch (error) { funding?.close(); throw error; }
  let ancestryHandle: OwnedHistoryAncestrySource | undefined;
  let preparation: import('./admission-issuer-history-restore.js').PreparedProtectedIssuerRestore | undefined;
  let encryptionKey: Buffer | undefined;
  let source: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>> | undefined;
  let recovery: Awaited<ReturnType<typeof openProtectedIssuerRecovery>> | undefined;
  let restored: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>> | undefined;
  let resumption: { close(): void } | undefined;
  let transport: ReturnType<typeof createPinnedHistoryOperatorTransport> | undefined;
  const cancel = () => { source?.close(); recovery?.close(); restored?.close(); resumption?.close(); ancestryHandle?.close(); transport?.close(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const operate = async () => { try {
    ancestry?.check();
    if (ancestry) assertExistingHistoryAncestryFunding(resolve(dirname(resolve(configFile)), config.ancestry!.directory), ancestry.funding.authorityId);
    const authority = text(authorityFile, 256).trim();
    if (authority !== config.context.authority || Buffer.from(signingKey.publicKey).toString('base64url') !== config.context.owner) throw new Error('Issuer recovery authority or owner differs from its independent pin');
    const enrollment = readOperatorJson(genesisFile, HISTORY_ENVELOPE_MAX_BYTES + 65536);
    if (!exactWitnessFields(enrollment, ['version', 'kind', 'context', 'root']) || enrollment.version !== 1 || enrollment.kind !== 'admission-history-enrollment'
      || historyCheckpointContextId(parseHistoryCheckpointContext(enrollment.context)) !== historyCheckpointContextId(config.context)) throw new Error('Issuer recovery requires a separate matching original enrollment file');
    const genesis = parseHistoryCheckpointEnvelope(enrollment.root, config.context);
    if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Issuer recovery requires the original generation-zero genesis enrollment');
    if (!planning && !['recovery-status', 'recovery-step'].includes(command)) ancestry?.assertRecoveryDownload({ directory: join(resolve(directory), 'download'), genesisId: historyCheckpointEnvelopeId(genesis) });
    const pem = text(privateFile).trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
    if (!pem) throw new Error('Expected one PKCS8 issuer private key');
    const bytes = Buffer.from(pem[1].replace(/\s/g, ''), 'base64'); let privateKey: CryptoKey;
    try { privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']); }
    finally { bytes.fill(0); }
    const { profile } = await prepareAdmissionBatchIssuer({ expectedProfile: readOperatorJson(profileFile, 32768), privateKey }); cancelled();
    encryptionKey = await deriveAdmissionIssuerEncryptionKey(privateKey); cancelled();
    transport = createPinnedHistoryOperatorTransport({ context: config.context }, commandOptions.transportFile, signal);
    const timeoutMs = transport.maintenanceTimeoutMs ?? 30000;
    const options = { ancestrySelection: !planning && !['recovery-status', 'recovery-step'].includes(command) ? ancestry : undefined, ancestryBinding: ancestry?.binding, directory: resolve(directory), context: config.context, profile, authority, genesis, members: config.members,
      signingKey, encryptionKey, timeoutMs, transport: transport.protection.transport, agreementTransport: transport.agreementTransport,
      dataTransport: transport.dataTransport, provisionTransport: transport.provisionTransport };
    if (ancestry && planning && first === 'available') ancestryHandle = ancestry.open({ localKey: encryptionKey, signingKey, members: config.members });
    const protection = { ...(ancestryHandle ? { ancestrySource: () => ancestryHandle!.blocks(), expectedAncestry: ancestry!.expectedAncestry } : {}), context: config.context, signingKey, members: config.members, transport: transport.protection.transport, timeoutMs,
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
    const reviewed = await recovery.reviewRestore(destination, signal); preparation = reviewed.preparation; cancelled();
    if (command === 'recovery-review') return { result: { ...preparation.review, continuation: reviewed.continuation } };
    restored = await openProtectedAdmissionIssuerLedger({ path: destination.path, expectedProfile: profile, privateKey, expectedAllocationAuthority: authority,
      protection: { ...protection, writerDirectory: destination.writerDirectory, initializeWriter: true, initializeArchive: true },
      restore: { preparation, approvedDigest: approved! } }); cancelled();
    return { result: { result: 'protected-issuer-history-restored', ...destination, status: restored.status(), readiness: 'unverified', startsService: false } };
  } catch (error) { throw transport ? transport.failure(error) : error; }
  finally { signal?.removeEventListener('abort', cancel); cancel(); preparation?.close?.(); encryptionKey?.fill(0); signingKey.secretKey.fill(0); } };
  try { return await (funding ? withStorageReservationAuthority(funding, operate) : operate()); } finally { funding?.close(); }
}
