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
import { historyDigest, historyCheckpointEnvelopeId, isHistoryDigest, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
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
  const slots = new Map<string, Slot>(); let genesis: Store | undefined, closed = false, failed = false;
  const slotName = (rootId: string) => `successors-${rootId.slice(7)}`;
  const shared = { context, signingKey, localKey, now: options.now, maxBytes, maxBlocks,
    acceptNew: options.acceptNew };
  function live() { if (closed || failed) throw new Error('History volunteer service is closed or needs reopening'); }
  function close() {
    if (closed) return; closed = true;
    for (const slot of [...slots.values()].reverse()) { slot.checkpoint.close(); slot.agreement.close(); slot.provisioner.close(); }
    genesis?.close(); signingKey.secretKey.fill(0); localKey.fill(0);
  }
  function add(store: Store) {
    if (slots.size >= maxGenerations) throw new Error('History volunteer generation capacity exceeded');
    const head = store.describe(), path = join(directory, slotName(head.rootId));
    const absent = !existsSync(join(path, HISTORY_PROVISION_FILENAME));
    // Activation is durable before any child can exist or accept a write. A missing slot after
    // activation is lost history, not a fresh enrollment. Never infer an empty child in that case.
    if (absent && store.activatedContinuation()) throw new Error('Activated history is missing its successor journal');
    let provisioner: Slot['provisioner'] | undefined, checkpoint: Slot['checkpoint'] | undefined, agreement: Slot['agreement'] | undefined;
    try {
      provisioner = openHistoryGenerationProvisioner({ ...shared, directory: path, parent: store, initialize: absent, resumePristine: absent });
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
      const known = new Set(['genesis', ...[...slots.keys()].map(slotName)]);
      if (readdirSync(directory).some(name => !known.has(name))) throw new Error('Unregistered volunteer history contents require inspection');
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
    live(); return historyDigest(JSON.stringify([...slots.values()].map(slot => [slot.store.reviewDigest(), slot.provisioner.read()])));
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
    const genesisPath = join(directory, 'genesis');
    if (existsSync(genesisPath) && !lstatSync(genesisPath).isDirectory()) throw new Error('Volunteer genesis must be a real directory');
    genesis = openHistoryCheckpointStore({ ...shared, directory: genesisPath, replica, generation: 0,
      rootId: options.genesisId, initialize: options.initialize });
    add(genesis); grow();
  } catch (error) { close(); throw error; }
  return {
    /** Network control requires its own fresh owner authorization. No request can
     * delete ciphertext, lower a stored anchor, replace a suffix or clear a barrier. */
    compaction(raw: unknown) {
      if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'history-compaction-proposal') return endorseCompactionCheckpoint(raw);
      live();
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
      if (state.phase !== 'ready' && slots.size >= maxGenerations) throw new Error('History volunteer generation capacity exceeded');
      if (state.phase === 'empty' && options.acceptNew?.() === false) throw new Error('History owner paused new storage');
      // A child must also be able to retain its next empty slot before activation.
      // Otherwise publication could succeed but leave the volunteer unable to reopen.
      reserveHistoryProvisionJournal(join(directory, slotName(historyContinuationRootId(request.root))));
      const receipt = slot.provisioner.provision(request);
      grow(); // Route the ready child and open its already funded successor slot before replying.
      return receipt;
    }); },
    /** Local maintenance approval, including promises/provisioning in every retained generation. */
    reviewDigest,
    /** Aggregate local health only; no token, binding or peer activity is returned. */
    describe() {
      live(); const entries = [...slots.values()];
      return { generations: entries.length, latest: entries.at(-1)!.store.describe(),
        provisioning: entries.at(-1)!.provisioner.read().phase, maximumGenerations: maxGenerations };
    },
    health(): HistoryVolunteerHealth {
      live(); const stores = [...slots.values()].map(slot => slot.store.storageUsage()), current = stores.at(-1)!;
      const sum = (key: 'retainedBlocks' | 'stagedBlocks' | 'retainedCiphertextBytes' | 'manifestReserveBytes' | 'reservedBytes') => stores.reduce((n, value) => n + value[key], 0);
      return { generations: stores.length, maximumGenerations: maxGenerations,
        retainedBlocks: sum('retainedBlocks'), stagedBlocks: sum('stagedBlocks'), retainedCiphertextBytes: sum('retainedCiphertextBytes'),
        manifestReserveBytes: sum('manifestReserveBytes'), reservedBytes: sum('reservedBytes'),
        currentGenerationReservedBytes: current.reservedBytes, currentGenerationBlocks: current.retainedBlocks + current.stagedBlocks,
        maximumGenerationBytes: current.maximumBytes, maximumGenerationBlocks: current.maximumBlocks, maximumAncestryBytes: current.maximumAncestryBytes };
    },
    close,
  };
}
