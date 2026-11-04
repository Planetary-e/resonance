import { afterEach, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, type SigningKeyPair } from '@resonance/core';
import { signAdmissionPolicy, admissionPolicyDigest } from '@resonance/core/admission-policy';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionWitnessSetId, createAdmissionWitnessVote, parseAdmissionWitnessSet,
  verifyAdmissionSpendCertificate, type AdmissionSpendClaim, type AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { parseWitnessFreezeReport, witnessHandoffObserverPins, createWitnessDrainReport, witnessHandoffDigest } from '@resonance/core/admission-witness-handoff';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { enrollProtectedWitnessEpoch, proposeProtectedWitnessHandoff, freezeProtectedWitness,
  prepareTerminalProtectedWitness, prepareProtectedWitnessTransfer, installProtectedWitnessTransfer, installProtectedCoordinatorTransfer, type WitnessTerminalPins, type WitnessTerminalEvidence, retainOriginalWitnessCertificate } from '../protected-witness-handoff.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');

import type {RecoveryAllocationManifest} from '../sustainable-recovery-manifest.js';

export function finiteRecoveryManifest(root:string):RecoveryAllocationManifest {
 const owners:Array<{owner:string;role:'observer'|'witness'|'issuer'|'wallet'}>=[...Array.from({length:5},(_,i)=>({owner:`observer-${i}`,role:'observer' as const})),
  ...Array.from({length:10},(_,i)=>({owner:`witness-${i}`,role:'witness' as const})),{owner:'issuer',role:'issuer'},{owner:'wallet',role:'wallet'}];
 return {version:1,root,transitions:2,returns:5,owners:owners.map(o=>({...o,L:65536,D:524288,P:65536,C:262144,F:32768,closure:{original:{count:40,bytes:136000},frame:{count:28,bytes:22000},policy:{count:2,maximumBytes:16384},activation:{count:2,maximumBytes:12288}}})),operatorCopies:0,originals:[],outside:[],work:{L:65536,D:524288,V:262144,H:65536,J:262144}};
}

