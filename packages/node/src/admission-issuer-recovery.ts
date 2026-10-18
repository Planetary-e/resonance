/** Reviewed issuer recovery. Selected history is replayed before confirmation; readiness remains separate. */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, parseHistoryCheckpointContext,
  openHistoryCheckpoint, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { HISTORY_AGREEMENT_MAX_VIEW } from '@resonance/core/history-agreement';
import { DOMAIN, type State as IssuerState } from './admission-issuer-state.js';
import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis } from './protected-admission-issuer-state.js';
import { replayProtectedIssuerHistory } from './admission-issuer-history-replay.js';
import { fenceProtectedIssuerRecoverySource, readProtectedIssuerRecoverySource, type ProtectedIssuerRecoverySource } from './protected-admission-issuer-ledger.js';
import { prepareProtectedIssuerRestore } from './admission-issuer-history-restore.js';
import { openProtectedIssuerRestoreResumption } from './admission-issuer-restore-resumption.js';
import { openProtectedIssuerHistory } from '@resonance/relay/protected-issuer-history';
import { canonicalHistorySetupPath } from '../../relay/src/admission-history-setup.js';
import { discoverHistoryContinuations } from '../../relay/src/history-continuation-discovery.js';
import { createHistoryCheckpointRecovery, HISTORY_RECOVERY_FILENAME } from '../../relay/src/history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator, HISTORY_AGREEMENT_COORDINATOR_FILENAME } from '../../relay/src/history-agreement-coordinator.js';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from '../../relay/src/history-ancestry-download.js';
import { createHistoryProvisionCoordinator, HISTORY_PROVISION_OWNER_FILENAME } from '../../relay/src/history-provision-coordinator.js';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from '../../relay/src/history-agreement-exchange.js';

export const PROTECTED_ISSUER_RECOVERY_FILENAME = 'admission-issuer-recovery.json';
export interface ProtectedIssuerRecoveryOptions {
  directory: string; encryptionKey: Uint8Array; signingKey: SigningKeyPair; context: HistoryCheckpointContext; profile: AdmissionWalletProfileV1; authority: string;
  genesis: HistoryEncryptedEnvelope; members: HistoryReplicaEndpoint[]; timeoutMs?: number;
  maxReplayBlocks?: number; maxReplayBytes?: number; replayTimeoutMs?: number;
  transport?: HistoryCheckpointTransport; agreementTransport?: HistoryAgreementTransport;
  dataTransport?: HistoryAgreementDataTransport; provisionTransport?: HistoryProvisionTransport;
}
const names = ['freeze', 'agreement', 'download', 'provision'] as const;
type Name = typeof names[number];
const filenames = { freeze: HISTORY_RECOVERY_FILENAME, agreement: HISTORY_AGREEMENT_COORDINATOR_FILENAME,
  download: HISTORY_DOWNLOAD_FILENAME, provision: HISTORY_PROVISION_OWNER_FILENAME };
interface Source { chain: HistoryContinuationRoot[]; nextGeneration: number; view: number }
interface State extends Source {
  version: 1; contextId: string; genesisId: string; configuration: ReturnType<typeof configuration>; minimum: IssuerState[] | null;
  localSource: ProtectedIssuerRecoverySource | null; registered: Name[]; creating: Name | null;
  preferred: HistorySuccessorProposal | null; selected: HistorySuccessorProposal | null;
  continuation: HistoryContinuationRoot | null; complete: boolean;
}
export interface ProtectedIssuerRecoveryReview {
  readonly kind: 'protected-issuer-recovery-freeze'; readonly directory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly nextGeneration: number; readonly view: number;
  readonly localStateDigest: string | null; readonly localSource: ProtectedIssuerRecoverySource | null; readonly approvalDigest: string;
}
const preparations = new WeakMap<ProtectedIssuerRecoveryReview, { source: Source; minimum: IssuerState[] | null;
  localSource: ProtectedIssuerRecoverySource | null; digest: string }>();
