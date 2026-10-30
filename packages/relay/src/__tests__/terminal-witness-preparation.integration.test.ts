import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
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

interface TerminalFixture {
  actor: { key: SigningKeyPair; encryptionKey: Uint8Array; context: HistoryCheckpointContext;
    root: HistoryCheckpointEnvelope; stores: ReturnType<typeof openHistoryCheckpointStore>[];
    history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>; reopen(): Promise<void> };
  actors: TerminalFixture['actor'][]; observerKeys: SigningKeyPair[]; coordinator: SigningKeyPair;
  proposal: ReturnType<typeof proposeProtectedWitnessHandoff>; directory: string;
  funding: ReturnType<typeof openStorageReservationAuthority>; policy: Awaited<ReturnType<typeof signAdmissionPolicy>>;
  authorityKey: SigningKeyPair;
  row(): { issuerKey: string; spend: string; action: string; binding: string };
  failAppends(value: boolean): void; failPayloads(value: boolean): void;
  pauseAppends(gate?: Promise<void>, entered?: () => void): void;
  run<T>(work: () => Promise<T>): Promise<T>;
}
async function fixture(count = 1): Promise<TerminalFixture> {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const directory = mkdtempSync(join(tmpdir(), 'terminal-witness-preparation-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const funding = openStorageReservationAuthority({ directory: join(directory, 'funding'), mode: 'create-new', limitBytes: 2 * 1024 ** 3 });
  cleanup.push(() => funding.close());
  const setup = async (): Promise<TerminalFixture> => {
    const old = Array.from({ length: 5 }, generateSigningKeyPair), next = Array.from({ length: 5 }, generateSigningKeyPair);
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
    await freezeProtectedWitness(actor.history, proposal, actor.key, actor.encryptionKey);
    const row = () => ({ issuerKey: policy.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: `admreq_${'b'.repeat(86)}` });
    return { actor, actors, observerKeys: f.keys, coordinator, proposal, row, directory, funding, policy, authorityKey: f.key,
      failAppends(value: boolean) { failAppend = value; }, failPayloads(value: boolean) { failReads = value; },
      pauseAppends(gate?: Promise<void>, entered?: () => void) { appendGate = gate; onAppend = entered; },
      run<T>(work: () => Promise<T>) { return withStorageReservationAuthority(funding, work); } };
  };
  return withStorageReservationAuthority<Promise<TerminalFixture>>(funding, setup);
}

it('returns paired exact originals, fences shared writes and clean readiness, resumes exactly after reopen without successor', async () => {
  const n = await fixture(); await n.run(async () => {
    const row = n.row(); await n.actor.history.write(row);
    const result = await prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 });
    expect(result.evidence.report.head).toBe(n.actor.history.read().applied!.id);
    expect(result.preparation.envelopes.at(-1)).toEqual(result.evidence.blocks.at(-1));
    expect(result.preparation.receipts).toHaveLength(4);
    expect(parseWitnessFreezeReport(result.evidence.report, n.proposal)).toEqual(result.evidence.report);
    expect(n.actor.history.read().pending).toBeNull(); expect(n.actor.history.health().initialized).toBe(false);
    await expect(n.actor.history.write(n.row())).rejects.toThrow('readiness');
    await expect(n.actor.history.writeHandoffState(n.actor.history.handoffState()!)).rejects.toThrow('readiness');
    await expect(n.actor.history.ready()).rejects.toThrow('terminally prepared');
    await n.actor.reopen();
    await expect(n.actor.history.ready()).rejects.toThrow('terminally prepared');
    const resumed = await prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'resume', nextGeneration: 1 });
    expect(resumed.evidence).toEqual(result.evidence);
    expect(resumed.preparation.envelopes).toEqual(result.preparation.envelopes);
    expect(resumed.preparation.receipts[0].request.challenge).not.toBe(result.preparation.receipts[0].request.challenge);
    expect(n.actor.stores.filter(s => s.describe().freeze?.nextGeneration === 1).length).toBeGreaterThanOrEqual(4);
    for (const store of n.actor.stores) { expect(store.describe().generation).toBe(0); expect(store.describe().rootId).toBe(historyCheckpointEnvelopeId(n.actor.root)); }
  });
}, 30000);

