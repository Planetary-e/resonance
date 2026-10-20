/** One locally enrolled predecessor/child slot. Never discovers paths or enrolment pins from a peer. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState, inspectLocalStateOwnership, isLocalStateOwnershipName } from '@resonance/core/local-state';
import { captureStorageReservationOperation, reserveManagedStorage } from '@resonance/core/storage-reservations';
import type { SharedHistoryPool } from './history-shared-pool.js';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { historyCheckpointContextId, parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionReceipt, parseHistoryProvisionRequest } from '@resonance/core/history-provision';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore, prepareHistoryContinuationStore } from './history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from './history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from './history-checkpoint-agreement.js';
import { parseHistoryExchangeRequest } from '@resonance/core/history-exchange';

export const HISTORY_PROVISION_FILENAME = 'history-provision.json';
export const HISTORY_PROVISION_JOURNAL_BYTES = 64 * 1024;
interface StateBase {
  contextId: string; replica: string; parentRootId: string; parentGeneration: number;
  phase: 'empty' | 'creating' | 'ready'; root: HistoryContinuationRoot | null;
}
type Location = 'generation' | 'legacy-staging' | 'pool' | 'shared-v2';
interface State extends StateBase { version: 2 | 3 | 4; location: Location | null; childDirectory?: string }
interface LegacyState extends StateBase { version: 1 }
type StoredState = State | LegacyState;
/** Preflight the slot before creating its directory, including a future empty successor slot. */
export function reserveHistoryProvisionJournal(directory: string) {
  return reserveManagedStorage({ path: join(directory, HISTORY_PROVISION_FILENAME), component: 'encrypted-local-state', scope: 'file',
    maximumBytes: 2 * HISTORY_PROVISION_JOURNAL_BYTES + 8192 });
}
export function openHistoryGenerationProvisioner(options: {
  sharedPool?: SharedHistoryPool;
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  parent: ReturnType<typeof openHistoryCheckpointStore>; initialize?: boolean;
  /** Resume only an unpublished empty slot whose durable parent has never activated a child. */
  resumePristine?: boolean;
  /** Explicit, independently selected pool destination. Bound into a new v3
   * journal; never inferred from a peer, empty directory or legacy journal.
   * The service must durably retire the previous occupant before reuse. */
  childDirectory?: string;
  maxBytes?: number; maxBlocks?: number; acceptNew?: () => boolean; now?: () => number;
}) {
  if (options.sharedPool) return openSharedProvisioner(options as typeof options & { sharedPool: SharedHistoryPool });
  const run = captureStorageReservationOperation();
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxBlocks = options.maxBlocks ?? 10001;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 4 * 1024 * 1024 || maxBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10001) throw new Error('Invalid history provision capacity');
  const fixed = options.childDirectory;
  const inside = (parent: string, path: string) => { const suffix = relative(parent, path); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\')); };
  if (fixed !== undefined && (typeof fixed !== 'string' || !isAbsolute(fixed) || resolve(fixed) !== fixed || Buffer.byteLength(fixed) > 4096
    || /[\x00-\x1f\x7f]/.test(fixed) || inside(resolve(options.directory), fixed) || inside(fixed, resolve(options.directory))
    || !lstatSync(dirname(fixed)).isDirectory())) {
    throw new Error('Invalid independently selected history pool destination');
  }
  const key = copyAdmissionSigningKey(options.signingKey), localKey = Buffer.from(options.localKey);
  const replica = Buffer.from(key.publicKey).toString('base64url'), parent = options.parent, head = parent.describe();
  const directory = options.directory, now = options.now ?? Date.now;
  let child: ReturnType<typeof openHistoryCheckpointStore> | undefined, closed = false, failed = false;
  const initial: State = { version: fixed === undefined ? 2 : 3, contextId, replica, parentRootId: head.rootId, parentGeneration: head.generation,
    phase: 'empty', root: null, location: null, ...(fixed === undefined ? {} : { childDirectory: fixed }) };
  const fields = ['version', 'contextId', 'replica', 'parentRootId', 'parentGeneration', 'phase', 'root'];
  const validate = (raw: unknown): raw is StoredState => {
    const version = raw && typeof raw === 'object' && 'version' in raw ? raw.version : undefined;
    const located = version === 2 || version === 3, pool = version === 3;
    if (!exactWitnessFields(raw, [...fields, ...(located ? ['location'] : []), ...(pool ? ['childDirectory'] : [])])
      || !(fixed === undefined ? [1, 2] : [3]).includes(raw.version as number)
      || pool && raw.childDirectory !== fixed
      || raw.contextId !== contextId || raw.replica !== replica || raw.parentRootId !== head.rootId || raw.parentGeneration !== head.generation) return false;
    if (raw.phase === 'empty') return raw.root === null && (!located || raw.location === null);
    if (pool ? raw.location !== 'pool' : located && raw.location !== 'generation' && raw.location !== 'legacy-staging') return false;
    try {
      const root = parseHistoryContinuationRoot(raw.root, context);
      return ['creating', 'ready'].includes(raw.phase as string) && root.proposal.rootId === head.rootId && root.proposal.generation === head.generation;
    } catch { return false; }
  };
  const paths = (root: HistoryContinuationRoot) => {
    const id = historyContinuationRootId(root).slice(7);
    return { staging: join(directory, `.creating-${id}`), published: fixed ?? join(directory, `generation-${id}`) };
  };
  const selectedPath = (state: State) => state.location === 'legacy-staging' ? paths(state.root!).staging : paths(state.root!).published;
  const childOptions = (root: HistoryContinuationRoot, path: string) => ({ directory: path, localKey, context, replica,
    rootId: historyContinuationRootId(root), generation: root.generation, parent, maxBytes, maxBlocks });
  function present(path: string) {
    try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  function checkDirectory(path: string) {
    if (!lstatSync(path).isDirectory()) throw new Error('History provision path is not a real directory');
  }
  function checkLayout(state: State) {
    if (state.phase === 'empty') return;
    const p = paths(state.root!), selected = selectedPath(state), other = state.location === 'legacy-staging' ? p.published : p.staging;
    if (present(other)) throw new Error('Ambiguous history publication directories');
    if (state.phase === 'ready' || present(selected)) checkDirectory(selected);
  }
  let journal: ReturnType<typeof openEncryptedLocalState<StoredState>>;
  function readState(): State {
    const state = journal.read();
    if (state.version === 1) throw new Error('History provision location must be durably selected before reuse');
    return state;
  }
  try {
    if (!parent.matches(context, replica)) throw new Error('Provisioner belongs to another predecessor or member');
    if (options.resumePristine && (!options.initialize || parent.activatedContinuation()
      || existsSync(join(directory, HISTORY_PROVISION_FILENAME)))) throw new Error('Cannot recreate an activated or published provision slot');
    reserveHistoryProvisionJournal(directory);
    if (options.initialize) {
      if (existsSync(directory) && readdirSync(directory).length) {
        if (!options.resumePristine) throw new Error('History provision enrolment directory is not empty');
        const allowed = /^(?:history-provision\.json\.(?:lock|recovery)|\.history-provision\.json\.[a-f0-9]{16}\.tmp)$/;
        if (readdirSync(directory).some(name => {
          if (isLocalStateOwnershipName(HISTORY_PROVISION_FILENAME, name)) { inspectLocalStateOwnership(join(directory, name)); return false; }
          return !allowed.test(name) || !lstatSync(join(directory, name)).isFile();
        })) {
          throw new Error('Unregistered provision initialization contents require inspection');
        }
      }
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      flush(dirname(directory));
    }
    checkDirectory(directory);
    journal = openEncryptedLocalState<StoredState>({ path: join(directory, HISTORY_PROVISION_FILENAME), key: localKey,
      domain: 'resonance:history-provision-state:v1', maxBytes: HISTORY_PROVISION_JOURNAL_BYTES, initial, validate,
      mode: options.initialize ? 'create-new' : 'open-existing' });
    const previous = journal.read();
    if (previous.version === 1) {
      // An old ready marker already binds the published directory. Only a never-
      // published creating intent may select its sole retained staging directory.
      let location: Location | null = null;
      if (previous.phase !== 'empty') {
        const p = paths(previous.root!);
        if (present(p.staging) && present(p.published)) throw new Error('Ambiguous history publication directories');
        location = previous.phase === 'creating' && present(p.staging) ? 'legacy-staging' : 'generation';
      }
      const selected: State = { ...previous, version: 2, location }; checkLayout(selected);
      journal.write(selected); // Pin before reopening/continuing; process death cannot lose the choice.
    }
    const state = readState(); checkLayout(state);
    if (state.phase === 'ready') child = openHistoryCheckpointStore(childOptions(state.root!, selectedPath(state)));
  } catch (error) { child?.close(); journal!?.close(); key.secretKey.fill(0); localKey.fill(0); throw error; }
  function ensureOpen() {
    if (closed || failed) throw new Error('History provisioner closed or write failed; reopen before reuse');
    readState();
  }
  return {
    provision(raw: unknown) { return run(() => {
      ensureOpen();
      const request = parseHistoryProvisionRequest(raw, context, now()), root = request.root, p = paths(root);
      if (request.replica !== replica || root.proposal.rootId !== head.rootId || root.proposal.generation !== head.generation) {
        throw new Error('History provision request does not match enrolled predecessor');
      }
      if (Buffer.byteLength(JSON.stringify(root)) > maxBytes - 4 * 1024 * 1024) throw new Error('History provision root exceeds child capacity');
      let state = readState();
      if (state.root && historyContinuationRootId(state.root) !== historyContinuationRootId(root)) throw new Error('Another child already occupies this provision slot');
      if (state.phase === 'empty') {
        if (options.acceptNew?.() === false) throw new Error('History owner paused new storage');
        ensureOpen(); parseHistoryProvisionRequest(request, context, now());
        if (present(p.staging) || present(p.published)) throw new Error('Unregistered history directory requires inspection');
      } else checkLayout(state);
      const path = state.phase === 'empty' ? p.published : selectedPath(state);
      if (fixed !== undefined) checkDirectory(dirname(fixed)); // Missing pool ownership is not free capacity.
      reserveHistoryStorage({ directory: path, component: 'history-replica-ciphertext', ciphertextBytes: maxBytes - 4 * 1024 * 1024,
        manifestFilename: HISTORY_MANIFEST_FILENAME, manifestBytes: 2 * 1024 * 1024 });
      ensureOpen(); parseHistoryProvisionRequest(request, context, now());
      try {
        const authorized = parent.activateContinuation(root);
        if (state.phase === 'empty') {
          state = { ...state, phase: 'creating', root: authorized, location: state.version === 3 ? 'pool' : 'generation' }; journal.write(state);
        }
        if (state.phase === 'creating') {
          // The fixed path is never exposed until the ready journal is durable.
          // Preparation permits only an authenticated pristine child, never a
          // previously operational child whose ready marker has been lost.
          prepareHistoryContinuationStore({ ...childOptions(state.root!, path), initialize: state.root! });
          child = openHistoryCheckpointStore(childOptions(state.root!, path));
          journal.write({ ...state, phase: 'ready' });
        }
        parent.requireContinuation(root, replica);
        if (!child?.matches(context, replica)) throw new Error('Provisioned child is unavailable');
      } catch (error) { failed = true; throw error; }
      const receipt = createHistoryProvisionReceipt(request, key);
      parseHistoryProvisionRequest(request, context, now());
      return receipt;
    }); },
    child() { ensureOpen(); return child ?? null; },
    read(): State { ensureOpen(); return structuredClone(readState()); },
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
  if (retained.length > (options.sharedPool ? 10001 : 65) || retained[0].describe().generation !== 0) throw new Error('History routing requires complete bounded ancestry from genesis');
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

/** Shared ownership and immutable record versions replace per-generation journal allocations. */
function openSharedProvisioner(options: Parameters<typeof openHistoryGenerationProvisioner>[0] & { sharedPool: SharedHistoryPool }) {
  const run = captureStorageReservationOperation(), pool = options.sharedPool, parent = options.parent;
  const context = parseHistoryCheckpointContext(options.context), replica = Buffer.from(options.signingKey.publicKey).toString('base64url');
  pool.assertPins(context, replica, parent.genesisId); if (parent.sharedPool !== pool || !parent.matches(context, replica) || options.childDirectory) throw new Error('Shared provisioner requires its same-owner predecessor');
  const head = parent.describe(), maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxBlocks = options.maxBlocks ?? 10001;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 4 * 1024 * 1024 || maxBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10001) throw new Error('Invalid history provision capacity');
  const initial: State = { version: 4, contextId: historyCheckpointContextId(context), replica, parentRootId: head.rootId, parentGeneration: head.generation,
    phase: 'empty', root: null, location: null };
  const validate = (v: unknown): v is StoredState => {
    if (!exactWitnessFields(v, Object.keys(initial)) || v.version !== 4 || v.contextId !== initial.contextId || v.replica !== replica || v.parentRootId !== head.rootId || v.parentGeneration !== head.generation) return false;
    if (v.phase === 'empty') return v.root === null && v.location === null;
    try { const root = parseHistoryContinuationRoot(v.root, context); return ['creating', 'ready'].includes(v.phase as string) && v.location === 'shared-v2' && root.proposal.rootId === head.rootId && root.proposal.generation === head.generation; } catch { return false; }
  };
  const key = copyAdmissionSigningKey(options.signingKey);
  let journal: { read(): StoredState; write(value: StoredState): void; close(): void };
  let child: ReturnType<typeof openHistoryCheckpointStore> | undefined, closed = false, failed = false;
  const childOptions = (root: HistoryContinuationRoot) => ({ directory: pool.directory, localKey: options.localKey, context, replica, rootId: historyContinuationRootId(root), generation: root.generation,
    parent, sharedPool: pool, maxBytes, maxBlocks });
  try {
    if (options.initialize && parent.activatedContinuation()) throw new Error('Activated history is missing its successor journal');
    journal = pool.openRecord<StoredState>({ rootId: head.rootId, generation: head.generation, kind: 'provision', initial, validate, maxBytes: HISTORY_PROVISION_JOURNAL_BYTES, initialize: options.initialize });
    const state = journal.read() as State; if (state.phase === 'ready') child = openHistoryCheckpointStore(childOptions(state.root!));
  } catch (error) { journal!?.close(); key.secretKey.fill(0); throw error; }
  function ensureOpen() { if (closed || failed) throw new Error('History provisioner closed or write failed; reopen before reuse'); journal.read(); }
  return {
    provision(raw: unknown) { return run(() => {
      ensureOpen(); const request = parseHistoryProvisionRequest(raw, context, (options.now ?? Date.now)()), root = request.root;
      if (request.replica !== replica || root.proposal.rootId !== head.rootId || root.proposal.generation !== head.generation) throw new Error('History provision request does not match enrolled predecessor');
      let state = journal.read() as State;
      if (state.root && historyContinuationRootId(state.root) !== historyContinuationRootId(root)) throw new Error('Another child already occupies this provision slot');
      if (state.phase === 'empty' && options.acceptNew?.() === false) throw new Error('History owner paused new storage');
      if (state.phase !== 'ready') pool.preparePublication(root);
      try {
        const authorized = parent.activateContinuation(pool.heldMutation()?.root ?? root);
        if (state.phase === 'empty') { state = { ...state, phase: 'creating', root: authorized, location: 'shared-v2' }; journal.write(state); }
        if (state.phase === 'creating') {
          prepareHistoryContinuationStore({ ...childOptions(state.root!), initialize: state.root! });
          child = openHistoryCheckpointStore(childOptions(state.root!));
          // This journal is part of the complete child, before durable ready publication.
          if (!pool.hasRecord(historyContinuationRootId(state.root!), 'provision')) {
            const successor = openSharedProvisioner({ ...options, parent: child, initialize: true }); successor.close();
          }
          journal.write({ ...state, phase: 'ready' });
        }
        parent.requireContinuation(root, replica); if (!child?.matches(context, replica)) throw new Error('Provisioned child unavailable');
      } catch (error) { failed = true; throw error; }
      parseHistoryProvisionRequest(request, context, (options.now ?? Date.now)()); return createHistoryProvisionReceipt(request, key);
    }); },
    child() { ensureOpen(); return child ?? null; },
    read(): State { ensureOpen(); return structuredClone(journal.read()) as State; },
    close() { if (!closed) { closed = true; child?.close(); journal.close(); key.secretKey.fill(0); } },
  };
}