function empty(directory: string) {
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Issuer recovery requires a new empty workspace');
}
/** Snapshot all mutable pins before the first asynchronous authentication. */
function capture(options: ProtectedIssuerRecoveryOptions) {
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), authority = options.authority, profile = structuredClone(options.profile);
  if (context.role !== 'admission-issuer' || context.authority !== authority) throw new Error('Issuer recovery requires its independently pinned role and authority');
  const genesis = parseHistoryCheckpointEnvelope(structuredClone(options.genesis), context);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Issuer recovery needs independently retained original genesis');
  const members = structuredClone(options.members), timeoutMs = options.timeoutMs ?? 3000;
  if (!Array.isArray(members)) throw new Error('Invalid issuer recovery members');
  for (const member of members) {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string' || typeof member.endpoint !== 'string') throw new Error('Invalid pinned issuer recovery member');
    assertSecureRelayTransportEndpoint(member.endpoint); member.endpoint = new URL(member.endpoint).href;
  }
  if (members.length !== 5 || new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('Invalid issuer recovery members or deadline');
  const agreementMembers = members.map(member => {
    const endpoint = new URL(member.endpoint);
    if (!context.members.includes(member.publicKey) || endpoint.pathname !== '/history-checkpoint' || endpoint.search || endpoint.hash) throw new Error('Issuer recovery needs pinned standard history endpoints');
    endpoint.pathname = '/history-agreement'; return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Issuer recovery requires a 32-byte key');
  const maxBlocks = options.maxReplayBlocks ?? 10001, maxBytes = options.maxReplayBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10001 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error('Invalid issuer recovery replay bounds');
  const replayTimeoutMs = options.replayTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(replayTimeoutMs) || replayTimeoutMs < 50 || replayTimeoutMs > 300000) throw new Error('Invalid issuer recovery replay deadline');
  const signer = copyAdmissionSigningKey(options.signingKey);
  if (Buffer.from(signer.publicKey).toString('base64url') !== context.owner) { signer.secretKey.fill(0); throw new Error('Wrong issuer recovery owner'); }
  const key = Uint8Array.from(options.encryptionKey);
  return { ...options, requestedDirectory: options.directory, directory: canonicalHistorySetupPath(options.directory), context, profile, authority, genesis, members, timeoutMs, maxBlocks, maxBytes, replayTimeoutMs, agreementMembers,
    signer, key, contextId: historyCheckpointContextId(context), genesisId: historyCheckpointEnvelopeId(genesis) };
}
async function authenticateGenesis(p: ReturnType<typeof capture>) {
  p.profile = (await parseAdmissionWalletProfile(p.profile)).profile;
  const plaintext = openHistoryCheckpoint(p.genesis, p.context, p.key);
  try {
    const image = await parseProtectedIssuerImage(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext)), { profile: p.profile, authority: p.authority });
    assertProtectedIssuerGenesis(image, p.context); return image;
  } finally { plaintext.fill(0); }
}
function configuration(p: ReturnType<typeof capture>) {
  return { profile: p.profile, authority: p.authority, members: p.members, timeoutMs: p.timeoutMs,
    maxReplayBlocks: p.maxBlocks, maxReplayBytes: p.maxBytes, replayTimeoutMs: p.replayTimeoutMs };
}
function sourceRoot(source: Source, p: ReturnType<typeof capture>) {
  if (!Array.isArray(source.chain) || source.chain.length >= 64 || !Number.isSafeInteger(source.view)
    || source.view < 1 || source.view > HISTORY_AGREEMENT_MAX_VIEW) throw new Error('Invalid issuer recovery source');
  let rootId = p.genesisId, generation = 0;
  for (const raw of source.chain) {
    const root = parseHistoryContinuationRoot(raw, p.context);
    if (root.proposal.rootId !== rootId || root.proposal.generation !== generation) throw new Error('Issuer recovery ancestry is disconnected');
    rootId = historyContinuationRootId(root); generation = root.generation;
  }
  if (!Number.isSafeInteger(source.nextGeneration) || source.nextGeneration <= generation) throw new Error('Invalid issuer recovery barrier');
  return { rootId, generation, nextGeneration: source.nextGeneration };
}
function digest(body: Omit<ProtectedIssuerRecoveryReview, 'approvalDigest'>, p: ReturnType<typeof capture>) {
  return historyDigest(`resonance:admission-issuer-recovery:v1\n${JSON.stringify([body, configuration(p), historyDigest(p.key)])}`);
}
function localPins(source: ProtectedIssuerRecoverySource, p: ReturnType<typeof capture>, minimum: IssuerState[]) {
  if (!exactWitnessFields(source, ['path', 'writerDirectory', 'contextId', 'genesisId', 'rootId', 'generation', 'stateDigest'])
    || typeof source.path !== 'string' || resolve(source.path) !== source.path || typeof source.writerDirectory !== 'string' || resolve(source.writerDirectory) !== source.writerDirectory
    || source.path === p.directory || source.writerDirectory === p.directory || source.contextId !== p.contextId || source.genesisId !== p.genesisId
    || !isHistoryDigest(source.rootId) || !Number.isSafeInteger(source.generation) || source.generation < 0
    || source.stateDigest !== historyDigest(JSON.stringify(minimum))) throw new Error('Issuer recovery local source differs from its reviewed pins');
}