it('serializes against in-flight writes and rejects writes queued during terminal preparation', async () => {
  const n = await fixture(); await n.run(async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    n.pauseAppends(gate, entered); const row = n.row(), writing = n.actor.history.write(row); await started;
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 })).rejects.toThrow('in progress');
    release(); await writing; n.pauseAppends();
    const preparation = prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 });
    const queued = Promise.resolve().then(() => n.actor.history.write(n.row()));
    await expect(queued).rejects.toThrow(/in progress|readiness/);
    const result = await preparation;
    expect(n.actor.history.read().image.state.spends).toContainEqual(row);
    expect(result.evidence.report.head).toBe(n.actor.history.read().applied!.id);
  });
}, 30000);

it('retains charged pending intent on completion failure and resumes its exact head', async () => {
  const n = await fixture(); await n.run(async () => {
    n.failAppends(true); const row = n.row();
    await expect(n.actor.history.write(row)).rejects.toThrow('Four durable');
    const pending = n.actor.history.read().pending!;
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 })).rejects.toThrow('Four durable');
    expect(n.actor.history.read().pending).toEqual(pending);
    expect(existsSync(join(n.directory, 'owner-0', 'witness-terminal-recovery', 'history-recovery.json'))).toBe(true);
    expect(n.actor.history.health().initialized).toBe(false);
    n.failAppends(false);
    const result = await prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'resume', nextGeneration: 1 });
    expect(result.evidence.report.head).toBe(historyCheckpointEnvelopeId(pending));
    expect(n.actor.history.read().image.state.spends).toContainEqual(row);
  });
}, 30000);

it('retains a partial freeze and resumes after four-of-five payload failure', async () => {
  const n = await fixture(); await n.run(async () => {
    n.failPayloads(true);
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 })).rejects.toThrow('Four complete');
    expect(n.actor.history.health().initialized).toBe(false);
    expect(n.actor.stores.filter(s => s.describe().freeze).length).toBeGreaterThanOrEqual(4);
    await expect(n.actor.history.ready()).rejects.toThrow('terminally prepared');
    await n.actor.reopen(); n.failPayloads(false);
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'resume', nextGeneration: 2 })).rejects.toThrow('invalid');
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'resume', nextGeneration: 1 })).resolves.toHaveProperty('preparation');
  });
}, 30000);

it('refuses a different proposal and missing resume records without freezing', async () => {
  const n = await fixture(); await n.run(async () => {
    const other = proposeProtectedWitnessHandoff(n.actor.history, n.policy.activeKey, n.proposal.newSet, n.authorityKey);
    // Different signing authority fails parsing or durable identity; neither may freeze.
    await expect(prepareTerminalProtectedWitness(n.actor.history, other, { mode: 'create-new', nextGeneration: 1 })).rejects.toThrow();
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'resume', nextGeneration: 1 })).rejects.toThrow('missing');
    expect(n.actor.stores.every(s => !s.describe().freeze)).toBe(true);
  });
}, 30000);

it('refuses a newer authenticated remote head instead of signing the stale local image', async () => {
  const n = await fixture(); await n.run(async () => {
    const local = n.actor.history.read(), row = n.row();
    const extra = sealHistoryCheckpoint({ context: n.actor.context, header: { kind: 'delta', generation: 0,
      sequence: local.applied!.sequence + 1, previous: local.applied!.id },
      plaintext: Buffer.from(JSON.stringify({ version: 1, kind: 'spend', at: Date.now(), row })), encryptionKey: n.actor.encryptionKey, signingKey: n.actor.key });
    for (const store of n.actor.stores) store.append(extra);
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 })).rejects.toThrow('reconciliation required');
    expect(n.actor.history.read().applied).toEqual(local.applied);
    expect(n.actor.history.health().initialized).toBe(false);
  });
}, 30000);

