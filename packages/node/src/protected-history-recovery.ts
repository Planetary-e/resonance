/** Internal phase journal and network protocol lifecycle. Only fixed role wrappers instantiate a strategy. */
import { assertExistingHistoryAncestryFunding, type captureHistoryAncestrySource, type OwnedHistoryAncestrySource } from '../../relay/src/history-ancestry-source.js';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, parseHistoryCheckpointContext,
  openHistoryCheckpoint, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { HISTORY_AGREEMENT_MAX_VIEW } from '@resonance/core/history-agreement';
import { canonicalHistorySetupPath } from '../../relay/src/admission-history-setup.js';
import { discoverHistoryContinuations } from '../../relay/src/history-continuation-discovery.js';
import { createHistoryCheckpointRecovery, HISTORY_RECOVERY_FILENAME } from '../../relay/src/history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator, HISTORY_AGREEMENT_COORDINATOR_FILENAME } from '../../relay/src/history-agreement-coordinator.js';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from '../../relay/src/history-ancestry-download.js';
import { createHistoryProvisionCoordinator, HISTORY_PROVISION_OWNER_FILENAME } from '../../relay/src/history-provision-coordinator.js';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from '../../relay/src/history-agreement-exchange.js';

export interface ProtectedHistoryRecoveryOptions {
  ancestryBinding?: string;
  ancestrySelection?: Pick<ReturnType<typeof captureHistoryAncestrySource>, 'assertRecoveryDownload'>;
  directory: string; encryptionKey: Uint8Array; signingKey: SigningKeyPair; context: HistoryCheckpointContext; authority: string;
  genesis: HistoryEncryptedEnvelope; members: HistoryReplicaEndpoint[]; timeoutMs?: number;
  maxReplayBlocks?: number; maxReplayBytes?: number; replayTimeoutMs?: number;
  transport?: HistoryCheckpointTransport; agreementTransport?: HistoryAgreementTransport;
  dataTransport?: HistoryAgreementDataTransport; provisionTransport?: HistoryProvisionTransport;
}
export interface ProtectedHistoryRecoverySource {
  readonly path: string; readonly writerDirectory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
export interface ProtectedHistoryRecoveryEvidence<S> {
  context: HistoryCheckpointContext; genesis: HistoryCheckpointEnvelope; authority: string; minimumEvidence: S[];
}
export type ProtectedHistoryRecoveryCaptured<O extends ProtectedHistoryRecoveryOptions, P extends object> = O & P & {
  requestedDirectory: string; directory: string; context: HistoryCheckpointContext; authority: string;
  genesis: HistoryEncryptedEnvelope; members: HistoryReplicaEndpoint[]; timeoutMs: number;
  maxBlocks: number; maxBytes: number; replayTimeoutMs: number; agreementMembers: HistoryReplicaEndpoint[];
  signer: SigningKeyPair; key: Uint8Array; contextId: string; genesisId: string;
};
export interface ProtectedHistoryRecoveryReview<C extends ProtectedHistoryRecoverySource, K extends string> {
  readonly kind: K; readonly directory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly nextGeneration: number; readonly view: number;
  readonly localStateDigest: string | null; readonly localSource: C | null; readonly approvalDigest: string;
}
export interface ProtectedHistoryRecoveryStrategy<O extends ProtectedHistoryRecoveryOptions, P extends object, S, C extends ProtectedHistoryRecoverySource, Preparation,
  InspectorStatus, ResumeOptions, Resumption extends { close(): void }, K extends string> {
  retainAncestry?: boolean;
  role: HistoryCheckpointContext['role']; filename: string; domain: string; kind: K; label: string;
  capturePins(options: O): P;
  normalizePins(p: ProtectedHistoryRecoveryCaptured<O, P>): Promise<void>;
  configuration(p: ProtectedHistoryRecoveryCaptured<O, P>): unknown;
  parseImage(value: unknown, p: ProtectedHistoryRecoveryCaptured<O, P>): Promise<S>;
  assertGenesis(image: S, p: ProtectedHistoryRecoveryCaptured<O, P>): void | Promise<void>;
  readSource(source: C): ProtectedHistoryRecoveryEvidence<S>;
  fenceSource(source: C): Promise<void>;
  assertAdditionalSourcePins?(captured: ProtectedHistoryRecoveryEvidence<S>, p: ProtectedHistoryRecoveryCaptured<O, P>): void;
  replay(p: ProtectedHistoryRecoveryCaptured<O, P>, blocks: Iterable<unknown>, minimum: S[] | null, proposal: HistorySuccessorProposal, signal?: AbortSignal): Promise<{ replayDigest: string }>;
  prepareRestore(p: ProtectedHistoryRecoveryCaptured<O, P>, blocks: Iterable<unknown>, minimum: S[] | null, destination: { path: string; writerDirectory: string }, continuation: HistoryContinuationRoot, signal?: AbortSignal, source?: OwnedHistoryAncestrySource): Promise<Preparation>;
  openInspector(p: ProtectedHistoryRecoveryCaptured<O, P>, destination: { path: string; writerDirectory: string }, replayDigest: string): Promise<{ status(): InspectorStatus; close(): void }>;
  openResumption(p: ProtectedHistoryRecoveryCaptured<O, P>, blocks: Iterable<unknown>, minimum: S[] | null, destination: { path: string; writerDirectory: string }, continuation: HistoryContinuationRoot, options: ResumeOptions, source?: OwnedHistoryAncestrySource): Promise<Resumption>;
}

export function createProtectedHistoryRecovery<O extends ProtectedHistoryRecoveryOptions, P extends object, S, C extends ProtectedHistoryRecoverySource,
  Preparation, InspectorStatus, ResumeOptions, Resumption extends { close(): void }, K extends string>(
  strategy: Readonly<ProtectedHistoryRecoveryStrategy<O, P, S, C, Preparation, InspectorStatus, ResumeOptions, Resumption, K>>) {
  // Each fixed wrapper owns a factory and a separate preparation capability map.
  type Review = ProtectedHistoryRecoveryReview<C, K>;
  type Captured = ProtectedHistoryRecoveryCaptured<O, P>;
  const error = (message: string) => new Error(message.replaceAll('Issuer', strategy.label).replaceAll('issuer', strategy.label.toLowerCase()));
const names = ['freeze', 'agreement', 'download', 'provision'] as const;
type Name = typeof names[number];
const filenames = { freeze: HISTORY_RECOVERY_FILENAME, agreement: HISTORY_AGREEMENT_COORDINATOR_FILENAME,
  download: HISTORY_DOWNLOAD_FILENAME, provision: HISTORY_PROVISION_OWNER_FILENAME };
interface Source { chain: HistoryContinuationRoot[]; nextGeneration: number; view: number }
interface State extends Source {
  version: 1; contextId: string; genesisId: string; configuration: unknown; minimum: S[] | null;
  localSource: C | null; registered: Name[]; creating: Name | null;
  preferred: HistorySuccessorProposal | null; selected: HistorySuccessorProposal | null;
  continuation: HistoryContinuationRoot | null; complete: boolean;
}
const preparations = new WeakMap<Review, { source: Source; minimum: S[] | null;
  localSource: C | null; digest: string }>();
function empty(directory: string) {
  if (existsSync(directory) && readdirSync(directory).length) throw error('Issuer recovery requires a new empty workspace');
}
/** Snapshot all mutable pins before the first asynchronous authentication. */
function capture(options: O): Captured {
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), authority = options.authority, pins = strategy.capturePins(options);
  if (context.role !== strategy.role || context.authority !== authority) throw error('Issuer recovery requires its independently pinned role and authority');
  const genesis = parseHistoryCheckpointEnvelope(structuredClone(options.genesis), context);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw error('Issuer recovery needs independently retained original genesis');
  const members = structuredClone(options.members), timeoutMs = options.timeoutMs ?? 3000;
  if (!Array.isArray(members)) throw error('Invalid issuer recovery members');
  for (const member of members) {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string' || typeof member.endpoint !== 'string') throw error('Invalid pinned issuer recovery member');
    assertSecureRelayTransportEndpoint(member.endpoint); member.endpoint = new URL(member.endpoint).href;
  }
  if (members.length !== 5 || new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw error('Invalid issuer recovery members or deadline');
  const agreementMembers = members.map(member => {
    const endpoint = new URL(member.endpoint);
    if (!context.members.includes(member.publicKey) || endpoint.pathname !== '/history-checkpoint' || endpoint.search || endpoint.hash) throw error('Issuer recovery needs pinned standard history endpoints');
    endpoint.pathname = '/history-agreement'; return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw error('Issuer recovery requires a 32-byte key');
  const maxBlocks = options.maxReplayBlocks ?? 10001, maxBytes = options.maxReplayBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10001 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw error('Invalid issuer recovery replay bounds');
  const replayTimeoutMs = options.replayTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(replayTimeoutMs) || replayTimeoutMs < 50 || replayTimeoutMs > 300000) throw error('Invalid issuer recovery replay deadline');
  const signer = copyAdmissionSigningKey(options.signingKey);
  if (Buffer.from(signer.publicKey).toString('base64url') !== context.owner) { signer.secretKey.fill(0); throw error('Wrong issuer recovery owner'); }
  const key = Uint8Array.from(options.encryptionKey);
  return { ...options, ...pins, requestedDirectory: options.directory, directory: canonicalHistorySetupPath(options.directory), context, authority, genesis, members, timeoutMs, maxBlocks, maxBytes, replayTimeoutMs, agreementMembers,
    signer, key, contextId: historyCheckpointContextId(context), genesisId: historyCheckpointEnvelopeId(genesis) };
}
async function authenticateGenesis(p: Captured) {
  await strategy.normalizePins(p);
  const plaintext = openHistoryCheckpoint(p.genesis, p.context, p.key);
  try {
    const image = await strategy.parseImage(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext)), p);
    await strategy.assertGenesis(image, p); return image;
  } finally { plaintext.fill(0); }
}
function configuration(p: Captured) { return strategy.configuration(p); }

function sourceRoot(source: Source, p: Captured) {
  if (!Array.isArray(source.chain) || source.chain.length >= 64 || !Number.isSafeInteger(source.view)
    || source.view < 1 || source.view > HISTORY_AGREEMENT_MAX_VIEW) throw error('Invalid issuer recovery source');
  let rootId = p.genesisId, generation = 0;
  for (const raw of source.chain) {
    const root = parseHistoryContinuationRoot(raw, p.context);
    if (root.proposal.rootId !== rootId || root.proposal.generation !== generation) throw error('Issuer recovery ancestry is disconnected');
    rootId = historyContinuationRootId(root); generation = root.generation;
  }
  if (!Number.isSafeInteger(source.nextGeneration) || source.nextGeneration <= generation) throw error('Invalid issuer recovery barrier');
  return { rootId, generation, nextGeneration: source.nextGeneration };
}
function digest(body: Omit<Review, 'approvalDigest'>, p: Captured) {
  return historyDigest(`${strategy.domain}\n${JSON.stringify([body, configuration(p), historyDigest(p.key)])}`);
}
function localPins(source: C, p: Captured, minimum: S[]) {
  if (!exactWitnessFields(source, ['path', 'writerDirectory', 'contextId', 'genesisId', 'rootId', 'generation', 'stateDigest'])
    || typeof source.path !== 'string' || resolve(source.path) !== source.path || typeof source.writerDirectory !== 'string' || resolve(source.writerDirectory) !== source.writerDirectory
    || source.path === p.directory || source.writerDirectory === p.directory || source.contextId !== p.contextId || source.genesisId !== p.genesisId
    || !isHistoryDigest(source.rootId) || !Number.isSafeInteger(source.generation) || source.generation < 0
    || source.stateDigest !== historyDigest(JSON.stringify(minimum))) throw error('Issuer recovery local source differs from its reviewed pins');
}

/** Read-only discovery. An unavailable source must be explicit; never infer loss
 * from a missing path, failed decryption or unavailable local lock. */
async function prepare(options: O & {
  source: C | 'unavailable'; view?: number; signal?: AbortSignal;
}): Promise<Review> {
  const p = capture(options), localSource = options.source === 'unavailable' ? null : options.source;
  const view = options.view ?? 1, signal = options.signal;
  try {
    const captured = localSource ? strategy.readSource(localSource) : null;
    const minimum = captured ? structuredClone(captured.minimumEvidence) : null;
    if (!localSource && options.source !== 'unavailable') throw error('Issuer recovery requires an explicit local source or unavailable declaration');
    if (localSource) {
      localPins(localSource, p, minimum!);
      if (historyCheckpointContextId(captured!.context) !== p.contextId || historyCheckpointEnvelopeId(captured!.genesis) !== p.genesisId
        || captured!.authority !== p.authority) throw error('Issuer recovery local source differs from independent history or authority pins');
    }
    empty(p.directory); await authenticateGenesis(p);
    if (captured) strategy.assertAdditionalSourcePins?.(captured, p);
    const observation = await discoverHistoryContinuations({ context: p.context, genesisId: p.genesisId,
      signingKey: p.signer, members: p.members, transport: p.transport, timeoutMs: p.timeoutMs, signal });
    const barriers = new Set(observation.observedLeaf.receipts.flatMap(r => r.head.freeze ? [r.head.freeze.nextGeneration] : []));
    if (barriers.size > 1) throw error('Issuer recovery barriers differ; preserve evidence');
    const source = { chain: observation.continuations, nextGeneration: [...barriers][0] ?? observation.observedLeaf.generation + 1, view };
    if (localSource && !(localSource.generation === 0 && localSource.rootId === p.genesisId)
      && !source.chain.some(root => root.generation === localSource.generation && historyContinuationRootId(root) === localSource.rootId)) {
      throw error('Local issuer source is outside the observed activated ancestry');
    }
    const body = { kind: strategy.kind, directory: p.directory, contextId: p.contextId, genesisId: p.genesisId,
      ...sourceRoot(source, p), view, localStateDigest: localSource?.stateDigest ?? null, localSource: localSource ? Object.freeze(structuredClone(localSource)) : null };
    const approvalDigest = digest(body, p), review = Object.freeze({ ...body, approvalDigest });
    preparations.set(review, { source, minimum, localSource, digest: approvalDigest }); return review;
  } finally { p.key.fill(0); p.signer.secretKey.fill(0); }
}

async function open(options: O & {
  initialize?: { review: Review; approvedDigest: string };
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
      if (raw.localSource) localPins(raw.localSource as C, p, raw.minimum as S[]);
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
        || review.contextId !== p.contextId || review.genesisId !== p.genesisId) throw error('Issuer recovery requires matching reviewed approval');
      empty(p.directory);
      initial = { version: 1, contextId: p.contextId, genesisId: p.genesisId, configuration: configuration(p), ...structuredClone(record.source), minimum: structuredClone(record.minimum),
        localSource: record.localSource && structuredClone(record.localSource), registered: [], creating: null, preferred: null, selected: null, continuation: null, complete: false };
      if (!valid(initial)) throw error('Invalid initial issuer recovery state');
      // The source keeps this fence if workspace publication subsequently fails.
      if (record.localSource) await strategy.fenceSource(record.localSource);
    }
    if (canonicalHistorySetupPath(p.requestedDirectory) !== p.directory) throw error('Issuer recovery workspace changed since review');
    const downloadDirectory = join(p.directory, 'download');
    p.ancestrySelection?.assertRecoveryDownload({ directory: join(p.requestedDirectory, 'download'), genesisId: p.genesisId });
    if (strategy.retainAncestry && existsSync(join(downloadDirectory, HISTORY_DOWNLOAD_FILENAME))) run(() => assertExistingHistoryAncestryFunding(downloadDirectory, undefined, { allowUnmanaged: true }));
    storage = run(() => openEncryptedLocalState<State>({ path: join(p.directory, strategy.filename), key: p.key,
      domain: strategy.domain, maxBytes: 48 * 1024 * 1024, initial: initial!, validate: valid,
      mode: initial ? 'create-new' : 'open-existing' }));
    for (const image of storage.read().minimum ?? []) await strategy.parseImage(image, p);
    for (const name of storage.read().registered) if (!existsSync(join(p.directory, name, filenames[name]))) throw error('Registered issuer recovery history is missing; preserve the workspace');
  } catch (error) { storage?.close(); p.key.fill(0); p.signer.secretKey.fill(0); throw error; }
  const journal = storage;
  type Components = { freeze: ReturnType<typeof createHistoryCheckpointRecovery>; agreement: ReturnType<typeof createHistoryAgreementCoordinator>;
    download: ReturnType<typeof createHistoryAncestryDownload>; provision: ReturnType<typeof createHistoryProvisionCoordinator> };
  const handles: Partial<Components> = {};
  let closed = false, active = false;
  const common = { context: p.context, localKey: p.key, signingKey: p.signer, timeoutMs: p.timeoutMs };
  function live() { if (closed) throw error('Issuer recovery is closed'); journal.read(); }
  function component<N extends Name>(name: N): Components[N] {
    live(); if (handles[name]) return handles[name]!;
    const state = journal.read(), slot = sourceRoot(state, p), registered = state.registered.includes(name);
    if (name === 'download' && registered && strategy.retainAncestry) {
      checkRecoverySelection();
      assertExistingHistoryAncestryFunding(join(p.directory, 'download'), undefined, { allowUnmanaged: true });
    }
    if (!registered) {
      if (state.creating && state.creating !== name) throw error('Finish the pending issuer recovery artifact first');
      if (!state.creating) journal.write({ ...state, creating: name });
    }
    const directory = join(p.directory, name), initialize = !registered && !existsSync(join(directory, filenames[name]));
    if (initialize) empty(directory);
    let result: Components[Name];
    if (name === 'freeze') result = createHistoryCheckpointRecovery({ ...common, ...slot, directory, members: p.members, transport: p.transport, initialize });
    else if (name === 'agreement') {
      if (!state.preferred) throw error('Issuer recovery has no frozen proposal');
      result = createHistoryAgreementCoordinator({ ...common, ...slot, directory, members: p.agreementMembers, transport: p.agreementTransport,
        ...(initialize ? { initialize: { proposal: state.preferred, view: state.view } } : {}),
        historyTransfer: { transport: p.dataTransport, retained: () => component('download').blocks() } });
      const agreement = result.read();
      if (agreement.view !== state.view || historySuccessorProposalId(agreement.preferred) !== historySuccessorProposalId(state.preferred)
        || state.selected && (!agreement.selected || historySuccessorProposalId(agreement.selected) !== historySuccessorProposalId(state.selected))
        || state.continuation && (!agreement.certificate || historyContinuationRootId(createHistoryContinuationRoot(agreement.selected!, agreement.certificate, p.context)) !== historyContinuationRootId(state.continuation))) {
        result.close(); throw error('Retained issuer recovery agreement differs');
      }
    } else if (name === 'download') {
      if (!state.selected) throw error('Issuer recovery has no selected proposal');
      result = createHistoryAncestryDownload({ ...common, directory, members: p.members, proposal: state.selected, transport: p.transport, initialize });
    } else {
      if (!state.continuation) throw error('Issuer recovery has no confirmed continuation');
      result = createHistoryProvisionCoordinator({ ...common, directory, members: p.agreementMembers, root: state.continuation, transport: p.provisionTransport, initialize });
      if (state.complete && result.read().receipts.length !== 4) { result.close(); throw error('Issuer recovery provision evidence is incomplete'); }
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
      ...(state.complete ? { continuation: structuredClone(state.continuation!) } : {}), phase: state.complete ? 'review' : state.continuation ? 'provision' : state.selected ? 'download-and-confirm' : state.preferred ? 'select' : 'freeze' };
  }
  function reopen() { for (const name of names) if (journal.read().registered.includes(name)) component(name); }
  function checkRecoverySelection() {
    if (canonicalHistorySetupPath(p.requestedDirectory) !== p.directory) throw error('Issuer recovery workspace changed since review');
    p.ancestrySelection?.assertRecoveryDownload({ directory: join(p.requestedDirectory, 'download'), genesisId: p.genesisId,
      ...(journal.read().continuation ? { continuation: journal.read().continuation! } : {}) });
  }
  function retainedSource(): OwnedHistoryAncestrySource | undefined {
    if (!strategy.retainAncestry) return undefined;
    const download = component('download'), continuation = structuredClone(journal.read().continuation!);
    const selection = p.ancestrySelection, requestedDirectory = p.requestedDirectory, directory = p.directory, genesisId = p.genesisId;
    const check = () => { if (canonicalHistorySetupPath(requestedDirectory) !== directory) throw error('Issuer recovery workspace changed since review'); selection?.assertRecoveryDownload({ directory: join(requestedDirectory, 'download'), genesisId, continuation }); };
    return { binding: historyDigest(JSON.stringify([p.directory, p.genesisId, historyCheckpointEnvelopeId(journal.read().continuation!), p.ancestryBinding ?? null])), blocks: () => { check(); return download.blocks(); }, close: () => download.close() };
  }
  function replayInput() { return { blocks: component('download').blocks(), minimum: journal.read().minimum }; }

  return {
    status,
    async advance(options: { maxBlocks?: number; signal?: AbortSignal } = {}) { return run(async () => {
      live(); if (active || options.signal?.aborted) throw error('Issuer recovery active or cancelled');
      if (options.maxBlocks !== undefined && (!Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 || options.maxBlocks > 10001)) throw error('Invalid recovery download step size');
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
            await strategy.replay(p, replayInput().blocks, replayInput().minimum, state.selected, options.signal); live();
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
      live(); if (active || !journal.read().complete) throw error('Issuer recovery has not completed provisioning or is active'); active = true;
      let source: OwnedHistoryAncestrySource | undefined;
      try {
        checkRecoverySelection();
        reopen(); const continuation = journal.read().continuation!, minimum = journal.read().minimum;
        source = retainedSource();
        const preparation = await strategy.prepareRestore(p, source ? source.blocks() : replayInput().blocks, minimum, destination, continuation, signal, source);
        live(); if (source) delete handles.download; source = undefined; return { preparation, continuation: structuredClone(continuation) };
      } catch (error) { source?.close(); throw error; } finally { release(); active = false; }
    }); },
    /** Compare an occupied destination with independently replayed selected
     * ancestry. This cannot create a missing writer or transmit readiness. */
    async inspectRestored(destination: { path: string; writerDirectory: string }, signal?: AbortSignal) { return run(async () => {
      destination = { path: resolve(destination.path), writerDirectory: resolve(destination.writerDirectory) };
      live(); if (active || !journal.read().complete) throw error('Issuer recovery has not completed provisioning or is active'); active = true;
      let inspected: { status(): InspectorStatus; close(): void } | undefined;
      try {
        reopen(); const continuation = journal.read().continuation!;
        const replay = await strategy.replay(p, replayInput().blocks, replayInput().minimum, continuation.proposal, signal); live();
        inspected = await strategy.openInspector(p, destination, replay.replayDigest);
        live(); if (signal?.aborted) throw error('Issuer restoration inspection cancelled');
        return { continuation: structuredClone(continuation), status: inspected.status(), readiness: 'unverified' as const };
      } finally { inspected?.close(); release(); active = false; }
    }); },
    async reviewResumption(destination: { path: string; writerDirectory: string }, options: ResumeOptions) { return run(async () => {
      destination = { path: resolve(destination.path), writerDirectory: resolve(destination.writerDirectory) };
      live(); if (active || !journal.read().complete) throw error('Issuer recovery has not completed provisioning or is active'); active = true;
      let resumption: Resumption | undefined, source: OwnedHistoryAncestrySource | undefined;
      try {
        checkRecoverySelection();
        reopen(); const root = journal.read().continuation!;
        const minimum = journal.read().minimum; source = retainedSource();
        resumption = await strategy.openResumption(p, source ? source.blocks() : replayInput().blocks, minimum, destination, root, options, source);
        live(); if (source) delete handles.download; source = undefined; return resumption;
      } catch (error) { resumption?.close(); source?.close(); throw error; }
      finally { release(); active = false; }
    }); },
    close,
  };
}

return { prepare, open };
}