/** Read-only discovery. An unavailable source must be explicit; never infer loss
 * from a missing path, failed decryption or unavailable local lock. */
export async function prepareProtectedIssuerRecovery(options: ProtectedIssuerRecoveryOptions & {
  source: ProtectedIssuerRecoverySource | 'unavailable'; view?: number; signal?: AbortSignal;
}): Promise<ProtectedIssuerRecoveryReview> {
  const p = capture(options), localSource = options.source === 'unavailable' ? null : options.source;
  const view = options.view ?? 1, signal = options.signal;
  try {
    const captured = localSource ? readProtectedIssuerRecoverySource(localSource) : null;
    const minimum = captured ? structuredClone(captured.minimumEvidence) : null;
    if (!localSource && options.source !== 'unavailable') throw new Error('Issuer recovery requires an explicit local source or unavailable declaration');
    if (localSource) {
      localPins(localSource, p, minimum!);
      if (historyCheckpointContextId(captured!.context) !== p.contextId || historyCheckpointEnvelopeId(captured!.genesis) !== p.genesisId
        || captured!.authority !== p.authority) throw new Error('Issuer recovery local source differs from independent history or authority pins');
    }
    empty(p.directory); await authenticateGenesis(p);
    if (captured && JSON.stringify(captured.profile) !== JSON.stringify(p.profile)) throw new Error('Issuer source profile differs from its independent pin');
    const observation = await discoverHistoryContinuations({ context: p.context, genesisId: p.genesisId,
      signingKey: p.signer, members: p.members, transport: p.transport, timeoutMs: p.timeoutMs, signal });
    const barriers = new Set(observation.observedLeaf.receipts.flatMap(r => r.head.freeze ? [r.head.freeze.nextGeneration] : []));
    if (barriers.size > 1) throw new Error('Issuer recovery barriers differ; preserve evidence');
    const source = { chain: observation.continuations, nextGeneration: [...barriers][0] ?? observation.observedLeaf.generation + 1, view };
    if (localSource && !(localSource.generation === 0 && localSource.rootId === p.genesisId)
      && !source.chain.some(root => root.generation === localSource.generation && historyContinuationRootId(root) === localSource.rootId)) {
      throw new Error('Local issuer source is outside the observed activated ancestry');
    }
    const body = { kind: 'protected-issuer-recovery-freeze' as const, directory: p.directory, contextId: p.contextId, genesisId: p.genesisId,
      ...sourceRoot(source, p), view, localStateDigest: localSource?.stateDigest ?? null, localSource: localSource ? Object.freeze(structuredClone(localSource)) : null };
    const approvalDigest = digest(body, p), review = Object.freeze({ ...body, approvalDigest });
    preparations.set(review, { source, minimum, localSource, digest: approvalDigest }); return review;
  } finally { p.key.fill(0); p.signer.secretKey.fill(0); }
}