interface TerminalFixture {
  actor: { key: SigningKeyPair; encryptionKey: Uint8Array; context: HistoryCheckpointContext;
    root: HistoryCheckpointEnvelope; stores: ReturnType<typeof openHistoryCheckpointStore>[];
    history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>; reopen(): Promise<void> };
  actors: TerminalFixture['actor'][]; observerKeys: SigningKeyPair[]; coordinator: SigningKeyPair;
  proposal: ReturnType<typeof proposeProtectedWitnessHandoff>; directory: string;
  funding: ReturnType<typeof openStorageReservationAuthority>; policy: Awaited<ReturnType<typeof signAdmissionPolicy>>;
  authorityKey: SigningKeyPair; observerContext: import('@resonance/core/admission-policy-freshness').AdmissionPolicyObservers;
  row(): { issuerKey: string; spend: string; action: string; binding: string };
  failAppends(value: boolean): void; failPayloads(value: boolean): void;
  pauseAppends(gate?: Promise<void>, entered?: () => void): void;
  run<T>(work: () => Promise<T>): Promise<T>;
}
export async function sustainableLegacyFixture(count = 8, lifetimes: { keyLifetimeMs?: number; policyLifetimeMs?: number } = {}): Promise<TerminalFixture> {
  const f = await policyObserverFixture({ keyLifetimeMs: lifetimes.keyLifetimeMs ?? 300000,
    policyLifetimeMs: lifetimes.policyLifetimeMs ?? 600000 }); cleanup.push(f.close);
  const directory = mkdtempSync(join(tmpdir(), 'terminal-witness-preparation-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const funding = openStorageReservationAuthority({ directory: join(directory, 'funding'), mode: 'create-new', limitBytes: 2 * 1024 ** 3 });
  cleanup.push(() => funding.close());
  const setup = async (): Promise<TerminalFixture> => {
    const old = Array.from({ length: 5 }, generateSigningKeyPair).sort((a,b)=>pub(a)<pub(b)?-1:1), next = Array.from({ length: 5 }, generateSigningKeyPair).sort((a,b)=>pub(a)<pub(b)?-1:1);
    const coordinator = generateSigningKeyPair();
    const makeSet = (keys: SigningKeyPair[], offset: number) => parseAdmissionWitnessSet({ version: 2, quorum: 4,
      epoch: randomBytes(32).toString('base64url'), observerContext: witnessHandoffObserverPins(f.context),
      members: keys.map((key, i) => ({ publicKey: pub(key), endpoint: `ws://127.0.0.1:${45000 + offset + i}/` })), coordinators: [pub(coordinator)] });
    const oldSet = makeSet(old, 0), newSet = makeSet(next, 10);
    const policy = await signAdmissionPolicy({ ...f.body, version: 2, archivedKeys: [],
      keys: [{ ...f.body.keys[0], witnesses: oldSet }] }, f.authority, f.key.secretKey);
    const observers = parseAdmissionPolicyObservers({ ...f.context, genesis: admissionPolicyHead(policy) });
    const limits = { maxPages: 128, maxEntries: 10000, maxArchiveBytes: 256 * 1024 ** 2,
      maxHistoryBytes: 256 * 1024 ** 2, maxTransitions: 128, maxPageReads: 1000, timeoutMs: 3000 };
    const actors = [];
    let failAppend = false, failReads = false;
    let appendGate: Promise<void> | undefined, onAppend: (() => void) | undefined;
    for (let index = 0; index < count; index++) {
      const key = index < 4 ? old[index] : next[index - 4], encryptionKey = randomBytes(32);
      const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends',
        historyId: randomBytes(32).toString('base64url'), owner: pub(key), authority: f.authority,
        policyDigest: `sha256:${admissionPolicyDigest(policy)}`, members: f.keys.map(pub).sort(), quorum: 4 };
      const replicas: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
      const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [];
      const transport: HistoryCheckpointTransport = async (member, frame) => {
        if (frame.request.action === 'append') {
          onAppend?.(); if (appendGate) await appendGate;
          if (failAppend) throw new Error('append unavailable');
        }
        if (failReads && frame.request.action === 'read' && context.members.indexOf(member.publicKey) >= 3) throw new Error('payload unavailable');
        return replicas[context.members.indexOf(member.publicKey)].exchange(frame);
      };
      const protection = { context, signingKey: key, transport, maxArchiveBytes: 4 * 1024 ** 2,
        members: context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${46000 + i}/` })) };
      const options = { directory: join(directory, `owner-${index}`), encryptionKey, authority: f.authority,
        policy, now: () => f.now, protection };
      let history = await openProtectedAdmissionSpendHistory({ ...options, initialize: true, protection: { ...protection, initializeWriter: true } });
      cleanup.push(() => history.close());
      const root = history.enrollment().root;
      mkdirSync(join(directory, `replicas-${index}`));
      for (let i = 0; i < 5; i++) {
        const store = openHistoryCheckpointStore({ directory: join(directory, `replicas-${index}`, `${i}`), context,
          replica: context.members[i], localKey: randomBytes(32), rootId: historyCheckpointEnvelopeId(root),
          generation: 0, initialize: root, maxBytes: 6 * 1024 ** 2 });
        stores.push(store); cleanup.push(store.close);
        const replica = createHistoryCheckpointReplica({ context, store, signingKey: f.keys.find(k => pub(k) === context.members[i])! });
        replicas.push(replica); cleanup.push(replica.close);
      }
      await history.ready();
      await history.backfillPolicyProof({ version: 1, kind: 'genesis', policy },
        { context: observers, installed: observers.genesis, observed: observers.genesis }, limits);
      const roles = { witness: { version: 2 as const, witness: pub(key), votes: [], retiredIssuerKeys: [] }, coordinator: null };
      if (index < 4) await history.captureRoles(roles, (await history.planRoleCapture(roles)).approvalDigest);
      await enrollProtectedWitnessEpoch(history, policy);
      actors.push({ key, encryptionKey, stores, get history() { return history; },
        async reopen() { history.close(); history = await openProtectedAdmissionSpendHistory(options); }, context, root });
    }
    const actor = actors[0];
    const proposal = proposeProtectedWitnessHandoff(actor.history, policy.activeKey, newSet, f.key);

    const row = () => ({ issuerKey: policy.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: `admreq_${'b'.repeat(86)}` });
    return { observerContext: observers, actor, actors, observerKeys: f.keys, coordinator, proposal, row, directory, funding, policy, authorityKey: f.key,
      failAppends(value: boolean) { failAppend = value; }, failPayloads(value: boolean) { failReads = value; },
      pauseAppends(gate?: Promise<void>, entered?: () => void) { appendGate = gate; onAppend = entered; },
      run<T>(work: () => Promise<T>) { return withStorageReservationAuthority(funding, work); } };
  };
  return withStorageReservationAuthority<Promise<TerminalFixture>>(funding, setup);
}


/** Declare exact current original bytes; future signed objects use the enforced
 * finite prospective quotas. Every prospective recipient retains all originals. */
export function declareSustainableOriginals(manifest:import('../sustainable-recovery-manifest.js').RecoveryAllocationManifest,
  originals:WitnessTerminalEvidence[],genesis:unknown,votes:unknown[]=[]){
  const objects=new Map<string,Buffer>(),add=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));objects.set(`sha256:${createHash('sha256').update(bytes).digest('hex')}`,bytes);};
  for(const pair of originals)for(const block of pair.evidence.blocks)add(block);add(genesis);
  for(const vote of votes)add({kind:'vote',vote});
  manifest.originals=manifest.owners.filter(o=>o.role==='witness').flatMap(owner=>[...objects].map(([id,bytes])=>({id,owner:owner.owner,privacyScope:owner.owner,bytes:bytes.length})));
}
