/** Explicit operator workflow. Never opens a new observer or starts signing. */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, parseHistoryCheckpointContext,
  parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { HISTORY_AGREEMENT_MAX_VIEW } from '@resonance/core/history-agreement';
import { parseAdmissionPolicyObserverState, type AdmissionPolicyObserverState } from './admission-policy-observer-state.js';
import { assertPolicyObserverHistoryContext, decodePolicyObserverSnapshot, replayPolicyObserverHistory } from './policy-observer-history-replay.js';
import { fencePolicyObserverRecoverySource, readPolicyObserverRecoverySource, type PolicyObserverRecoverySource } from './protected-policy-observer.js';
import { preparePolicyObserverRestore } from './policy-observer-history-restore.js';
import { discoverHistoryContinuations } from './history-continuation-discovery.js';
import { createHistoryCheckpointRecovery, HISTORY_RECOVERY_FILENAME } from './history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator, HISTORY_AGREEMENT_COORDINATOR_FILENAME } from './history-agreement-coordinator.js';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from './history-ancestry-download.js';
import { createHistoryProvisionCoordinator, HISTORY_PROVISION_OWNER_FILENAME } from './history-provision-coordinator.js';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from './history-agreement-exchange.js';

export const POLICY_OBSERVER_RECOVERY_FILENAME = 'policy-observer-recovery.json';
interface Options {
  directory: string; encryptionKey: Uint8Array; signingKey: SigningKeyPair; context: AdmissionPolicyObservers;
  historyContext: HistoryCheckpointContext; genesis: HistoryEncryptedEnvelope; members: HistoryReplicaEndpoint[]; timeoutMs?: number;
  transport?: HistoryCheckpointTransport; agreementTransport?: HistoryAgreementTransport;
  dataTransport?: HistoryAgreementDataTransport; provisionTransport?: HistoryProvisionTransport;
}
const names = ['freeze', 'agreement', 'download', 'provision'] as const;
type Name = typeof names[number];
const filenames = { freeze: HISTORY_RECOVERY_FILENAME, agreement: HISTORY_AGREEMENT_COORDINATOR_FILENAME,
  download: HISTORY_DOWNLOAD_FILENAME, provision: HISTORY_PROVISION_OWNER_FILENAME };
interface Source { chain: HistoryContinuationRoot[]; nextGeneration: number; view: number }
interface State extends Source {
  version: 1; contextId: string; genesisId: string; minimum: AdmissionPolicyObserverState | null;
  localSource: PolicyObserverRecoverySource | null; registered: Name[]; creating: Name | null;
  preferred: HistorySuccessorProposal | null; selected: HistorySuccessorProposal | null;
  continuation: HistoryContinuationRoot | null; complete: boolean;
}
export interface PolicyObserverRecoveryReview {
  readonly kind: 'policy-observer-recovery-freeze'; readonly directory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly nextGeneration: number; readonly view: number;
  readonly localStateDigest: string | null; readonly approvalDigest: string;
}
const preparations = new WeakMap<PolicyObserverRecoveryReview, { source: Source; minimum: AdmissionPolicyObserverState | null;
  localSource: PolicyObserverRecoverySource | null; digest: string }>();
