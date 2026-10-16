/** Explicit, resumable composition of existing freeze/agreement/download/provision gates. */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionPolicyDigest } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, openHistoryCheckpoint,
  parseHistoryCheckpointEnvelope, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal, historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { HISTORY_AGREEMENT_MAX_VIEW } from '@resonance/core/history-agreement';
import { discoverHistoryContinuations } from './history-continuation-discovery.js';
import { parseAdmissionHistoryImage } from './admission-history-records.js';
import { prepareAdmissionHistoryRestore } from './admission-history-restore.js';
import { createHistoryCheckpointRecovery, HISTORY_RECOVERY_FILENAME } from './history-checkpoint-recovery.js';
import { createHistoryAgreementCoordinator, HISTORY_AGREEMENT_COORDINATOR_FILENAME } from './history-agreement-coordinator.js';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from './history-ancestry-download.js';
import { createHistoryProvisionCoordinator, HISTORY_PROVISION_OWNER_FILENAME } from './history-provision-coordinator.js';
import type { AdmissionHistoryProtection } from './protected-admission-history.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from './history-agreement-exchange.js';

export const ADMISSION_RECOVERY_FILENAME = 'admission-recovery.json';
interface Options {
  directory: string; encryptionKey: Uint8Array; genesis: HistoryEncryptedEnvelope; protection: AdmissionHistoryProtection;
  agreementTransport?: HistoryAgreementTransport; dataTransport?: HistoryAgreementDataTransport; provisionTransport?: HistoryProvisionTransport;
}
const names = ['freeze', 'agreement', 'download', 'provision'] as const;
type Name = typeof names[number];
const filenames = { freeze: HISTORY_RECOVERY_FILENAME, agreement: HISTORY_AGREEMENT_COORDINATOR_FILENAME,
  download: HISTORY_DOWNLOAD_FILENAME, provision: HISTORY_PROVISION_OWNER_FILENAME };
interface Source { chain: HistoryContinuationRoot[]; nextGeneration: number; view: number }
interface State extends Source {
  version: 1; contextId: string; genesisId: string; registered: Name[]; creating: Name | null;
  preferred: HistorySuccessorProposal | null; selected: HistorySuccessorProposal | null;
  continuation: HistoryContinuationRoot | null; complete: boolean;
}
export interface AdmissionRecoveryReview {
  kind: 'admission-recovery-freeze'; directory: string; contextId: string; genesisId: string;
  rootId: string; generation: number; nextGeneration: number; view: number; approvalDigest: string;
}
const prepared = new WeakMap<AdmissionRecoveryReview, { source: Source; digest: string }>();
function empty(directory: string) {
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Recovery preparation requires a new empty directory');
}
async function pins(options: Options) {
  const p = options.protection, genesis = parseHistoryCheckpointEnvelope(options.genesis, p.context);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Recovery requires the independently retained genesis');
  const plaintext = openHistoryCheckpoint(genesis, p.context, options.encryptionKey);
  try {
    let decoded: unknown;
    try { decoded = JSON.parse(plaintext.toString()); } catch { throw new Error('Invalid encrypted admission genesis'); }
    const image = await parseAdmissionHistoryImage(decoded, p.context.authority);
    if (`sha256:${admissionPolicyDigest(image.policy)}` !== p.context.policyDigest) throw new Error('Recovery genesis policy does not match its context');
  } finally { plaintext.fill(0); }
  const members = p.members.map(m => {
    const endpoint = new URL(m.endpoint);
    if (endpoint.pathname !== '/history-checkpoint' || endpoint.search || endpoint.hash) throw new Error('Recovery needs standard pinned history endpoints');
    endpoint.pathname = '/history-agreement'; return { publicKey: m.publicKey, endpoint: endpoint.href };
  });
  return { contextId: historyCheckpointContextId(p.context), genesisId: historyCheckpointEnvelopeId(genesis), agreementMembers: members };
}
function sourceRoot(source: Source, genesisId: string, protection: AdmissionHistoryProtection) {
  // Reserve room for the new child before authorizing an irreversible freeze.
  if (!Array.isArray(source.chain) || source.chain.length >= 64 || !Number.isSafeInteger(source.view)
    || source.view < 1 || source.view > HISTORY_AGREEMENT_MAX_VIEW) throw new Error('Invalid recovery source');
  let rootId = genesisId, generation = 0;
  for (const raw of source.chain) {
    const root = parseHistoryContinuationRoot(raw, protection.context);
    if (root.proposal.rootId !== rootId || root.proposal.generation !== generation) throw new Error('Recovery source is not connected to genesis');
    rootId = historyContinuationRootId(root); generation = root.generation;
  }
  if (!Number.isSafeInteger(source.nextGeneration) || source.nextGeneration <= generation) throw new Error('Invalid recovery generation barrier');
  return { rootId, generation, nextGeneration: source.nextGeneration };
}
function digest(review: Omit<AdmissionRecoveryReview, 'approvalDigest'>, key: Uint8Array) {
  return historyDigest(`resonance:admission-recovery-freeze:v1\n${JSON.stringify([review, historyDigest(key)])}`);
}

