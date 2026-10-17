import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../../protected-policy-observer.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica, exchangeHistoryCheckpoint, type HistoryCheckpointTransport } from '../../history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from '../../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { listenHistoryAgreementReplica } from '../../history-agreement-exchange.js';
import { createHistoryCheckpointRecovery } from '../../history-checkpoint-recovery.js';
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { policyObserverFixture } from './policy-observer-fixture.js';

export async function policyObserverRestoreFixture(register: (close: () => void | Promise<void>) => void) {
  const f = await policyObserverFixture(); register(f.close);
  const key = f.options.encryptionKey, owner = f.keys[0], enrolled = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: owner, encryptionKey: key, policy: f.first, now: () => f.now });
  const context = enrolled.context, localKeys = context.members.map(() => randomBytes(32));
  const signingKeys = context.members.map(publicKey => f.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === publicKey)!);
  type Store = ReturnType<typeof openHistoryCheckpointStore>;
  const stores = context.members.map((replica, i) => {
    const store = openHistoryCheckpointStore({ directory: join(f.directory, `g0-r${i}`), localKey: localKeys[i], context, replica,
      rootId: historyCheckpointEnvelopeId(enrolled.root), generation: 0, initialize: enrolled.root }); register(store.close); return store;
  });
  const generations: Array<Array<Store | undefined>> = [stores];
  const routes = context.members.map(() => new Map<string, ReturnType<typeof createHistoryCheckpointReplica>>());
  function route(store: Store, i: number) {
    const role = createHistoryCheckpointReplica({ context, store, signingKey: signingKeys[i] }); register(role.close); routes[i].set(store.describe().rootId, role);
  }
  stores.forEach(route);
  const members: Array<{ publicKey: string; endpoint: string }> = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryCheckpointReplica({ close() {}, exchange(value) {
      const rootId = (value as { request?: { rootId?: string } })?.request?.rootId;
      const role = rootId && routes[i].get(rootId); if (!role) throw new Error('Unknown enrolled test generation'); return role.exchange(value);
    } }); register(listener.close); members.push({ publicKey: context.members[i], endpoint: listener.endpoint });
  }
  let online = 5, loseReplies = false;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    if (context.members.indexOf(member.publicKey) >= online) throw new Error('Volunteer unavailable');
    const reply = await exchangeHistoryCheckpoint(member, frame, signal);
    if (loseReplies && frame.request.action === 'append') throw new Error('Stored reply lost');
    return reply;
  };
  const options = { directory: join(f.directory, 'owner'), encryptionKey: key, context: f.context, signingKey: owner,
    historyContext: context, root: enrolled.root as HistoryCheckpointEnvelope, members, transport, timeoutMs: 10000, now: () => f.now };
  const observer = await openProtectedPolicyObserver({ ...options, mode: 'create-new' }); register(observer.close); await observer.ready();
  let currentRoot: HistoryCheckpointEnvelope = enrolled.root;
  const ancestry: HistoryCheckpointEnvelope[] = [];
  async function recover() {
    const generation = currentRoot.generation, rootId = historyCheckpointEnvelopeId(currentRoot), nextGeneration = generation + 1;
    const recovery = createHistoryCheckpointRecovery({ directory: join(f.directory, `freeze-${generation}`), context, localKey: key, signingKey: owner,
      rootId, generation, nextGeneration, members, transport, initialize: true, timeoutMs: 10000 }); register(recovery.close);
    const preparation = await recovery.prepare(), proposal = createHistorySuccessorProposal(preparation, context, owner);
    const agreementMembers: typeof members = [];
    const listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
    for (let i = 0; i < 5; i++) {
      const store = generations[generation][i];
      const role = store && createHistoryAgreementReplica({ context, store, signingKey: signingKeys[i] }); if (role) register(role.close);
      const listener = await listenHistoryAgreementReplica({ exchange(value) {
        if (!role || i >= online) throw new Error('Volunteer unavailable'); return role.exchange(value);
      }, transfer(value) { if (!role || i >= online) throw new Error('Volunteer unavailable'); return role.transfer(value); } });
      register(listener.close); listeners.push(listener); agreementMembers.push({ publicKey: context.members[i], endpoint: listener.endpoint });
    }
    const coordinator = createHistoryAgreementCoordinator({ directory: join(f.directory, `agreement-${generation}`), localKey: key, context,
      signingKey: owner, rootId, generation, nextGeneration, members: agreementMembers, initialize: { proposal },
      timeoutMs: 10000, historyTransfer: { retained: () => preparation.envelopes } }); register(coordinator.close);
    const certificate = await coordinator.run(), selected = coordinator.read().selected!;
    const root = createHistoryContinuationRoot(selected, certificate, context);
    // Fresh fixture has one recovery proposer. The selected chain is the actual
    // ciphertext downloaded during freeze, rather than fabricated owner state.
    if (selected.envelopeId !== proposal.envelopeId) throw new Error('Fixture selected a different chain');
    ancestry.push(...preparation.envelopes);
    const children: Array<Store | undefined> = [];
    for (const vote of certificate.votes) {
      const i = context.members.indexOf(vote.request.replica), parent = generations[generation][i]!;
      parent.activateContinuation(root);
      const store = openHistoryCheckpointStore({ directory: join(f.directory, `g${nextGeneration}-r${i}`), localKey: localKeys[i], context,
        replica: context.members[i], rootId: historyCheckpointEnvelopeId(root), generation: nextGeneration, initialize: root, parent });
      register(store.close); children[i] = store; route(store, i);
    }
    generations.push(children); currentRoot = root;
    for (const listener of listeners) await listener.close(); coordinator.close();
    return { root, preparation, blocks: [...ancestry],
      replayOptions: { context: f.context, historyContext: context, genesisId: historyCheckpointEnvelopeId(enrolled.root),
        proposal: root.proposal, encryptionKey: key, blocks: [...ancestry] },
      restoreOptions: { directory: join(f.directory, `restored-${nextGeneration}`), context: f.context, historyContext: context,
        genesisId: historyCheckpointEnvelopeId(enrolled.root), continuation: root, encryptionKey: key, blocks: [...ancestry] },
      openOptions: { ...options, directory: join(f.directory, `restored-${nextGeneration}`), root, genesis: enrolled.root } };
  }
  return { ...f, key, owner, enrolled, options, observer, stores, generations, members, transport, recover,
    online(value: number) { online = value; }, loseReplies(value: boolean) { loseReplies = value; } };
}
