/** One operator-enrolled history, retaining and routing every certified generation across restarts. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { openHistoryCheckpointStore } from './history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from './history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from './history-checkpoint-agreement.js';
import { HISTORY_PROVISION_FILENAME, openHistoryGenerationProvisioner } from './history-generation-provisioner.js';
import type { HistoryVolunteerHealth } from './history-health.js';

export function openHistoryVolunteerService(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  /** Independently retained genesis pin, never recovered from this directory or a peer. */
  genesisId: string; initialize?: HistoryCheckpointEnvelope;
  maxBytes?: number; maxBlocks?: number; maxGenerations?: number; acceptNew?: () => boolean; now?: () => number;
}) {
  const context = parseHistoryCheckpointContext(options.context), maxGenerations = options.maxGenerations ?? 65;
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 65) throw new Error('Invalid volunteer generation capacity');
  const signingKey = copyAdmissionSigningKey(options.signingKey), localKey = Buffer.from(options.localKey);
  const replica = Buffer.from(signingKey.publicKey).toString('base64url'), directory = options.directory;
  type Store = ReturnType<typeof openHistoryCheckpointStore>;
  type Slot = { store: Store; provisioner: ReturnType<typeof openHistoryGenerationProvisioner>;
    checkpoint: ReturnType<typeof createHistoryCheckpointReplica>; agreement: ReturnType<typeof createHistoryAgreementReplica> };
  const slots = new Map<string, Slot>(); let genesis: Store | undefined, closed = false, failed = false;
  const slotName = (rootId: string) => `successors-${rootId.slice(7)}`;
  const shared = { context, signingKey, localKey, now: options.now, maxBytes: options.maxBytes, maxBlocks: options.maxBlocks,
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
  try {
    if (!context.members.includes(replica) || localKey.length !== 32) throw new Error('Invalid volunteer enrollment keys');
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
    checkpoint(raw: unknown) { return select(requestRoot(raw)).checkpoint.exchange(raw); },
    exchange(raw: unknown) { return select(requestRoot(raw)).agreement.exchange(raw); },
    transfer(raw: unknown) {
      const authorization = raw && typeof raw === 'object' && 'authorization' in raw ? raw.authorization : undefined;
      return select(requestRoot(authorization)).agreement.transfer(raw);
    },
    provision(raw: unknown) {
      const root = raw && typeof raw === 'object' && 'root' in raw ? raw.root : null;
      const proposal = root && typeof root === 'object' && 'proposal' in root ? root.proposal : null;
      const slot = select(proposal && typeof proposal === 'object' && 'rootId' in proposal ? proposal.rootId : undefined);
      if (slot.provisioner.read().phase !== 'ready' && slots.size >= maxGenerations) throw new Error('History volunteer generation capacity exceeded');
      const receipt = slot.provisioner.provision(raw);
      grow(); // Route the fully published child and prepare its unactivated slot before replying.
      return receipt;
    },
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