export async function openProtectedIssuerRecovery(options: ProtectedIssuerRecoveryOptions & {
  initialize?: { review: ProtectedIssuerRecoveryReview; approvedDigest: string };
}) {
  const run = captureStorageReservationOperation(), p = capture(options), initialize = options.initialize && { ...options.initialize };
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined;
  function valid(raw: unknown): raw is State {
    if (!exactWitnessFields(raw, ['version', 'contextId', 'genesisId', 'configuration', 'chain', 'nextGeneration', 'view', 'minimum', 'localSource',
      'registered', 'creating', 'preferred', 'selected', 'continuation', 'complete']) || raw.version !== 1 || raw.contextId !== p.contextId
      || raw.genesisId !== p.genesisId || JSON.stringify(raw.configuration) !== JSON.stringify(configuration(p)) || !Array.isArray(raw.registered) || new Set(raw.registered).size !== raw.registered.length
      || raw.registered.some(n => !names.includes(n as Name)) || raw.creating !== null && (!names.includes(raw.creating as Name) || raw.registered.includes(raw.creating))
      || typeof raw.complete !== 'boolean' || (raw.minimum === null) !== (raw.localSource === null)
      || raw.minimum !== null && (!Array.isArray(raw.minimum) || raw.minimum.length < 1 || raw.minimum.length > 2)) return false;
    try {
      const slot = sourceRoot(raw as unknown as Source, p);
      if (raw.localSource) localPins(raw.localSource as ProtectedIssuerRecoverySource, p, raw.minimum as IssuerState[]);
      for (const candidate of [raw.preferred, raw.selected]) if (candidate !== null) {
        const proposal = parseHistorySuccessorProposal(candidate, p.context);
        if (proposal.rootId !== slot.rootId || proposal.generation !== slot.generation || proposal.nextGeneration !== slot.nextGeneration) return false;
      }
      if (raw.preferred !== null && !raw.registered.includes('freeze') || raw.selected !== null && (raw.preferred === null || !raw.registered.includes('agreement'))
        || raw.registered.includes('agreement') && raw.preferred === null || raw.registered.includes('download') && raw.selected === null) return false;
      if (raw.continuation !== null) {
        const root = parseHistoryContinuationRoot(raw.continuation, p.context);
        if (!raw.selected || !raw.registered.includes('download') || historySuccessorProposalId(root.proposal) !== historySuccessorProposalId(raw.selected as HistorySuccessorProposal)) return false;
      }
      return !(raw.registered.includes('provision') && raw.continuation === null) && (!raw.complete || raw.continuation !== null && raw.registered.includes('provision'));
    } catch { return false; }
  }
  try {
    await authenticateGenesis(p);
    let initial: State | undefined;
    if (initialize) {
      const { review, approvedDigest } = initialize, record = preparations.get(review), { approvalDigest: _, ...body } = review;
      if (!record || approvedDigest !== record.digest || digest(body, p) !== approvedDigest || review.directory !== p.directory
        || review.contextId !== p.contextId || review.genesisId !== p.genesisId) throw new Error('Issuer recovery requires matching reviewed approval');
      empty(p.directory);
      initial = { version: 1, contextId: p.contextId, genesisId: p.genesisId, configuration: configuration(p), ...structuredClone(record.source), minimum: structuredClone(record.minimum),
        localSource: record.localSource && structuredClone(record.localSource), registered: [], creating: null, preferred: null, selected: null, continuation: null, complete: false };
      if (!valid(initial)) throw new Error('Invalid initial issuer recovery state');
      // The source keeps this fence if workspace publication subsequently fails.
      if (record.localSource) await fenceProtectedIssuerRecoverySource(record.localSource);
    }
    if (canonicalHistorySetupPath(p.requestedDirectory) !== p.directory) throw new Error('Issuer recovery workspace changed since review');
    storage = run(() => openEncryptedLocalState<State>({ path: join(p.directory, PROTECTED_ISSUER_RECOVERY_FILENAME), key: p.key,
      domain: 'resonance:admission-issuer-recovery:v1', maxBytes: 48 * 1024 * 1024, initial: initial!, validate: valid,
      mode: initial ? 'create-new' : 'open-existing' }));
    for (const image of storage.read().minimum ?? []) await parseProtectedIssuerImage(image, { profile: p.profile, authority: p.authority });
    for (const name of storage.read().registered) if (!existsSync(join(p.directory, name, filenames[name]))) throw new Error('Registered issuer recovery history is missing; preserve the workspace');
  } catch (error) { storage?.close(); p.key.fill(0); p.signer.secretKey.fill(0); throw error; }
  const journal = storage;
  type Components = { freeze: ReturnType<typeof createHistoryCheckpointRecovery>; agreement: ReturnType<typeof createHistoryAgreementCoordinator>;
    download: ReturnType<typeof createHistoryAncestryDownload>; provision: ReturnType<typeof createHistoryProvisionCoordinator> };
  const handles: Partial<Components> = {};
  let closed = false, active = false;
  const common = { context: p.context, localKey: p.key, signingKey: p.signer, timeoutMs: p.timeoutMs };
  function live() { if (closed) throw new Error('Issuer recovery is closed'); journal.read(); }
  function component<N extends Name>(name: N): Components[N] {
    live(); if (handles[name]) return handles[name]!;
    const state = journal.read(), slot = sourceRoot(state, p), registered = state.registered.includes(name);
    if (!registered) {
      if (state.creating && state.creating !== name) throw new Error('Finish the pending issuer recovery artifact first');
      if (!state.creating) journal.write({ ...state, creating: name });
    }
    const directory = join(p.directory, name), initialize = !registered && !existsSync(join(directory, filenames[name]));
    if (initialize) empty(directory);
    let result: Components[Name];
    if (name === 'freeze') result = createHistoryCheckpointRecovery({ ...common, ...slot, directory, members: p.members, transport: p.transport, initialize });
    else if (name === 'agreement') {
      if (!state.preferred) throw new Error('Issuer recovery has no frozen proposal');
      result = createHistoryAgreementCoordinator({ ...common, ...slot, directory, members: p.agreementMembers, transport: p.agreementTransport,
        ...(initialize ? { initialize: { proposal: state.preferred, view: state.view } } : {}),
        historyTransfer: { transport: p.dataTransport, retained: () => component('download').blocks() } });
      const agreement = result.read();
      if (agreement.view !== state.view || historySuccessorProposalId(agreement.preferred) !== historySuccessorProposalId(state.preferred)
        || state.selected && (!agreement.selected || historySuccessorProposalId(agreement.selected) !== historySuccessorProposalId(state.selected))
        || state.continuation && (!agreement.certificate || historyContinuationRootId(createHistoryContinuationRoot(agreement.selected!, agreement.certificate, p.context)) !== historyContinuationRootId(state.continuation))) {
        result.close(); throw new Error('Retained issuer recovery agreement differs');
      }
    } else if (name === 'download') {
      if (!state.selected) throw new Error('Issuer recovery has no selected proposal');
      result = createHistoryAncestryDownload({ ...common, directory, members: p.members, proposal: state.selected, transport: p.transport, initialize });
    } else {
      if (!state.continuation) throw new Error('Issuer recovery has no confirmed continuation');
      result = createHistoryProvisionCoordinator({ ...common, directory, members: p.agreementMembers, root: state.continuation, transport: p.provisionTransport, initialize });
      if (state.complete && result.read().receipts.length !== 4) { result.close(); throw new Error('Issuer recovery provision evidence is incomplete'); }
    }
    try { if (!registered) journal.write({ ...journal.read(), registered: [...state.registered, name], creating: null }); }
    catch (error) { result.close(); throw error; }
    (handles as Record<Name, Components[Name]>)[name] = result; return result as Components[N];
  }
  function release() { for (const name of [...names].reverse()) { handles[name]?.close(); delete handles[name]; } }
  function close() { if (!closed) { closed = true; release(); journal.close(); p.key.fill(0); p.signer.secretKey.fill(0); } }
  function status() {
    live(); const state = journal.read();
    return { ...sourceRoot(state, p), view: state.view, complete: state.complete, localStateDigest: state.localSource?.stateDigest ?? null,
      phase: state.complete ? 'review' : state.continuation ? 'provision' : state.selected ? 'download-and-confirm' : state.preferred ? 'select' : 'freeze' };
  }
  function reopen() { for (const name of names) if (journal.read().registered.includes(name)) component(name); }
  function replayOptions() { const state = journal.read(); return { context: p.context, profile: p.profile, authority: p.authority, genesisId: p.genesisId,
    encryptionKey: p.key, maxBlocks: p.maxBlocks, maxBytes: p.maxBytes, timeoutMs: p.replayTimeoutMs, blocks: component('download').blocks(), ...(state.minimum ? { minimumEvidence: state.minimum } : {}) }; }
  return {
    status,
    async advance(options: { maxBlocks?: number; signal?: AbortSignal } = {}) { return run(async () => {
      live(); if (active || options.signal?.aborted) throw new Error('Issuer recovery active or cancelled');
      if (options.maxBlocks !== undefined && (!Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 || options.maxBlocks > 10001)) throw new Error('Invalid recovery download step size');
      active = true; options.signal?.addEventListener('abort', close, { once: true });
      try {
        reopen(); const state = journal.read();
        if (!state.preferred) {
          const evidence = await component('freeze').prepare(); live();
          journal.write({ ...journal.read(), preferred: createHistorySuccessorProposal(evidence, p.context, p.signer, p.genesisId) });
        } else if (!state.selected) {
          const selected = await component('agreement').select(options.signal); live(); journal.write({ ...journal.read(), selected: selected.proposal });
        } else if (!state.continuation) {
          const download = component('download');
          if (!download.read().complete) { await download.run({ maxBlocks: options.maxBlocks ?? 128, signal: options.signal }); live(); }
          else {
            // Authenticate semantics and the retained local floor before confirming a child.
            await replayProtectedIssuerHistory({ ...replayOptions(), proposal: state.selected, signal: options.signal }); live();
            const certificate = await component('agreement').run(options.signal); live();
            journal.write({ ...journal.read(), continuation: createHistoryContinuationRoot(state.selected, certificate, p.context) });
          }
        } else if (!state.complete) {
          await component('provision').run(options.signal); live(); journal.write({ ...journal.read(), complete: true });
        }
        return status();
      } finally { options.signal?.removeEventListener('abort', close); release(); active = false; }
    }); },
    async reviewRestore(destination: { path: string; writerDirectory: string }, signal?: AbortSignal) { return run(async () => {
      destination = { path: resolve(destination.path), writerDirectory: resolve(destination.writerDirectory) };
      live(); if (active || !journal.read().complete) throw new Error('Issuer recovery has not completed provisioning or is active'); active = true;
      try {
        reopen(); const continuation = journal.read().continuation!;
        const preparation = await prepareProtectedIssuerRestore({ ...replayOptions(), destination, continuation, signal });
        live(); return { preparation, continuation: structuredClone(continuation) };
      } finally { release(); active = false; }
    }); },
    /** Compare an occupied destination with independently replayed selected
     * ancestry. This cannot create a missing writer or transmit readiness. */
    async inspectRestored(destination: { path: string; writerDirectory: string }, signal?: AbortSignal) { return run(async () => {
      destination = { path: resolve(destination.path), writerDirectory: resolve(destination.writerDirectory) };
      live(); if (active || !journal.read().complete) throw new Error('Issuer recovery has not completed provisioning or is active'); active = true;
      let inspected: Awaited<ReturnType<typeof openProtectedIssuerHistory<IssuerState>>> | undefined;
      try {
        reopen(); const continuation = journal.read().continuation!;
        const replay = await replayProtectedIssuerHistory({ ...replayOptions(), proposal: continuation.proposal, signal }); live();
        inspected = await openProtectedIssuerHistory<IssuerState>({ ...destination, context: p.context, domain: DOMAIN, encryptionKey: p.key,
          signingKey: p.signer, members: p.members, initial: undefined!, expectedRestorationDigest: replay.replayDigest,
          validate: value => parseProtectedIssuerImage(value, { profile: p.profile, authority: p.authority }),
          assertTransition: assertProtectedIssuerImageSuccessor, validateGenesis: image => assertProtectedIssuerGenesis(image, p.context) });
        live(); if (signal?.aborted) throw new Error('Issuer restoration inspection cancelled');
        return { continuation: structuredClone(continuation), status: inspected.status(), readiness: 'unverified' as const };
      } finally { inspected?.close(); release(); active = false; }
    }); },
    async reviewResumption(destination: { path: string; writerDirectory: string }, options: { privateKey: CryptoKey; maxArchiveBytes?: number; maxArchiveBlocks?: number; signal?: AbortSignal }) { return run(async () => {
      destination = { path: resolve(destination.path), writerDirectory: resolve(destination.writerDirectory) };
      live(); if (active || !journal.read().complete) throw new Error('Issuer recovery has not completed provisioning or is active'); active = true;
      const privateKey = options.privateKey, limits = { maxArchiveBytes: options.maxArchiveBytes, maxArchiveBlocks: options.maxArchiveBlocks }, signal = options.signal;
      let resumption: Awaited<ReturnType<typeof openProtectedIssuerRestoreResumption>> | undefined;
      try {
        reopen(); const root = journal.read().continuation!;
        resumption = await openProtectedIssuerRestoreResumption({ ...replayOptions(), destination, continuation: root,
          signingKey: p.signer, members: p.members, transport: p.transport, timeoutMs: p.timeoutMs, replayTimeoutMs: p.replayTimeoutMs, privateKey, ...limits, signal });
        live(); return resumption;
      } catch (error) { resumption?.close(); throw error; }
      finally { release(); active = false; }
    }); },
    close,
  };
}