/** No history mutation. Approval authorizes the later irreversible freeze, not restoration. */
export async function prepareAdmissionHistoryRecovery(options: Options & { view?: number; signal?: AbortSignal }): Promise<AdmissionRecoveryReview> {
  const pinned = await pins(options), directory = resolve(options.directory); empty(directory);
  const observation = await discoverHistoryContinuations({ ...options.protection, genesisId: pinned.genesisId, signal: options.signal });
  const barriers = new Set(observation.observedLeaf.receipts.flatMap(r => r.head.freeze ? [r.head.freeze.nextGeneration] : []));
  if (barriers.size > 1) throw new Error('Observed recovery barriers differ; preserve evidence and inspect before proceeding');
  const source: Source = { chain: observation.continuations, nextGeneration: [...barriers][0] ?? observation.observedLeaf.generation + 1,
    view: options.view ?? 1 };
  const root = sourceRoot(source, pinned.genesisId, options.protection);
  const review = { kind: 'admission-recovery-freeze' as const, directory, contextId: pinned.contextId, genesisId: pinned.genesisId,
    ...root, view: source.view };
  const approvalDigest = digest(review, options.encryptionKey), result = Object.freeze({ ...review, approvalDigest });
  prepared.set(result, { source: structuredClone(source), digest: approvalDigest }); return result;
}

