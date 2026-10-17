import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { admissionPolicyDigest } from '@resonance/core/admission-policy';
import { admissionWitnessSetId, createAdmissionWitnessRequest, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { historyCheckpointFixture } from './history-checkpoint-fixture.js';
import { witnessFixture } from './admission-witness-fixture.js';
import { createAdmissionWitness, createAdmissionQuorumGate } from '../../admission-witness.js';
import { openProtectedAdmissionSpendHistory } from '../../protected-admission-history.js';
import { openAdmissionRoleCapture } from '../../admission-role-capture.js';
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { createHistoryAgreementReplica } from '../../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { prepareAdmissionHistoryRestore } from '../../admission-history-restore.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../../history-checkpoint-exchange.js';

export async function protectedRoleFixture(f: Awaited<ReturnType<typeof witnessFixture>>, maxArchiveBlocks?: number) {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'protected-roles-'));
  const cleanup: Array<() => unknown | Promise<unknown>> = [() => rmSync(directory, { recursive: true, force: true })];
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(f.policy)}` };
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${28000 + i}/history-checkpoint` }));
  const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [];
  const replicas: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
  let online = 5, loseReplies = false, loseAtOrAfter = 0, gate: (() => Promise<void>) | undefined, time = f.time;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    if (context.members.indexOf(member.publicKey) >= online) throw new Error('history member offline');
    if (gate && frame.request.action === 'append') await gate();
    const result = await exchangeHistoryCheckpoint(member, frame, signal);
    if (loseReplies && frame.request.action === 'append' && frame.request.sequence !== null && frame.request.sequence >= loseAtOrAfter) throw new Error('history reply lost'); return result;
  };
  const options = { directory: join(directory, 'owner'), encryptionKey: h.key, authority: f.authority, policy: f.policy, now: () => time,
    protection: { context, signingKey: h.owner, members, transport, timeoutMs: 1000, maxArchiveBlocks } };
  let selectedOptions = options;
  let history = await openProtectedAdmissionSpendHistory({ ...options, initialize: true, protection: { ...options.protection, initializeWriter: true } });
  cleanup.push(() => history.close()); const root = history.enrollment().root;
  for (let i = 0; i < 5; i++) {
    const store = openHistoryCheckpointStore({ directory: join(directory, `r${i}`), context, replica: context.members[i],
      localKey: h.localKey, rootId: historyCheckpointEnvelopeId(root), generation: 0, initialize: root });
    stores.push(store); cleanup.push(() => store.close());
    const replica = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] });
    replicas.push(replica); cleanup.push(() => replica.close());
    const listener = await listenHistoryCheckpointReplica({ exchange: frame => replicas[i].exchange(frame), close() {} }, { port: 0 });
    members[i].endpoint = listener.endpoint; cleanup.push(() => listener.close());
  }
  history.close(); history = await openProtectedAdmissionSpendHistory(options); await history.ready();
  const localOptions = { directory: options.directory, encryptionKey: h.key, policy: f.policy, now: () => time };
  const witnesses = f.witnesses.map((signingKey, i) => createAdmissionWitness({ ...localOptions,
    directory: i ? join(directory, `witness-${i}`) : options.directory, signingKey, initialize: true }));
  witnesses.forEach(w => cleanup.push(w.close));
  const claim = (): AdmissionSpendClaim => ({ setId: admissionWitnessSetId(f.policy.keys[0].witnesses!), issuerKey: f.policy.activeKey,
    spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${'a'.repeat(86)}` });
  const initial = claim(); witnesses[0].vote(createAdmissionWitnessRequest(initial, f.coordinators[0]));
  const coordinator = createAdmissionQuorumGate({ ...localOptions, signingKey: f.coordinators[0], initialize: true,
    transport: async (member, request) => witnesses[f.witnesses.findIndex(k => Buffer.from(k.publicKey).toString('base64url') === member.publicKey)].vote(request) });
  cleanup.push(coordinator.close); await coordinator.authorize(initial.issuerKey, initial.spend, initial);
  coordinator.close(); witnesses[0].close();
  const capture = async () => {
    const value = await openAdmissionRoleCapture({ directory: options.directory, encryptionKey: h.key, roles: ['witness', 'coordinator'], history });
    cleanup.push(value.close); return value;
  };
  const ancestry: HistoryCheckpointEnvelope[] = [];
  async function recover() {
    history.close(); const parents = [...stores], generation = parents[0].describe().generation;
    const blocks = parents.map(store => store.read().envelopes).sort((a, b) => b.length - a.length)[0];
    for (const store of parents) for (const block of blocks.slice(store.read().envelopes.length)) store.append(block);
    const issuedAt = Date.now(), challenge = randomBytes(32).toString('base64url'), rootId = historyCheckpointEnvelopeId(blocks[0]);
    const freeze = createHistoryFreeze(context, generation, generation + 1, challenge, h.owner);
    const receipts = replicas.map((replica, i) => replica.exchange({ request: createHistoryExchangeRequest({ action: 'freeze', rootId, generation,
      replica: context.members[i], challenge, issuedAt, expiresAt: issuedAt + 30000, sequence: generation + 1, envelopeId: null }, context, h.owner), envelope: null, freeze }));
    const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation, nextGeneration: generation + 1,
      receipts: receipts.slice(0, 4), envelopes: blocks }, context, h.owner);
    const voters = parents.map((store, i) => createHistoryAgreementReplica({ context, store, signingKey: h.memberKeys[i] }));
    const agreement = createHistoryAgreementCoordinator({ directory: join(directory, `agreement-${generation}`), localKey: h.localKey,
      context, signingKey: h.owner, rootId, generation, nextGeneration: generation + 1, members, initialize: { proposal },
      transport: async (member, frame) => voters[context.members.indexOf(member.publicKey)].exchange(frame) });
    let continuation;
    try { continuation = createHistoryContinuationRoot(proposal, await agreement.run(), context); }
    finally { agreement.close(); voters.forEach(v => v.close()); }
    for (let i = 0; i < 5; i++) {
      parents[i].activateContinuation(continuation);
      const store = openHistoryCheckpointStore({ directory: join(directory, `g${generation + 1}-r${i}`), context, replica: context.members[i],
        localKey: h.localKey, generation: generation + 1, rootId: historyCheckpointEnvelopeId(continuation), initialize: continuation, parent: parents[i] });
      stores[i] = store; cleanup.push(() => store.close());
      const replica = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); replicas[i] = replica; cleanup.push(replica.close);
    }
    ancestry.push(...blocks);
    const destination = join(directory, `restored-${generation + 1}`), preparation = await prepareAdmissionHistoryRestore({
      context, genesisId: historyCheckpointEnvelopeId(root), encryptionKey: h.key, blocks: ancestry, continuation,
      policy: selectedOptions.policy, now: selectedOptions.now, directory: destination });
    const previousDirectory = selectedOptions.directory;
    selectedOptions = { ...selectedOptions, directory: destination };
    rmSync(previousDirectory, { recursive: true });
    history = await openProtectedAdmissionSpendHistory({ ...selectedOptions, initialize: true,
      protection: { ...selectedOptions.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
    await history.ready(); return preparation.review;
  }
  return { ...h, context, root, directory, members, options, localOptions, stores, replicas, witnesses, initial, claim, capture,
    get history() { return history; },
    async reopen() { history.close(); history = await openProtectedAdmissionSpendHistory(selectedOptions); return history; },
    recover,
    async installPolicy(policy: typeof f.policy) {
      history.close(); selectedOptions = { ...selectedOptions, policy }; history = await openProtectedAdmissionSpendHistory(selectedOptions); await history.ready();
    },
    online(value: number) { online = value; }, loseReplies(value: boolean, minimumSequence = 0) { loseReplies = value; loseAtOrAfter = minimumSequence; },
    gate(value?: () => Promise<void>) { gate = value; }, time(value: number) { time = value; },
    async close() { for (const close of cleanup.reverse()) await close(); },
  };
}
