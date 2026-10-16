/** One locally enrolled predecessor/child slot. Never discovers paths or enrolment pins from a peer. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointContextId, parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionReceipt, parseHistoryProvisionRequest } from '@resonance/core/history-provision';
import { openHistoryCheckpointStore, prepareHistoryContinuationStore } from './history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from './history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from './history-checkpoint-agreement.js';
import { parseHistoryExchangeRequest } from '@resonance/core/history-exchange';

export const HISTORY_PROVISION_FILENAME = 'history-provision.json';
interface State {
  version: 1; contextId: string; replica: string; parentRootId: string; parentGeneration: number;
  phase: 'empty' | 'creating' | 'ready'; root: HistoryContinuationRoot | null;
}
export function openHistoryGenerationProvisioner(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  parent: ReturnType<typeof openHistoryCheckpointStore>; initialize?: boolean;
  /** Resume only an unpublished empty slot whose durable parent has never activated a child. */
  resumePristine?: boolean;
  maxBytes?: number; maxBlocks?: number; acceptNew?: () => boolean; now?: () => number;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const key = copyAdmissionSigningKey(options.signingKey), localKey = Buffer.from(options.localKey);
  const replica = Buffer.from(key.publicKey).toString('base64url'), parent = options.parent, head = parent.describe();
  const directory = options.directory, now = options.now ?? Date.now;
  let child: ReturnType<typeof openHistoryCheckpointStore> | undefined, closed = false, failed = false;
  const initial: State = { version: 1, contextId, replica, parentRootId: head.rootId, parentGeneration: head.generation, phase: 'empty', root: null };
  const validate = (raw: unknown): raw is State => {
    if (!exactWitnessFields(raw, Object.keys(initial)) || raw.version !== 1 || raw.contextId !== contextId || raw.replica !== replica
      || raw.parentRootId !== head.rootId || raw.parentGeneration !== head.generation) return false;
    if (raw.phase === 'empty') return raw.root === null;
    try {
      const root = parseHistoryContinuationRoot(raw.root, context);
      return ['creating', 'ready'].includes(raw.phase as string) && root.proposal.rootId === head.rootId && root.proposal.generation === head.generation;
    } catch { return false; }
  };
  const paths = (root: HistoryContinuationRoot) => {
    const id = historyContinuationRootId(root).slice(7);
    return { staging: join(directory, `.creating-${id}`), published: join(directory, `generation-${id}`) };
  };
  const childOptions = (root: HistoryContinuationRoot, path: string) => ({ directory: path, localKey, context, replica,
    rootId: historyContinuationRootId(root), generation: root.generation, parent, maxBytes: options.maxBytes, maxBlocks: options.maxBlocks });
  function checkDirectory(path: string) {
    if (!lstatSync(path).isDirectory()) throw new Error('History provision path is not a real directory');
  }
  let journal: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    if (!parent.matches(context, replica)) throw new Error('Provisioner belongs to another predecessor or member');
    if (options.resumePristine && (!options.initialize || parent.activatedContinuation()
      || existsSync(join(directory, HISTORY_PROVISION_FILENAME)))) throw new Error('Cannot recreate an activated or published provision slot');
    if (options.initialize) {
      if (existsSync(directory) && readdirSync(directory).length) {
        if (!options.resumePristine) throw new Error('History provision enrolment directory is not empty');
        const allowed = /^(?:history-provision\.json\.(?:lock|recovery)|\.history-provision\.json\.[a-f0-9]{16}\.tmp)$/;
        if (readdirSync(directory).some(name => !allowed.test(name) || !lstatSync(join(directory, name)).isFile())) {
          throw new Error('Unregistered provision initialization contents require inspection');
        }
      }
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      flush(dirname(directory));
    }
    checkDirectory(directory);
    journal = openEncryptedLocalState<State>({ path: join(directory, HISTORY_PROVISION_FILENAME), key: localKey,
      domain: 'resonance:history-provision-state:v1', maxBytes: 64 * 1024, initial, validate,
      mode: options.initialize ? 'create-new' : 'open-existing' });
    const state = journal.read();
    if (state.phase === 'ready') {
      const p = paths(state.root!); checkDirectory(p.published);
      if (existsSync(p.staging)) throw new Error('Published history has conflicting staging state');
      child = openHistoryCheckpointStore(childOptions(state.root!, p.published));
    }
  } catch (error) { child?.close(); journal!?.close(); key.secretKey.fill(0); localKey.fill(0); throw error; }
  function ensureOpen() {
    if (closed || failed) throw new Error('History provisioner closed or write failed; reopen before reuse');
    journal.read();
  }
  return {
    provision(raw: unknown) {
      ensureOpen();
      const request = parseHistoryProvisionRequest(raw, context, now()), root = request.root, p = paths(root);
      if (request.replica !== replica || root.proposal.rootId !== head.rootId || root.proposal.generation !== head.generation) {
        throw new Error('History provision request does not match enrolled predecessor');
      }
      let state = journal.read();
      if (state.root && historyContinuationRootId(state.root) !== historyContinuationRootId(root)) throw new Error('Another child already occupies this provision slot');
      if (state.phase === 'empty') {
        if (options.acceptNew?.() === false) throw new Error('History owner paused new storage');
        ensureOpen(); parseHistoryProvisionRequest(request, context, now());
        if (existsSync(p.staging) || existsSync(p.published)) throw new Error('Unregistered history directory requires inspection');
      }
      try {
        // Parent validation/activation is irreversible and keeps every old block. If the journal
        // write then fails, an exact retry can recover the same already-activated boundary.
        const authorized = parent.activateContinuation(root);
        if (state.phase === 'empty') {
          state = { ...state, phase: 'creating', root: authorized }; journal.write(state);
        }
        if (state.phase === 'creating') {
          if (existsSync(p.published)) {
            checkDirectory(p.published);
            if (existsSync(p.staging)) throw new Error('Ambiguous history publication directories');
          } else {
            if (existsSync(p.staging)) checkDirectory(p.staging);
            prepareHistoryContinuationStore({ ...childOptions(state.root!, p.staging), initialize: state.root! });
            renameSync(p.staging, p.published); flush(directory);
          }
          child = openHistoryCheckpointStore(childOptions(state.root!, p.published));
          // Nothing may append to the child until this flushed marker prevents re-creation.
          journal.write({ ...state, phase: 'ready' });
        }
        parent.requireContinuation(root, replica);
        if (!child?.matches(context, replica)) throw new Error('Provisioned child is unavailable');
      } catch (error) { failed = true; throw error; }
      const receipt = createHistoryProvisionReceipt(request, key);
      parseHistoryProvisionRequest(request, context, now()); // A slow fsync never grants an expired receipt.
      return receipt;
    },
    /** Ready stores can be routed by their pinned root, without replacing the predecessor service. */
    child() { ensureOpen(); return child ?? null; },
    read(): State { ensureOpen(); return structuredClone(journal.read()); },
    close() {
      if (!closed) { closed = true; child?.close(); journal.close(); key.secretKey.fill(0); localKey.fill(0); }
    },
  };
}