function empty(directory: string) {
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Policy recovery requires a new empty workspace');
}
/** Snapshot all mutable pins before the first asynchronous authentication. */
function capture(options: Options) {
  const context = parseAdmissionPolicyObservers(options.context), historyContext = parseHistoryCheckpointContext(options.historyContext);
  assertPolicyObserverHistoryContext(context, historyContext);
  const genesis = parseHistoryCheckpointEnvelope(options.genesis, historyContext);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Policy recovery needs independently retained genesis');
  const members = structuredClone(options.members), timeoutMs = options.timeoutMs ?? 3000;
  if (members.length !== 5 || new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('Invalid policy recovery members or deadline');
  const agreementMembers = members.map(member => {
    const endpoint = new URL(member.endpoint);
    if (!historyContext.members.includes(member.publicKey) || endpoint.pathname !== '/history-checkpoint' || endpoint.search || endpoint.hash) throw new Error('Policy recovery needs pinned standard history endpoints');
    endpoint.pathname = '/history-agreement'; return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Policy recovery requires a 32-byte key');
  const signer = copyAdmissionSigningKey(options.signingKey);
  if (Buffer.from(signer.publicKey).toString('base64url') !== historyContext.owner) { signer.secretKey.fill(0); throw new Error('Wrong policy recovery owner'); }
  const key = Uint8Array.from(options.encryptionKey);
  return { ...options, directory: resolve(options.directory), context, historyContext, genesis, members, timeoutMs, agreementMembers,
    signer, key, contextId: historyCheckpointContextId(historyContext), genesisId: historyCheckpointEnvelopeId(genesis) };
}
function sourceRoot(source: Source, p: ReturnType<typeof capture>) {
  if (!Array.isArray(source.chain) || source.chain.length >= 64 || !Number.isSafeInteger(source.view)
    || source.view < 1 || source.view > HISTORY_AGREEMENT_MAX_VIEW) throw new Error('Invalid policy recovery source');
  let rootId = p.genesisId, generation = 0;
  for (const raw of source.chain) {
    const root = parseHistoryContinuationRoot(raw, p.historyContext);
    if (root.proposal.rootId !== rootId || root.proposal.generation !== generation) throw new Error('Policy recovery ancestry is disconnected');
    rootId = historyContinuationRootId(root); generation = root.generation;
  }
  if (!Number.isSafeInteger(source.nextGeneration) || source.nextGeneration <= generation) throw new Error('Invalid policy recovery barrier');
  return { rootId, generation, nextGeneration: source.nextGeneration };
}
function digest(body: Omit<PolicyObserverRecoveryReview, 'approvalDigest'>, key: Uint8Array) {
  return historyDigest(`resonance:policy-observer-recovery:v1\n${JSON.stringify([body, historyDigest(key)])}`);
}
function localPins(source: PolicyObserverRecoverySource, p: ReturnType<typeof capture>, minimum: AdmissionPolicyObserverState) {
  if (!exactWitnessFields(source, ['directory', 'contextId', 'genesisId', 'rootId', 'generation', 'stateDigest'])
    || typeof source.directory !== 'string' || resolve(source.directory) !== source.directory
    || source.directory === p.directory || source.contextId !== p.contextId || source.genesisId !== p.genesisId
    || !isHistoryDigest(source.rootId) || !Number.isSafeInteger(source.generation) || source.generation < 0
    || source.stateDigest !== historyDigest(JSON.stringify(minimum))) throw new Error('Policy recovery local source differs from its reviewed pins');
}

/** Read-only discovery. An unavailable source must be explicit; never infer loss
 * from a missing path, failed decryption or unavailable local lock. */
export async function preparePolicyObserverRecovery(options: Options & {
  source: PolicyObserverRecoverySource | 'unavailable'; view?: number; signal?: AbortSignal;
}): Promise<PolicyObserverRecoveryReview> {
  const p = capture(options), localSource = options.source === 'unavailable' ? null : options.source;
  const view = options.view ?? 1, signal = options.signal;
  try {
    const minimum = localSource ? readPolicyObserverRecoverySource(localSource) : null;
    if (!localSource && options.source !== 'unavailable') throw new Error('Policy recovery requires an explicit local source or unavailable declaration');
    if (localSource) localPins(localSource, p, minimum!);
    empty(p.directory); await decodePolicyObserverSnapshot(p.genesis, p.historyContext, p.context, p.key);
    const observation = await discoverHistoryContinuations({ context: p.historyContext, genesisId: p.genesisId,
      signingKey: p.signer, members: p.members, transport: p.transport, timeoutMs: p.timeoutMs, signal });
    const barriers = new Set(observation.observedLeaf.receipts.flatMap(r => r.head.freeze ? [r.head.freeze.nextGeneration] : []));
    if (barriers.size > 1) throw new Error('Policy recovery barriers differ; preserve evidence');
    const source = { chain: observation.continuations, nextGeneration: [...barriers][0] ?? observation.observedLeaf.generation + 1, view };
    if (localSource && !(localSource.generation === 0 && localSource.rootId === p.genesisId)
      && !source.chain.some(root => root.generation === localSource.generation && historyContinuationRootId(root) === localSource.rootId)) {
      throw new Error('Local policy source is outside the observed activated ancestry');
    }
    const body = { kind: 'policy-observer-recovery-freeze' as const, directory: p.directory, contextId: p.contextId, genesisId: p.genesisId,
      ...sourceRoot(source, p), view, localStateDigest: localSource?.stateDigest ?? null };
    const approvalDigest = digest(body, p.key), review = Object.freeze({ ...body, approvalDigest });
    preparations.set(review, { source, minimum, localSource, digest: approvalDigest }); return review;
  } finally { p.key.fill(0); p.signer.secretKey.fill(0); }
}

export async function openPolicyObserverRecovery(options: Options & {
  initialize?: { review: PolicyObserverRecoveryReview; approvedDigest: string };
}) {
  const run = captureStorageReservationOperation(), p = capture(options), initialize = options.initialize && { ...options.initialize };
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined;
  function valid(raw: unknown): raw is State {
    if (!exactWitnessFields(raw, ['version', 'contextId', 'genesisId', 'chain', 'nextGeneration', 'view', 'minimum', 'localSource',
      'registered', 'creating', 'preferred', 'selected', 'continuation', 'complete']) || raw.version !== 1 || raw.contextId !== p.contextId
      || raw.genesisId !== p.genesisId || !Array.isArray(raw.registered) || new Set(raw.registered).size !== raw.registered.length
      || raw.registered.some(n => !names.includes(n as Name)) || raw.creating !== null && (!names.includes(raw.creating as Name) || raw.registered.includes(raw.creating))
      || typeof raw.complete !== 'boolean' || (raw.minimum === null) !== (raw.localSource === null)) return false;
    try {
      const slot = sourceRoot(raw as unknown as Source, p);
      if (raw.localSource) localPins(raw.localSource as PolicyObserverRecoverySource, p, raw.minimum as AdmissionPolicyObserverState);
      for (const candidate of [raw.preferred, raw.selected]) if (candidate !== null) {
        const proposal = parseHistorySuccessorProposal(candidate, p.historyContext);
        if (proposal.rootId !== slot.rootId || proposal.generation !== slot.generation || proposal.nextGeneration !== slot.nextGeneration) return false;
      }
      if (raw.preferred !== null && !raw.registered.includes('freeze') || raw.selected !== null && (raw.preferred === null || !raw.registered.includes('agreement'))
        || raw.registered.includes('agreement') && raw.preferred === null || raw.registered.includes('download') && raw.selected === null) return false;
      if (raw.continuation !== null) {
        const root = parseHistoryContinuationRoot(raw.continuation, p.historyContext);
        if (!raw.selected || !raw.registered.includes('download') || historySuccessorProposalId(root.proposal) !== historySuccessorProposalId(raw.selected as HistorySuccessorProposal)) return false;
      }
      return !(raw.registered.includes('provision') && raw.continuation === null) && (!raw.complete || raw.continuation !== null && raw.registered.includes('provision'));
    } catch { return false; }
  }
  try {
    await decodePolicyObserverSnapshot(p.genesis, p.historyContext, p.context, p.key);
    let initial: State | undefined;
    if (initialize) {
      const { review, approvedDigest } = initialize, record = preparations.get(review), { approvalDigest: _, ...body } = review;
      if (!record || approvedDigest !== record.digest || digest(body, p.key) !== approvedDigest || review.directory !== p.directory
        || review.contextId !== p.contextId || review.genesisId !== p.genesisId) throw new Error('Policy recovery requires matching reviewed approval');
      empty(p.directory);
      initial = { version: 1, contextId: p.contextId, genesisId: p.genesisId, ...structuredClone(record.source), minimum: structuredClone(record.minimum),
        localSource: record.localSource && { ...record.localSource }, registered: [], creating: null, preferred: null, selected: null, continuation: null, complete: false };
      if (!valid(initial)) throw new Error('Invalid initial policy recovery state');
      // The source keeps this fence if workspace publication subsequently fails.
      if (record.localSource) await fencePolicyObserverRecoverySource(record.localSource);
    }
    storage = run(() => openEncryptedLocalState<State>({ path: join(p.directory, POLICY_OBSERVER_RECOVERY_FILENAME), key: p.key,
      domain: 'resonance:policy-observer-recovery:v1', maxBytes: 8 * 1024 * 1024, initial: initial!, validate: valid,
      mode: initial ? 'create-new' : 'open-existing' }));
    if (storage.read().minimum) await parseAdmissionPolicyObserverState(storage.read().minimum, p.context);
    for (const name of storage.read().registered) if (!existsSync(join(p.directory, name, filenames[name]))) throw new Error('Registered policy recovery history is missing; preserve the workspace');
  } catch (error) { storage?.close(); p.key.fill(0); p.signer.secretKey.fill(0); throw error; }
  const journal = storage;
  type Components = { freeze: ReturnType<typeof createHistoryCheckpointRecovery>; agreement: ReturnType<typeof createHistoryAgreementCoordinator>;
    download: ReturnType<typeof createHistoryAncestryDownload>; provision: ReturnType<typeof createHistoryProvisionCoordinator> };
  const handles: Partial<Components> = {};
  let closed = false, active = false;
  const common = { context: p.historyContext, localKey: p.key, signingKey: p.signer, timeoutMs: p.timeoutMs };
  function live() { if (closed) throw new Error('Policy recovery is closed'); journal.read(); }
  function component<N extends Name>(name: N): Components[N] {
    live(); if (handles[name]) return handles[name]!;
    const state = journal.read(), slot = sourceRoot(state, p), registered = state.registered.includes(name);
    if (!registered) {
      if (state.creating && state.creating !== name) throw new Error('Finish the pending policy recovery artifact first');
      if (!state.creating) journal.write({ ...state, creating: name });
    }
    const directory = join(p.directory, name), initialize = !registered && !existsSync(join(directory, filenames[name]));
    if (initialize) empty(directory);
    let result: Components[Name];
    if (name === 'freeze') result = createHistoryCheckpointRecovery({ ...common, ...slot, directory, members: p.members, transport: p.transport, initialize });
    else if (name === 'agreement') {
      if (!state.preferred) throw new Error('Policy recovery has no frozen proposal');
      result = createHistoryAgreementCoordinator({ ...common, ...slot, directory, members: p.agreementMembers, transport: p.agreementTransport,
        ...(initialize ? { initialize: { proposal: state.preferred, view: state.view } } : {}),
        historyTransfer: { transport: p.dataTransport, retained: () => component('download').blocks() } });
      const agreement = result.read();
      if (agreement.view !== state.view || historySuccessorProposalId(agreement.preferred) !== historySuccessorProposalId(state.preferred)
        || state.selected && (!agreement.selected || historySuccessorProposalId(agreement.selected) !== historySuccessorProposalId(state.selected))
        || state.continuation && (!agreement.certificate || historyContinuationRootId(createHistoryContinuationRoot(agreement.selected!, agreement.certificate, p.historyContext)) !== historyContinuationRootId(state.continuation))) {
        result.close(); throw new Error('Retained policy recovery agreement differs');
      }
    } else if (name === 'download') {
      if (!state.selected) throw new Error('Policy recovery has no selected proposal');
      result = createHistoryAncestryDownload({ ...common, directory, members: p.members, proposal: state.selected, transport: p.transport, initialize });
    } else {
      if (!state.continuation) throw new Error('Policy recovery has no confirmed continuation');
      result = createHistoryProvisionCoordinator({ ...common, directory, members: p.agreementMembers, root: state.continuation, transport: p.provisionTransport, initialize });
      if (state.complete && result.read().receipts.length !== 4) { result.close(); throw new Error('Policy recovery provision evidence is incomplete'); }
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
  function replayOptions() { const state = journal.read(); return { context: p.context, historyContext: p.historyContext, genesisId: p.genesisId,
    encryptionKey: p.key, blocks: component('download').blocks(), ...(state.minimum ? { minimumState: state.minimum } : {}) }; }
  return {
    status,
    async advance(options: { maxBlocks?: number; signal?: AbortSignal } = {}) { return run(async () => {
      live(); if (active || options.signal?.aborted) throw new Error('Policy recovery active or cancelled');
      if (options.maxBlocks !== undefined && (!Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 || options.maxBlocks > 10001)) throw new Error('Invalid recovery download step size');
      active = true; options.signal?.addEventListener('abort', close, { once: true });
      try {
        reopen(); const state = journal.read();
        if (!state.preferred) {
          const evidence = await component('freeze').prepare(); live();
          journal.write({ ...journal.read(), preferred: createHistorySuccessorProposal(evidence, p.historyContext, p.signer, p.genesisId) });
        } else if (!state.selected) {
          const selected = await component('agreement').select(options.signal); live(); journal.write({ ...journal.read(), selected: selected.proposal });
        } else if (!state.continuation) {
          const download = component('download');
          if (!download.read().complete) { await download.run({ maxBlocks: options.maxBlocks ?? 128, signal: options.signal }); live(); }
          else {
            // Authenticate semantics and the retained local floor before confirming a child.
            await replayPolicyObserverHistory({ ...replayOptions(), proposal: state.selected, signal: options.signal }); live();
            const certificate = await component('agreement').run(options.signal); live();
            journal.write({ ...journal.read(), continuation: createHistoryContinuationRoot(state.selected, certificate, p.historyContext) });
          }
        } else if (!state.complete) {
          await component('provision').run(options.signal); live(); journal.write({ ...journal.read(), complete: true });
        }
        return status();
      } finally { options.signal?.removeEventListener('abort', close); release(); active = false; }
    }); },
    async reviewRestore(destination: string, signal?: AbortSignal) { return run(async () => {
      live(); if (active || !journal.read().complete) throw new Error('Policy recovery has not completed provisioning or is active'); active = true;
      try {
        reopen(); const continuation = journal.read().continuation!;
        const preparation = await preparePolicyObserverRestore({ ...replayOptions(), directory: destination, continuation, signal });
        live(); return { preparation, continuation: structuredClone(continuation) };
      } finally { release(); active = false; }
    }); },
    close,
  };
}
