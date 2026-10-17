/** One operator-enrolled history, retaining and routing every certified generation across restarts. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { parseHistoryProvisionRequest } from '@resonance/core/history-provision';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { createHistoryCompactionVote, parseHistoryCompactionProposal, parseHistoryCompactionAttestation } from '@resonance/core/history-compaction';
import { parseHistoryCompactionControlFrame, parseHistoryCompactionControlRequest,
  createHistoryCompactionControlResponse } from '@resonance/core/history-compaction-control';
import { parseHistoryFrontierRequest, createHistoryFrontierResponse } from '@resonance/core/history-frontier';
import { parseHistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { openHistoryVolunteerFrontier, isHistoryVolunteerFrontierFile, inspectHistoryRetiredGenerations,
  cleanHistoryRetiredGenerations, type HistoryVolunteerFrontier } from './history-volunteer-frontier.js';
import { HISTORY_POOL_FILENAME, HISTORY_POOL_DIRECTORY, historyPoolPaths, historyPoolSlot, isHistoryPoolFile,
  openHistoryVolunteerPool, ensureHistoryPoolDirectories, reserveHistoryPool, inspectHistoryPoolRetirement,
  cleanHistoryPoolRetirement, type HistoryVolunteerPoolState } from './history-volunteer-pool.js';
import { historyDigest, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from './history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from './history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from './history-checkpoint-agreement.js';
import { HISTORY_PROVISION_FILENAME, openHistoryGenerationProvisioner, reserveHistoryProvisionJournal } from './history-generation-provisioner.js';
import type { HistoryVolunteerHealth } from './history-health.js';

export function openHistoryVolunteerService(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  /** Independently retained genesis pin, never recovered from this directory or a peer. */
  genesisId: string; initialize?: HistoryCheckpointEnvelope;
  maxBytes?: number; maxBlocks?: number; maxGenerations?: number; acceptNew?: () => boolean; now?: () => number;
}) {
  const run = captureStorageReservationOperation();
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxBlocks = options.maxBlocks ?? 10001;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 4 * 1024 * 1024 || maxBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 10001) throw new Error('Invalid volunteer storage capacity');
  const context = parseHistoryCheckpointContext(options.context), maxGenerations = options.maxGenerations ?? 65;
  const genesisId = options.genesisId, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 65) throw new Error('Invalid volunteer generation capacity');
  const signingKey = copyAdmissionSigningKey(options.signingKey), localKey = Buffer.from(options.localKey);
  const replica = Buffer.from(signingKey.publicKey).toString('base64url'), directory = options.directory;
  type Store = ReturnType<typeof openHistoryCheckpointStore>;
  type Slot = { store: Store; provisioner: ReturnType<typeof openHistoryGenerationProvisioner>;
    checkpoint: ReturnType<typeof createHistoryCheckpointReplica>; agreement: ReturnType<typeof createHistoryAgreementReplica> };
  const slots = new Map<string, Slot>(); let genesis: Store | undefined, anchored: Store | undefined, closed = false, failed = false;
  let frontier: ReturnType<typeof openHistoryVolunteerFrontier> | undefined;
  let pool: ReturnType<typeof openHistoryVolunteerPool> | undefined;
  const slotName = (rootId: string) => `successors-${rootId.slice(7)}`;
  const shared = { context, signingKey, localKey, now: options.now, maxBytes, maxBlocks,
    acceptNew: options.acceptNew };
  function live() { if (closed || failed) throw new Error('History volunteer service is closed or needs reopening'); }
  function generationLimit() { return pool ? pool.read().slots + 1 : maxGenerations; }
  function provisionPath(rootId: string, generation: number) { return pool ? historyPoolPaths(directory, pool.read().slots, generation).provision : join(directory, slotName(rootId)); }
  function retainedStores() { return [...(genesis && !slots.has(genesisId) ? [genesis] : []), ...[...slots.values()].map(s => s.store)]; }
  function closeStores() {
    for (const slot of [...slots.values()].reverse()) { slot.checkpoint.close(); slot.agreement.close(); slot.provisioner.close(); }
    slots.clear(); anchored?.close(); anchored = undefined; genesis?.close(); genesis = undefined;
  }
  function close() {
    if (closed) return; closed = true;
    closeStores(); pool?.close(); frontier?.close(); signingKey.secretKey.fill(0); localKey.fill(0);
  }
  function add(store: Store) {
    const retained = retainedStores();
    if (!retained.includes(store) && retained.length >= generationLimit()) throw new Error('History volunteer generation capacity exceeded');
    const head = store.describe(), path = provisionPath(head.rootId, head.generation);
    const absent = !existsSync(join(path, HISTORY_PROVISION_FILENAME));
    // Activation is durable before any child can exist or accept a write. A missing slot after
    // activation is lost history, not a fresh enrollment. Never infer an empty child in that case.
    if (absent && store.activatedContinuation()) throw new Error('Activated history is missing its successor journal');
    let provisioner: Slot['provisioner'] | undefined, checkpoint: Slot['checkpoint'] | undefined, agreement: Slot['agreement'] | undefined;
    try {
      provisioner = openHistoryGenerationProvisioner({ ...shared, directory: path, parent: store, initialize: absent, resumePristine: absent,
        ...(pool ? { childDirectory: historyPoolPaths(directory, pool.read().slots, head.generation + 1).history } : {}) });
      checkpoint = createHistoryCheckpointReplica({ ...shared, store }); agreement = createHistoryAgreementReplica({ ...shared, store });
      slots.set(head.rootId, { store, provisioner, checkpoint, agreement });
    } catch (error) { checkpoint?.close(); agreement?.close(); provisioner?.close(); throw error; }
  }
  function grow() {
    live();
    try {
      let slot = [...slots.values()].at(-1)!;
      for (let child = slot.provisioner.child(); child; child = slot.provisioner.child()) {
        if (slots.has(child.describe().rootId)) throw new Error('History volunteer ancestry repeats a root');
        add(child); slot = [...slots.values()].at(-1)!;
      }
      const state = frontier?.read(), pooled = pool?.read();
      const known = new Set(pooled ? ['genesis', HISTORY_POOL_DIRECTORY, ...pooled.legacySlots]
        : ['genesis', ...[...slots.keys()].map(slotName), ...(state ? [state.selectedPath.split('/')[0], ...state.retiredSlots] : [])]);
      if (readdirSync(directory).some(name => !known.has(name) && !isHistoryVolunteerFrontierFile(name) && !isHistoryPoolFile(name))) throw new Error('Unregistered volunteer history contents require inspection');
      if (pooled) {
        const occupied = new Set(pooled.retiredGenerations.map(g => historyPoolSlot(g, pooled.slots)));
        for (const slot of slots.values()) {
          const generation = slot.store.describe().generation, pending = slot.provisioner.read().root?.generation;
          if (generation > 0) occupied.add(historyPoolSlot(generation, pooled.slots));
          if (pending !== undefined) occupied.add(historyPoolSlot(pending, pooled.slots));
        }
        for (let index = 0; index < pooled.slots; index++) {
          const contents = readdirSync(historyPoolPaths(directory, pooled.slots, index + 1).base);
          if (contents.some(name => !['history', 'successor'].includes(name)) || !occupied.has(index) && contents.length) throw new Error('Unregistered history pool occupant requires inspection');
        }
      }
    } catch (error) { failed = true; throw error; }
  }
  function select(rootId: unknown) {
    live(); const slot = typeof rootId === 'string' ? slots.get(rootId) : undefined;
    if (!slot) throw new Error('History generation is not enrolled on this volunteer'); return slot;
  }
  function requestRoot(raw: unknown): unknown {
    return raw && typeof raw === 'object' && 'request' in raw && raw.request && typeof raw.request === 'object'
      && 'rootId' in raw.request ? raw.request.rootId : undefined;
  }
  function reviewDigest() {
    live(); const state = frontier?.read(), pooled = pool?.read();
    const entries = [...slots.values()].map(slot => [slot.store.reviewDigest(), slot.provisioner.read()]);
    // Preserve existing approval digests until a frontier has actually been selected.
    return historyDigest(JSON.stringify(pooled ? [pooled, genesis!.reviewDigest(), entries] : state ? [state, genesis!.reviewDigest(), entries] : entries));
  }
  function openStores(initialize?: HistoryCheckpointEnvelope) {
    const genesisPath = join(directory, 'genesis');
    if (existsSync(genesisPath) && !lstatSync(genesisPath).isDirectory()) throw new Error('Volunteer genesis must be a real directory');
    genesis = openHistoryCheckpointStore({ ...shared, directory: genesisPath, replica, generation: 0, rootId: genesisId, initialize });
    const state = frontier!.read(), pooled = pool?.read();
    if (pooled) ensureHistoryPoolDirectories(directory, pooled);
    const selected = pooled?.frontier ?? state?.retention;
    if (!selected) add(genesis);
    else {
      const certificate = selected.certificate, p = certificate.proposal;
      anchored = openHistoryCheckpointStore({ ...shared, directory: pooled ? historyPoolPaths(directory, pooled.slots, p.generation).history
        : join(directory, ...state!.selectedPath.split('/')), replica,
        rootId: p.rootId, generation: p.generation, retainedFrontier: { genesisId, certificate },
        retainedAncestorBytes: genesis.storageUsage().reservedBytes });
      const root = anchored.envelopeAt(0)!;
      if (root.kind !== 'continuation' || !pooled && state!.selectedPath.split('/')[0] !== slotName(root.proposal.rootId)) {
        throw new Error('Selected volunteer frontier path differs from its original continuation');
      }
      add(anchored);
    }
    grow();
    // Root, full selected state, barriers and every subsequent generation have
    // reopened successfully before any previously authorized cleanup resumes.
    if (pooled && pooled.phase !== 'ready') {
      cleanHistoryPoolRetirement(directory, pooled); pool!.finishCleanup();
    } else if (state) cleanHistoryRetiredGenerations(directory, state);
  }
  function poolPreparation(count: number) {
    live();
    if (pool || frontier!.read() || slots.size !== 1 || !slots.has(genesisId) || genesis!.activatedContinuation()
      || slots.get(genesisId)!.provisioner.read().phase !== 'empty' || !Number.isSafeInteger(count) || count < 2 || count > 64 || count + 1 > maxGenerations) {
      throw new Error('Initial pool selection requires an unactivated genesis and an explicit bounded slot count');
    }
    if (readdirSync(directory).includes(HISTORY_POOL_DIRECTORY)) throw new Error('Unregistered pool contents require inspection');
    const state: HistoryVolunteerPoolState = { version: 1, contextId: historyCheckpointContextId(context), genesisId, replica, slots: count,
      maxBytes, maxBlocks, phase: 'migrating', frontier: null, retiredGenerations: [], legacySlots: [slotName(genesisId)] };
    const inspected = inspectHistoryPoolRetirement(directory, state);
    const details = { kind: 'history-volunteer-pool-selection' as const, slots: count, maximumGenerations: count + 1,
      maximumGenerationBytes: maxBytes, maximumGenerationBlocks: maxBlocks, retainedGenesis: genesisId,
      notice: 'Funds fixed generation slots before selection. Existing reservations remain; cleanup must finish before reuse. No admission readiness is granted.' };
    return { state, review: { ...details, approvalDigest: historyDigest(`resonance:history-volunteer-pool-selection:v1\n${JSON.stringify([directory, reviewDigest(), state, inspected.digest])}`) } };
  }
  function generationRetirement(value: unknown) {
    live(); const retention = parseHistoryCompactionRetention(value, context, genesisId), p = retention.certificate.proposal;
    const latest = [...slots.values()].at(-1)!, head = latest.store.describe(), proof = latest.store.compactionAnchor()?.proposal;
    if (p.generation === 0 || p.rootId !== head.rootId || p.generation !== head.generation
      || !proof || proof.sequence !== p.sequence || proof.envelopeId !== p.envelopeId) {
      throw new Error('Generation retirement requires the latest retained generation checkpoint and four proof-retention acknowledgements');
    }
    const previous = frontier!.read(), pooled = pool?.read();
    if ((pooled?.frontier?.certificate.proposal.generation ?? previous?.retention.certificate.proposal.generation ?? 0) >= p.generation) throw new Error('Generation frontier must advance');
    if (pooled) {
      if (pooled.phase !== 'ready') throw new Error('History pool cleanup must finish before another retirement');
      const retiredGenerations = [...slots.values()].map(s => s.store.describe().generation).filter(g => g > 0 && g < p.generation).sort((a, b) => a - b);
      const poolState: HistoryVolunteerPoolState = { ...pooled, phase: 'retiring', frontier: retention, retiredGenerations, legacySlots: [] };
      const inspected = inspectHistoryPoolRetirement(directory, poolState);
      const review = { kind: 'history-volunteer-generation-retirement' as const, rootId: p.rootId, generation: p.generation,
        checkpointSequence: p.sequence, checkpointId: p.envelopeId, retainedProofCopies: 4, retiredDirectories: retiredGenerations.length,
        filesRemoved: inspected.filesRemoved, bytesReclaimed: inspected.bytesReclaimed,
        approvalDigest: historyDigest(`resonance:history-volunteer-pool-retirement:v1\n${JSON.stringify([directory, reviewDigest(), poolState, inspected.digest])}`),
        notice: 'Commits a certified frontier, removes redundant occupants and durably completes cleanup before reusing any fixed slot. All lifetime reservations remain.' };
      return { state: undefined, poolState, review };
    }
    const root = latest.store.envelopeAt(0)!;
    if (root.kind !== 'continuation') throw new Error('Generation frontier requires its original continuation');
    const parent = select(root.proposal.rootId), provision = parent.provisioner.read();
    if (provision.phase !== 'ready' || !provision.root || historyContinuationRootId(provision.root) !== p.rootId) throw new Error('Frontier child is not durably provisioned');
    const container = slotName(root.proposal.rootId), selectedPath = `${container}/${provision.location === 'legacy-staging' ? '.creating-' : 'generation-'}${p.rootId.slice(7)}`;
    const retiredSlots = readdirSync(directory).filter(name => /^successors-[a-f0-9]{64}$/.test(name)
      && name !== container && name !== slotName(p.rootId)).sort();
    const inspected = inspectHistoryRetiredGenerations(directory, retiredSlots);
    const state: HistoryVolunteerFrontier = { version: 1, contextId: p.contextId, genesisId, replica, retention, selectedPath, retiredSlots };
    const review = { kind: 'history-volunteer-generation-retirement' as const, rootId: p.rootId, generation: p.generation,
      checkpointSequence: p.sequence, checkpointId: p.envelopeId, retainedProofCopies: 4, retiredDirectories: retiredSlots.length,
      filesRemoved: inspected.filesRemoved, bytesReclaimed: inspected.bytesReclaimed,
      approvalDigest: historyDigest(`resonance:history-volunteer-generation-retirement:v1\n${JSON.stringify([directory, reviewDigest(), state, inspected.digest])}`),
      notice: 'Commits a certified frontier before removing redundant ancestors. Original genesis, selected suffix, barriers and all lifetime storage promises remain.' };
    return { state, poolState: undefined, review };
  }
  function prefixRetirement(rootId: string) {
    const slot = select(rootId), local = slot.store.planPrefixRetirement();
    return { slot, local, review: { ...local,
      approvalDigest: historyDigest(`resonance:history-volunteer-prefix-retirement:v1\n${JSON.stringify([directory, reviewDigest(), local.approvalDigest])}`) } };
  }
  function endorseCompactionCheckpoint(raw: unknown) {
    live();
    const proposal = parseHistoryCompactionProposal(raw, context, genesisId, now());
    const slot = select(proposal.rootId), head = slot.store.describe();
    if (slot !== [...slots.values()].at(-1) || head.freeze || head.generation !== proposal.generation) {
      throw new Error('Compaction endorsement requires the current unfrozen generation');
    }
    const checkpoint = slot.store.envelopeAt(proposal.sequence);
    if (!checkpoint || checkpoint.kind !== 'checkpoint' || historyCheckpointEnvelopeId(checkpoint) !== proposal.envelopeId) {
      throw new Error('Compaction endorsement requires its complete retained checkpoint');
    }
    live(); return createHistoryCompactionVote(proposal, context, genesisId, signingKey, now());
  }
  try {
    if (!context.members.includes(replica) || localKey.length !== 32) throw new Error('Invalid volunteer enrollment keys');
    if (!isHistoryDigest(options.genesisId)) throw new Error('Invalid volunteer genesis pin');
    if (options.initialize) {
      const root = parseHistoryCheckpointEnvelope(options.initialize, context);
      if (root.generation !== 0 || root.sequence !== 0 || root.kind === 'continuation' || historyCheckpointEnvelopeId(root) !== options.genesisId) {
        throw new Error('Volunteer genesis does not match enrollment pin');
      }
    }
    reserveHistoryStorage({ directory: join(directory, 'genesis'), component: 'history-replica-ciphertext',
      ciphertextBytes: maxBytes - 4 * 1024 * 1024, manifestFilename: HISTORY_MANIFEST_FILENAME, manifestBytes: 2 * 1024 * 1024 });
    reserveHistoryProvisionJournal(join(directory, slotName(options.genesisId)));
    if (options.initialize) {
      if (existsSync(directory) && readdirSync(directory).length) throw new Error('Volunteer enrollment requires a new empty directory');
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      if (process.platform !== 'win32') { const fd = openSync(dirname(directory), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('Volunteer history path must be a real directory');
    frontier = openHistoryVolunteerFrontier({ directory, localKey, context, genesisId, replica });
    if (readdirSync(directory).includes(HISTORY_POOL_FILENAME)) {
      if (frontier.read()) throw new Error('Conflicting legacy and pooled history frontiers');
      pool = openHistoryVolunteerPool({ directory, localKey, context, genesisId, replica, maxBytes, maxBlocks });
      if (pool.read().slots + 1 > maxGenerations) throw new Error('History pool exceeds configured generation capacity');
    }
    if (options.initialize && frontier.read()) throw new Error('Cannot initialize a retained volunteer frontier');
    openStores(options.initialize);
  } catch (error) { close(); throw error; }
  return {
    /** Network control requires its own fresh owner authorization. No request can
     * delete ciphertext, lower a stored anchor, replace a suffix or clear a barrier. */
    compaction(raw: unknown) {
      if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'history-compaction-proposal') return endorseCompactionCheckpoint(raw);
      live();
      if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'history-frontier-request') {
        const request = parseHistoryFrontierRequest(raw, context, genesisId, now());
        if (request.replica !== replica) throw new Error('History frontier request belongs to another volunteer');
        // Return only durably retained evidence. A newer generation without a
        // complete checkpoint does not erase the preceding usable anchor.
        const certificate = [...slots.values()].reverse().map(slot => slot.store.compactionAnchor()).find(Boolean) ?? null;
        live(); parseHistoryFrontierRequest(request, context, genesisId, now());
        const response = createHistoryFrontierResponse(request, certificate, context, signingKey);
        live(); parseHistoryFrontierRequest(request, context, genesisId, now()); return response;
      }
      const frame = parseHistoryCompactionControlFrame(raw, context, genesisId, now()), request = frame.request;
      const slot = select(request.rootId), head = slot.store.describe();
      if (request.replica !== replica || head.generation !== request.generation) throw new Error('Compaction control belongs to another volunteer or generation');
      live();
      if (request.action === 'retain') slot.store.retainCompactionAnchor(frame.certificate, slot.store.reviewDigest());
      parseHistoryCompactionControlRequest(request, context, genesisId, now()); live();
      const response = createHistoryCompactionControlResponse(frame, slot.store.describe(), slot.store.compactionAnchor(), context, signingKey);
      parseHistoryCompactionControlRequest(request, context, genesisId, now()); live(); return response;
    },
    /** Local maintenance approval covers every generation and provisioning
     * promise. Remote control uses its separate fresh owner authorization. */
    retainCompactionCheckpoint(raw: unknown, approvedReviewDigest: string) { return run(() => {
      live();
      const certificate = parseHistoryCompactionAttestation(raw, context, genesisId), proposal = certificate.proposal;
      const slot = select(proposal.rootId), previous = slot.store.compactionAnchor()?.proposal;
      const retry = previous?.sequence === proposal.sequence && previous.envelopeId === proposal.envelopeId;
      if (!retry && (slot !== [...slots.values()].at(-1) || approvedReviewDigest !== reviewDigest())) {
        throw new Error('Compaction checkpoint needs current whole-service review');
      }
      return slot.store.retainCompactionAnchor(certificate, slot.store.reviewDigest());
    }); },
    retainedCompactionCheckpoint(rootId: string) { return select(rootId).store.compactionAnchor(); },
    planPool(count: number) { return poolPreparation(count).review; },
    enablePool(count: number, approvedDigest: string) { return run(() => {
      const { review } = poolPreparation(count);
      if (approvedDigest !== review.approvalDigest) throw new Error('Volunteer pool selection changed; review again');
      reserveHistoryPool(directory, count, maxBytes);
      try {
        pool = openHistoryVolunteerPool({ directory, localKey, context, genesisId, replica, maxBytes, maxBlocks, initializeSlots: count });
        closeStores(); openStores();
      } catch (error) { failed = true; throw error; }
      return review;
    }); },
    planGenerationRetirement(value: unknown) { return generationRetirement(value).review; },
    retireGenerations(value: unknown, approvedDigest: string) { return run(() => {
      const { state, poolState, review } = generationRetirement(value);
      if (approvedDigest !== review.approvalDigest) throw new Error('Volunteer generations changed; review retirement again');
      try {
        if (poolState) pool!.beginRetirement(poolState.frontier!, poolState.retiredGenerations);
        else frontier!.retain(state!); // Authoritative commit precedes close, reopen and every unlink.
        closeStores(); openStores();
      } catch (error) { failed = true; throw error; }
      return review;
    }); },
    /** Offline local maintenance: review binds every retained generation and provisioning promise. */
    planPrefixRetirement(rootId: string) { return prefixRetirement(rootId).review; },
    retirePrefix(rootId: string, approvedDigest: string) { return run(() => {
      const { slot, local, review } = prefixRetirement(rootId);
      if (approvedDigest !== review.approvalDigest) throw new Error('Volunteer history changed; review prefix retirement again');
      slot.store.retirePrefix(local.approvalDigest); return review;
    }); },
    /** Attests to retained ciphertext and independently enrolled ancestry only.
     * No files, manifests, barriers or admission state are changed by this vote. */
    endorseCompactionCheckpoint,
    checkpoint(raw: unknown) { return select(requestRoot(raw)).checkpoint.exchange(raw); },
    exchange(raw: unknown) { return select(requestRoot(raw)).agreement.exchange(raw); },
    transfer(raw: unknown) {
      const authorization = raw && typeof raw === 'object' && 'authorization' in raw ? raw.authorization : undefined;
      return select(requestRoot(authorization)).agreement.transfer(raw);
    },
    provision(raw: unknown) { return run(() => {
      live();
      const request = parseHistoryProvisionRequest(raw, context, (options.now ?? Date.now)());
      if (request.replica !== replica) throw new Error('History provision request belongs to another volunteer');
      const slot = select(request.root.proposal.rootId), state = slot.provisioner.read();
      if (state.parentGeneration !== request.root.proposal.generation) throw new Error('History provision request belongs to another generation');
      if (state.root && historyContinuationRootId(state.root) !== historyContinuationRootId(request.root)) throw new Error('Another child already occupies this provision slot');
      if (state.phase !== 'ready' && retainedStores().length >= generationLimit()) throw new Error('History volunteer generation capacity exceeded');
      if (state.phase === 'empty' && options.acceptNew?.() === false) throw new Error('History owner paused new storage');
      if (pool) {
        const pooled = pool.read(); if (pooled.phase !== 'ready') throw new Error('History pool cleanup is incomplete');
        if (state.phase === 'empty' && readdirSync(historyPoolPaths(directory, pooled.slots, request.root.generation).base).length) {
          throw new Error('History pool destination is occupied; retain its history');
        }
      }
      // A child must also be able to retain its next empty slot before activation.
      // Otherwise publication could succeed but leave the volunteer unable to reopen.
      reserveHistoryProvisionJournal(provisionPath(historyContinuationRootId(request.root), request.root.generation));
      const receipt = slot.provisioner.provision(request);
      grow(); // Route the ready child and open its already funded successor slot before replying.
      return receipt;
    }); },
    /** Local maintenance approval, including promises/provisioning in every retained generation. */
    reviewDigest,
    /** Aggregate local health only; no token, binding or peer activity is returned. */
    describe() {
      live(); const entries = [...slots.values()];
      return { generations: retainedStores().length, latest: entries.at(-1)!.store.describe(),
        provisioning: entries.at(-1)!.provisioner.read().phase, maximumGenerations: generationLimit(), ...(pool ? { poolSlots: pool.read().slots } : {}) };
    },
    health(): HistoryVolunteerHealth {
      live(); const stores = retainedStores().map(store => store.storageUsage()), current = stores.at(-1)!;
      const sum = (key: 'retainedBlocks' | 'stagedBlocks' | 'retainedCiphertextBytes' | 'manifestReserveBytes' | 'reservedBytes') => stores.reduce((n, value) => n + value[key], 0);
      return { generations: stores.length, maximumGenerations: generationLimit(),
        retainedBlocks: sum('retainedBlocks'), stagedBlocks: sum('stagedBlocks'), retainedCiphertextBytes: sum('retainedCiphertextBytes'),
        manifestReserveBytes: sum('manifestReserveBytes'), reservedBytes: sum('reservedBytes'),
        currentGenerationReservedBytes: current.reservedBytes, currentGenerationBlocks: current.retainedBlocks + current.stagedBlocks,
        maximumGenerationBytes: current.maximumBytes, maximumGenerationBlocks: current.maximumBlocks, maximumAncestryBytes: current.maximumAncestryBytes };
    },
    close,
  };
}