export async function openAdmissionHistoryRecovery(options: Options & {
  initialize?: { review: AdmissionRecoveryReview; approvedDigest: string };
}) {
  const pinned = await pins(options), directory = resolve(options.directory), p = options.protection;
  const key = Buffer.from(options.encryptionKey), signer = copyAdmissionSigningKey(p.signingKey);
  const contextId = pinned.contextId, genesisId = pinned.genesisId;
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  function valid(raw: unknown): raw is State {
    if (!exactWitnessFields(raw, ['version', 'contextId', 'genesisId', 'chain', 'nextGeneration', 'view', 'registered', 'creating',
      'preferred', 'selected', 'continuation', 'complete']) || raw.version !== 1 || raw.contextId !== contextId || raw.genesisId !== genesisId
      || !Array.isArray(raw.registered) || new Set(raw.registered).size !== raw.registered.length
      || raw.registered.some(n => !names.includes(n as Name)) || (raw.creating !== null && (!names.includes(raw.creating as Name)
        || raw.registered.includes(raw.creating))) || typeof raw.complete !== 'boolean') return false;
    try {
      const source = sourceRoot(raw as unknown as Source, genesisId, p);
      for (const candidate of [raw.preferred, raw.selected]) if (candidate !== null) {
        const proposal = parseHistorySuccessorProposal(candidate, p.context);
        if (proposal.rootId !== source.rootId || proposal.generation !== source.generation || proposal.nextGeneration !== source.nextGeneration) return false;
      }
      if (raw.preferred !== null && !raw.registered.includes('freeze')) return false;
      if (raw.selected !== null && (raw.preferred === null || !raw.registered.includes('agreement'))) return false;
      if (raw.registered.includes('agreement') && raw.preferred === null) return false;
      if (raw.registered.includes('download') && raw.selected === null) return false;
      if (raw.continuation !== null) {
        const root = parseHistoryContinuationRoot(raw.continuation, p.context);
        if (raw.selected === null || !raw.registered.includes('download')
          || historySuccessorProposalId(root.proposal) !== historySuccessorProposalId(raw.selected as HistorySuccessorProposal)) return false;
      }
      if (raw.registered.includes('provision') && raw.continuation === null) return false;
      return !raw.complete || (raw.continuation !== null && raw.registered.includes('provision'));
    } catch { return false; }
  }
  try {
    if (Buffer.from(signer.publicKey).toString('base64url') !== p.context.owner) throw new Error('Wrong recovery owner');
    let initial: State | undefined;
    if (options.initialize) {
      const { review, approvedDigest } = options.initialize, record = prepared.get(review);
      const { approvalDigest: _, ...body } = review;
      if (!record || approvedDigest !== record.digest || approvedDigest !== digest(body, key)
        || review.directory !== directory || review.contextId !== contextId || review.genesisId !== genesisId) throw new Error('Recovery freeze needs matching reviewed approval');
      empty(directory);
      initial = { version: 1, contextId, genesisId, ...record.source, registered: [], creating: null,
        preferred: null, selected: null, continuation: null, complete: false };
      if (!valid(initial)) throw new Error('Invalid initial recovery state');
    }
    storage = openEncryptedLocalState({ path: join(directory, ADMISSION_RECOVERY_FILENAME), key,
      domain: 'resonance:admission-recovery:v1', maxBytes: 4 * 1024 * 1024, initial: initial!, validate: valid,
      mode: initial ? 'create-new' : 'open-existing' });
    for (const name of storage.read().registered) if (!existsSync(join(directory, name, filenames[name]))) {
      throw new Error('Registered recovery history is missing; preserve the directory');
    }
  } catch (error) { storage!?.close(); key.fill(0); signer.secretKey.fill(0); throw error; }
  type Components = {
    freeze: ReturnType<typeof createHistoryCheckpointRecovery>; agreement: ReturnType<typeof createHistoryAgreementCoordinator>;
    download: ReturnType<typeof createHistoryAncestryDownload>; provision: ReturnType<typeof createHistoryProvisionCoordinator>;
  };
  let closed = false, active = false;
  const handles: Partial<Components> = {};
  function live() { if (closed) throw new Error('Admission recovery is closed'); storage.read(); }
  const common = { context: p.context, localKey: key, signingKey: signer };
  function component<N extends Name>(name: N): Components[N] {
    live(); if (handles[name]) return handles[name]!;
    const state = storage.read(), slot = sourceRoot(state, genesisId, p), registered = state.registered.includes(name);
    if (!registered) {
      if (state.creating && state.creating !== name) throw new Error('Finish the pending recovery artifact first');
      if (!state.creating) storage.write({ ...state, creating: name });
    }
    const path = join(directory, name), initialize = !registered && !existsSync(join(path, filenames[name]));
    if (initialize) empty(path); // Ambiguous interrupted setup is preserved, never interpreted as missing accepted state.
    let result: Components[Name];
    if (name === 'freeze') result = createHistoryCheckpointRecovery({ ...common, ...slot, directory: path, members: p.members,
      transport: p.transport, timeoutMs: p.timeoutMs, initialize });
    else if (name === 'agreement') {
      if (!state.preferred) throw new Error('Recovery has no frozen proposal');
      result = createHistoryAgreementCoordinator({ ...common, ...slot, directory: path, members: pinned.agreementMembers,
        transport: options.agreementTransport, timeoutMs: p.timeoutMs,
        ...(initialize ? { initialize: { proposal: state.preferred, view: state.view } } : {}),
        historyTransfer: { transport: options.dataTransport, retained: () => component('download').blocks() } });
      const agreement = result.read();
      if (agreement.view !== state.view || historySuccessorProposalId(agreement.preferred) !== historySuccessorProposalId(state.preferred)
        || (state.selected && (!agreement.selected || historySuccessorProposalId(state.selected) !== historySuccessorProposalId(agreement.selected)))
        || (state.continuation && (!agreement.certificate || historyContinuationRootId(createHistoryContinuationRoot(
          agreement.selected!, agreement.certificate, p.context)) !== historyContinuationRootId(state.continuation)))) {
        result.close(); throw new Error('Recovery agreement and retained selection disagree');
      }
    } else if (name === 'download') {
      if (!state.selected) throw new Error('Recovery has no selected proposal');
      result = createHistoryAncestryDownload({ ...common, directory: path, members: p.members, proposal: state.selected,
        transport: p.transport, timeoutMs: p.timeoutMs, initialize });
    } else {
      if (!state.continuation) throw new Error('Recovery has no confirmed continuation');
      result = createHistoryProvisionCoordinator({ ...common, directory: path, members: pinned.agreementMembers, root: state.continuation,
        transport: options.provisionTransport, timeoutMs: p.timeoutMs, initialize });
      if (state.complete && result.read().receipts.length !== 4) { result.close(); throw new Error('Recovery provision evidence is incomplete'); }
    }
    try { if (!registered) storage.write({ ...storage.read(), registered: [...state.registered, name], creating: null }); }
    catch (error) { result.close(); throw error; }
    (handles as Record<Name, Components[Name]>)[name] = result; return result as Components[N];
  }
  function release() { for (const name of [...names].reverse()) { handles[name]?.close(); delete handles[name]; } }
  function close() { if (!closed) { closed = true; release(); storage.close(); signer.secretKey.fill(0); key.fill(0); } }
  function status() {
    live(); const state = storage.read();
    return { rootId: sourceRoot(state, genesisId, p).rootId, generation: sourceRoot(state, genesisId, p).generation,
      nextGeneration: state.nextGeneration, view: state.view, phase: state.complete ? 'review' : state.continuation ? 'provision'
        : state.selected ? 'download-and-confirm' : state.preferred ? 'select' : 'freeze', complete: state.complete };
  }
  function reopenRegistered() { for (const name of names) if (storage.read().registered.includes(name)) component(name); }
  return {
    status,
    /** One bounded phase, or at most maxBlocks downloaded blocks. Reopen and status never transmit. */
    async advance(options: { maxBlocks?: number; signal?: AbortSignal } = {}) {
      if (options.maxBlocks !== undefined && (!Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 || options.maxBlocks > 10001)) {
        throw new Error('Invalid recovery download step size');
      }
      live(); if (active || options.signal?.aborted) throw new Error('Recovery active or cancelled'); active = true;
      options.signal?.addEventListener('abort', close, { once: true });
      try {
        reopenRegistered(); const state = storage.read();
        if (!state.preferred) {
          const evidence = await component('freeze').prepare(); live();
          storage.write({ ...storage.read(), preferred: createHistorySuccessorProposal(evidence, p.context, signer) });
        } else if (!state.selected) {
          const selected = await component('agreement').select(options.signal); live();
          storage.write({ ...storage.read(), selected: selected.proposal });
        } else if (!state.continuation) {
          const download = component('download');
          if (!download.read().complete) { await download.run({ maxBlocks: options.maxBlocks ?? 128, signal: options.signal }); live(); }
          else {
            const certificate = await component('agreement').run(options.signal); live();
            storage.write({ ...storage.read(), continuation: createHistoryContinuationRoot(state.selected, certificate, p.context) });
          }
        } else if (!state.complete) {
          await component('provision').run(options.signal); live(); storage.write({ ...storage.read(), complete: true });
        }
        return status();
      } finally { options.signal?.removeEventListener('abort', close); release(); active = false; }
    },
    /** Pure local semantic review; does not start admission or use cached receipts as readiness. */
    async reviewRestore(destination: string, policy: unknown) {
      live(); if (active || !storage.read().complete) throw new Error('Recovery has not completed provisioning or is active'); active = true;
      try {
        reopenRegistered();
        const preparation = await prepareAdmissionHistoryRestore({ directory: destination, policy, context: p.context, genesisId,
          continuation: storage.read().continuation!, encryptionKey: key, blocks: component('download').blocks() });
        live(); return preparation;
      } finally { release(); active = false; }
    },
    close,
  };
}