/** Routes the complete locally enrolled chain and one provisionable child on a bounded listener. */
export function createHistoryGenerationReplica(options: Parameters<typeof openHistoryGenerationProvisioner>[0] & {
  /** Genesis first, ending immediately before parent. Handles retain their caller-owned lifetime. */
  ancestors?: ReturnType<typeof openHistoryCheckpointStore>[];
}) {
  const retained = [...(options.ancestors ?? []), options.parent];
  const replica = Buffer.from(options.signingKey.publicKey).toString('base64url');
  if (retained.length > 65 || retained[0].describe().generation !== 0) throw new Error('History routing requires complete bounded ancestry from genesis');
  const seen = new Set<string>();
  for (let i = 0; i < retained.length; i++) {
    const store = retained[i], head = store.describe(), root = store.envelopeAt(0)!;
    if (!store.matches(options.context, replica) || seen.has(head.rootId)) throw new Error('Invalid history routing enrolment');
    seen.add(head.rootId);
    if (i) {
      if (root.kind !== 'continuation') throw new Error('History routing has an ancestry gap');
      const parentHead = retained[i - 1].describe();
      if (root.proposal.rootId !== parentHead.rootId || root.proposal.generation !== parentHead.generation) throw new Error('History routing has an ancestry gap');
      retained[i - 1].requireContinuation(root, replica);
    }
  }
  const provisioner = openHistoryGenerationProvisioner(options);
  let agreement: ReturnType<typeof createHistoryAgreementReplica>;
  const routes = new Map<string, ReturnType<typeof createHistoryCheckpointReplica>>();
  let next: ReturnType<typeof createHistoryCheckpointReplica> | undefined;
  try {
    agreement = createHistoryAgreementReplica({ ...options, store: options.parent });
    for (const store of retained) routes.set(store.describe().rootId, createHistoryCheckpointReplica({ ...options, store }));
  } catch (error) { agreement!?.close(); routes.forEach(r => r.close()); provisioner.close(); throw error; }
  return {
    exchange: agreement.exchange, transfer: agreement.transfer, provision: provisioner.provision,
    checkpoint(raw: unknown) {
      provisioner.read(); // Closed/uncertain provisioning never exposes an unfinished child.
      if (!raw || typeof raw !== 'object' || !('request' in raw)) throw new Error('Invalid history frame');
      const request = parseHistoryExchangeRequest(raw.request, options.context, (options.now ?? Date.now)());
      const route = routes.get(request.rootId);
      if (route) return route.exchange(raw);
      const child = provisioner.child();
      if (!child || request.rootId !== child.describe().rootId) throw new Error('History generation is not provisioned');
      next ??= createHistoryCheckpointReplica({ ...options, store: child });
      return next.exchange(raw);
    },
    read: provisioner.read,
    close() { next?.close(); routes.forEach(r => r.close()); agreement.close(); provisioner.close(); },
  };
}
function flush(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