it('honors a shorter caller deadline while completing a pending write', async () => {
  const n = await fixture(); await n.run(async () => {
    n.failAppends(true); await expect(n.actor.history.write(n.row())).rejects.toThrow('Four durable'); n.failAppends(false);
    let release!: () => void;
    n.pauseAppends(new Promise<void>(resolve => { release = resolve; }));
    const start = performance.now();
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1,
      deadline: performance.now() + 100 })).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(1500);
    expect(n.actor.history.read().pending).not.toBeNull();
    expect(n.actor.stores.every(store => !store.describe().freeze)).toBe(true);
    release(); n.pauseAppends();
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'resume', nextGeneration: 1 })).resolves.toHaveProperty('evidence');
  });
}, 30000);

it('refuses unfunded preparation before freezing and retains monotone reservations', async () => {
  const n = await fixture(); await n.run(async () => {
    const status = n.funding.status();
    n.funding.reserve({ path: join(n.directory, 'capacity-control'), component: 'test-capacity', scope: 'file', maximumBytes: status.availableBytes - 8192 });
    const charged = n.funding.status().reservedBytes;
    await expect(prepareTerminalProtectedWitness(n.actor.history, n.proposal, { mode: 'create-new', nextGeneration: 1 })).rejects.toThrow('budget exhausted');
    expect(n.funding.status().reservedBytes).toBe(charged);
    expect(n.actor.stores.every(store => !store.describe().freeze)).toBe(true);
    expect(n.actor.history.health().initialized).toBe(false);
  });
}, 30000);


