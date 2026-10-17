import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionPolicyDigest, admissionKeyFingerprint, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createHistoryFreeze, historyCheckpointEnvelopeId, sealHistoryCheckpoint, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, type HistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica, exchangeHistoryCheckpoint, type HistoryCheckpointTransport } from '../../history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from '../../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { encodeAdmissionHistoryRecord, reduceAdmissionHistory, type AdmissionHistoryImage, type AdmissionHistoryMutation } from '../../admission-history-records.js';
import { witnessFixture } from './admission-witness-fixture.js';
import { historyCheckpointFixture } from './history-checkpoint-fixture.js';

let issuers: Promise<[Awaited<ReturnType<typeof witnessFixture>>, Awaited<ReturnType<typeof witnessFixture>>]> | undefined;
export async function admissionRestoreFixture(sockets = false, tail?: (image: AdmissionHistoryImage, at: number) => unknown) {
  const [oldIssuer, issuer] = await (issuers ??= Promise.all([witnessFixture(), witnessFixture()]));
  const h = historyCheckpointFixture(), time = Date.now(), directory = mkdtempSync(join(tmpdir(), 'admission-restore-'));
  const cleanup: Array<() => void | Promise<void>> = [];
  const { witnesses: _oldWitnesses, ...old } = oldIssuer.body.keys[0], { witnesses: _newWitnesses, ...fresh } = issuer.body.keys[0];
  const oldKey = admissionKeyFingerprint(old.profile.issuerPublicKey), freshKey = admissionKeyFingerprint(fresh.profile.issuerPublicKey);
  const body = { ...oldIssuer.body, issuedAt: time - 1000, expiresAt: time + 86400000, activeKey: freshKey,
    keys: [{ ...old, notBefore: time - 1000, issueUntil: time + 1000, spendUntil: time + 2000, retryUntil: time + 3000 },
      { ...fresh, notBefore: time - 1000, issueUntil: time + 3600000, spendUntil: time + 7200000, retryUntil: time + 10800000 }] };
  const initialPolicy = await signAdmissionPolicy(body, oldIssuer.authority, oldIssuer.authorityKey.secretKey);
  const policy = await signAdmissionPolicy({ ...body, revision: 2 }, oldIssuer.authority, oldIssuer.authorityKey.secretKey);
  const context = { ...h.context, authority: oldIssuer.authority, policyDigest: `sha256:${admissionPolicyDigest(initialPolicy)}` };
  const binding = createAdmissionRequestBindingV2('search', { query: 'already accepted before loss' });
  const token = await issuer.token(), capability = presentBlindAdmissionTokenV2(token, issuer.scope, 'search', binding);
  const currentRow = { spend: (await verifyBlindAdmissionTokenV2(capability, issuer.scope, 'search', binding, issuer.keys.publicKey))!,
    action: 'search', binding, issuerKey: freshKey };
  const legacy = { spend: randomBytes(32).toString('base64url'), action: 'search', binding, issuerKey: null };
  const oldRow = { ...currentRow, spend: randomBytes(32).toString('base64url'), issuerKey: oldKey };
  let image: AdmissionHistoryImage = { version: 1, kind: 'admission-spend-checkpoint', policy: initialPolicy,
    state: { version: 2, authority: context.authority, spends: [legacy], retiredIssuerKeys: [] } };
  const root = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: encodeAdmissionHistoryRecord(image), encryptionKey: h.key, signingKey: h.owner });
  const genesisBlocks: HistoryCheckpointEnvelope[] = [root];
  for (const mutation of [
    { version: 1, kind: 'spend', at: time, row: oldRow }, { version: 1, kind: 'spend', at: time, row: currentRow },
    { version: 1, kind: 'retire', at: time + 3000, issuerKey: oldKey }, { version: 1, kind: 'policy', at: time + 3000, policy },
  ] as AdmissionHistoryMutation[]) {
    image = (await reduceAdmissionHistory(image, mutation)).image;
    const previous = genesisBlocks.at(-1)!;
    genesisBlocks.push(sealHistoryCheckpoint({ context, header: { kind: 'delta', generation: 0, sequence: previous.sequence + 1,
      previous: historyCheckpointEnvelopeId(previous) }, plaintext: encodeAdmissionHistoryRecord(mutation), encryptionKey: h.key, signingKey: h.owner }));
  }
  if (tail) {
    const record = tail(structuredClone(image), time + 10000), previous = genesisBlocks.at(-1)!;
    genesisBlocks.push(sealHistoryCheckpoint({ context, header: { kind: ['admission-policy-checkpoint', 'admission-state-checkpoint'].includes((record as { kind: string })?.kind) ? 'checkpoint' : 'delta',
      generation: 0, sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous) },
      plaintext: Buffer.from(JSON.stringify(record)), encryptionKey: h.key, signingKey: h.owner }));
  }
  type Store = ReturnType<typeof openHistoryCheckpointStore>;
  const generations: Store[][] = [context.members.map((replica, i) => {
    const store = openHistoryCheckpointStore({ directory: join(directory, `g0-r${i}`), context, replica, localKey: h.localKey,
      generation: 0, rootId: historyCheckpointEnvelopeId(root), initialize: root });
    cleanup.push(() => store.close()); genesisBlocks.slice(1).forEach(b => store.append(b)); return store;
  })];
  const roles = generations.map(stores => stores.map((store, i) => {
    const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); cleanup.push(() => role.close()); return role;
  }));
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${41000 + i}/history-checkpoint` }));
  let current = 0, continuation: HistoryContinuationRoot, online = 5, calls = 0;
  const exchange = (i: number, value: any): HistoryExchangeResponse => {
    const generation = generations.findIndex(stores => stores[i].describe().rootId === value?.request?.rootId);
    if (generation < 0) throw new Error('Unenrolled test generation'); return roles[generation][i].exchange(value);
  };
  if (sockets) for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryCheckpointReplica({ exchange: raw => exchange(i, raw), close() {} });
    members[i].endpoint = listener.endpoint; cleanup.push(() => listener.close());
  }
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    calls++; const i = context.members.indexOf(member.publicKey); if (i >= online) throw new Error('offline');
    return sockets ? exchangeHistoryCheckpoint(member, frame, signal) : exchange(i, frame);
  };
  async function certify() {
    const stores = generations[current], longest = stores.map(s => s.read().envelopes).sort((a, b) => b.length - a.length)[0];
    // Model an online quorum with complete compatible history before freezing this test generation.
    for (const store of stores) for (const block of longest.slice(store.read().envelopes.length)) store.append(block);
    const issuedAt = Date.now(), challenge = randomBytes(32).toString('base64url');
    const rootId = historyCheckpointEnvelopeId(longest[0]), freeze = createHistoryFreeze(context, current, current + 1, challenge, h.owner);
    const receipts = roles[current].map((role, i) => role.exchange({ request: createHistoryExchangeRequest({ action: 'freeze', rootId,
      generation: current, replica: context.members[i], challenge, issuedAt, expiresAt: issuedAt + 30000,
      sequence: current + 1, envelopeId: null }, context, h.owner), envelope: null, freeze }));
    const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation: current,
      nextGeneration: current + 1, receipts: receipts.slice(0, 4), envelopes: longest }, context, h.owner);
    const voters = stores.map((store, i) => createHistoryAgreementReplica({ context, store, signingKey: h.memberKeys[i] }));
    const coordinator = createHistoryAgreementCoordinator({ directory: join(directory, `agreement-${current}`), localKey: h.localKey,
      context, signingKey: h.owner, rootId, generation: current, nextGeneration: current + 1, members,
      initialize: { proposal }, transport: async (member, frame) => voters[context.members.indexOf(member.publicKey)].exchange(frame) });
    try { continuation = createHistoryContinuationRoot(proposal, await coordinator.run(), context); }
    finally { coordinator.close(); voters.forEach(v => v.close()); }
    const children = stores.map((parent, i) => {
      parent.activateContinuation(continuation);
      const store = openHistoryCheckpointStore({ directory: join(directory, `g${current + 1}-r${i}`), context, replica: context.members[i],
        localKey: h.localKey, generation: current + 1, rootId: historyCheckpointEnvelopeId(continuation), initialize: continuation, parent });
      cleanup.push(() => store.close()); return store;
    });
    generations.push(children); roles.push(children.map((store, i) => {
      const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); cleanup.push(() => role.close()); return role;
    }));
    current++; return continuation;
  }
  await certify();
  return { ...h, context, root, directory, time, issuer, initialPolicy, policy, currentRow, legacy, oldKey, image, token, capability, binding,
    members, transport, generations, roles, certify, current: () => current, continuation: () => continuation,
    selected: () => generations.slice(0, current).flatMap(stores => stores[0].read().envelopes),
    replayOptions: () => ({ context, genesisId: historyCheckpointEnvelopeId(root), proposal: continuation.proposal, encryptionKey: h.key,
      blocks: generations.slice(0, current).flatMap(stores => stores[0].read().envelopes) }),
    restoreOptions: (destination = join(directory, 'restored-owner')) => ({ directory: destination, context,
      genesisId: historyCheckpointEnvelopeId(root), encryptionKey: h.key, continuation, policy, now: () => time + 10000,
      blocks: generations.slice(0, current).flatMap(stores => stores[0].read().envelopes) }),
    online: (count: number) => { online = count; }, calls: () => calls,
    async close() { for (const close of cleanup.reverse()) await close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