it('requires paired terminal proofs and independently retained pins before preparation or successor readiness', async () => {
  const n = await fixture(5); await n.run(async () => {
    for (const actor of n.actors.slice(1,4)) await freezeProtectedWitness(actor.history, n.proposal, actor.key, actor.encryptionKey);
    const preterminal = await freezeProtectedWitness(n.actor.history,n.proposal,n.actor.key,n.actor.encryptionKey);
    const row = n.row(); await n.actor.history.write(row);
    // Pins originate in actual local enrollment and applied state, before export.
    const pins: WitnessTerminalPins[] = n.actors.slice(0,4).map(actor => ({ context: structuredClone(actor.context),
      genesisId: historyCheckpointEnvelopeId(actor.root), rootId: historyCheckpointEnvelopeId(actor.history.read().root),
      generation: actor.history.read().root.generation, nextGeneration: 1, head: { ...actor.history.read().applied! } }));
    const pairs: WitnessTerminalEvidence[] = [];
    for (const actor of n.actors.slice(0,4)) pairs.push(await prepareTerminalProtectedWitness(actor.history,n.proposal,{mode:'create-new',nextGeneration:1}));
    const manifest = await prepareProtectedWitnessTransfer(n.proposal,pairs,undefined,pins);
    expect(manifest.version).toBe(2); expect(manifest.terminals).toHaveLength(4);
    expect(manifest.inherited.accepted).toContainEqual({owner: pub(n.actor.key), ...row});
    const drained = n.observerKeys.slice(0,4).map(key => createWitnessDrainReport(n.proposal,witnessHandoffDigest(manifest),key));
    const successor = n.actors[4], before = successor.history.read().applied;
    const refused = async (values: typeof pairs, retained = pins) => {
      await expect(prepareProtectedWitnessTransfer(n.proposal,values,undefined,retained)).rejects.toThrow();
      await expect(installProtectedWitnessTransfer(successor.history,values,manifest,drained,successor.key,undefined,retained)).rejects.toThrow();
      await expect(installProtectedCoordinatorTransfer(successor.history,values,manifest,drained,n.coordinator,undefined,retained)).rejects.toThrow();
      expect(successor.history.read().applied).toEqual(before);
      expect(successor.history.handoffState()!.phase).toBe('ACTIVE_OLD');
    };
    await refused(pairs, []);
    const stale = structuredClone(pairs); stale[0].evidence = preterminal; await refused(stale);
    await refused(pairs.slice(0,3));
    await refused([pairs[0],pairs[0],pairs[2],pairs[3]]);
    await expect(prepareProtectedWitnessTransfer(n.proposal,pairs.map(p=>p.evidence),undefined,pins)).rejects.toThrow();
    for (const change of [
      (v: typeof pairs) => { v[0].preparation.receipts.pop(); v[0].preparation.receipts.pop(); },
      (v: typeof pairs) => { v[0].preparation = v[1].preparation; },
      (v: typeof pairs) => { v[0].preparation.rootId = v[1].preparation.rootId; },
      (v: typeof pairs) => { v[0].preparation.generation++; },
      (v: typeof pairs) => { v[0].preparation.nextGeneration++; },
      (v: typeof pairs) => { v[0].evidence.blocks.pop(); },
      (v: typeof pairs) => { v[0].evidence.report.head = v[1].evidence.report.head; },
    ]) { const changed = structuredClone(pairs); change(changed); await refused(changed); }
    for (const change of [
      (v: WitnessTerminalPins[]) => { v[0].context.members = v[1].context.members.slice().reverse(); },
      (v: WitnessTerminalPins[]) => { v[0].context.historyId = v[1].context.historyId; },
      (v: WitnessTerminalPins[]) => { v[0].genesisId = v[1].genesisId; },
      (v: WitnessTerminalPins[]) => { v[0].rootId = v[1].rootId; },
      (v: WitnessTerminalPins[]) => { v[0].generation++; },
      (v: WitnessTerminalPins[]) => { v[0].nextGeneration++; },
      (v: WitnessTerminalPins[]) => { v[0].head.id = v[1].head.id; },
    ]) { const changed = structuredClone(pins); change(changed); await refused(pairs,changed); }
    const upgraded = { ...successor.history.handoffState()!, phase: 'DRAINED' as const, proposal: n.proposal, manifest: structuredClone(manifest), drained, inherited: manifest.inherited };
    upgraded.manifest.freezes[upgraded.manifest.freezes.findIndex(f => f.witness === preterminal.report.witness)] = preterminal.report;
    await expect(successor.history.writeHandoffState(upgraded)).rejects.toThrow('terminal identities');
    const ready = await installProtectedWitnessTransfer(successor.history,pairs,manifest,drained,successor.key,undefined,pins);
    expect(successor.history.handoffState()!.phase).toBe('NEW_READY');
    expect(ready.manifest).toBe(witnessHandoffDigest(manifest));
    await successor.reopen(); await successor.history.ready();
    expect(await installProtectedWitnessTransfer(successor.history,pairs,manifest,drained,successor.key,undefined,pins)).toEqual(ready);
    // Fresh challenge on producer resume preserves report/manifest identity.
    const resumed = [...pairs]; resumed[0] = await prepareTerminalProtectedWitness(n.actor.history,n.proposal,{mode:'resume',nextGeneration:1});
    expect(await prepareProtectedWitnessTransfer(n.proposal,resumed,undefined,pins)).toEqual(manifest);
    await expect(installProtectedCoordinatorTransfer(successor.history,pairs,manifest,drained,n.coordinator,undefined,pins)).resolves.toMatchObject({kind:'witness-coordinator-installed'});
    const legacy = structuredClone(successor.history.handoffState()!) as any;
    legacy.manifest.version = 1; delete legacy.manifest.terminals;
    await expect(successor.history.writeHandoffState(legacy)).rejects.toThrow('manifest');
  });
}, 30000);
