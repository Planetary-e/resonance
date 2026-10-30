import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, type SigningKeyPair } from '@resonance/core';
import { signAdmissionPolicy, admissionPolicyDigest } from '@resonance/core/admission-policy';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionWitnessSetId, createAdmissionWitnessVote, parseAdmissionWitnessSet,
  verifyAdmissionSpendCertificate, type AdmissionSpendClaim, type AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { parseWitnessFreezeReport, witnessHandoffObserverPins } from '@resonance/core/admission-witness-handoff';
import { historyCheckpointEnvelopeId, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { enrollProtectedWitnessEpoch, proposeProtectedWitnessHandoff, freezeProtectedWitness,
  prepareProtectedWitnessTransfer, retainOriginalWitnessCertificate } from '../protected-witness-handoff.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');

it('retains a valid but nonterminal four-owner freeze after a durable spend and late original certificate', async () => {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const directory = mkdtempSync(join(tmpdir(), 'semantic-freeze-boundary-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const funding = openStorageReservationAuthority({ directory: join(directory, 'funding'), mode: 'create-new', limitBytes: 2 * 1024 ** 3 });
  cleanup.push(() => funding.close());
  await withStorageReservationAuthority(funding, async () => {
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
    for (let index = 0; index < 4; index++) {
      const key = old[index], encryptionKey = randomBytes(32);
      const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends',
        historyId: randomBytes(32).toString('base64url'), owner: pub(key), authority: f.authority,
        policyDigest: `sha256:${admissionPolicyDigest(policy)}`, members: f.keys.map(pub).sort(), quorum: 4 };
      const replicas: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
      const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [];
      const transport: HistoryCheckpointTransport = async (member, frame) => replicas[context.members.indexOf(member.publicKey)].exchange(frame);
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
      await history.captureRoles(roles, (await history.planRoleCapture(roles)).approvalDigest);
      await enrollProtectedWitnessEpoch(history, policy);
      actors.push({ key, encryptionKey, stores, get history() { return history; },
        async prepareTerminal() {
          const recovery = createHistoryCheckpointRecovery({ directory: join(directory, `terminal-${index}`),
            localKey: randomBytes(32), context, signingKey: key, rootId: historyCheckpointEnvelopeId(root),
            generation: 0, nextGeneration: 1, members: protection.members, transport, initialize: true });
          cleanup.push(recovery.close); return recovery.prepare();
        },
        async reopen() { history.close(); history = await openProtectedAdmissionSpendHistory(options); await history.ready(); } });
    }
    const claim: AdmissionSpendClaim = { setId: admissionWitnessSetId(oldSet), issuerKey: policy.activeKey,
      spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${'a'.repeat(86)}` };
    const certificate: AdmissionSpendCertificate = { version: 1, votes: [] };
    for (const actor of actors) {
      const vote = createAdmissionWitnessVote(claim, actor.key);
      await actor.history.writeRoleDecision({ kind: 'witness-vote', vote }); certificate.votes.push(vote);
    }
    certificate.votes.sort((a, b) => a.witness.localeCompare(b.witness));
    expect(verifyAdmissionSpendCertificate(certificate, claim, oldSet)).toBe(true);
    const proposal = proposeProtectedWitnessHandoff(actors[0].history, policy.activeKey, newSet, f.key);
    const frozen = [];
    for (const actor of actors) frozen.push(await freezeProtectedWitness(actor.history, proposal, actor.key, actor.encryptionKey));
    expect(new Set(frozen.map(value => value.report.witness)).size).toBe(4);
    expect(new Set(frozen.map(value => value.report.head)).size).toBe(4);
    // The former consumer accepted these signed yet nonterminal prefixes.
    // Mandatory paired-proof consumers now reject them before a manifest exists.
    await expect(prepareProtectedWitnessTransfer(proposal, frozen)).rejects.toThrow();
    for (const value of frozen) expect(parseWitnessFreezeReport(value.report, proposal)).toEqual(value.report);

    const actor = actors[0], frozenHead = frozen[0].report.head, frozenSequence = actor.history.read().applied!.sequence;
    const row = { issuerKey: policy.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: `admreq_${'b'.repeat(86)}` };
    await actor.history.write(row);
    expect(actor.history.handoffState()!.phase).toBe('OLD_FENCED');
    expect(actor.history.read().applied!.sequence).toBe(frozenSequence + 1);
    expect(actor.stores.filter(store => store.describe().sequence === frozenSequence + 1).length).toBeGreaterThanOrEqual(4);
    await expect(retainOriginalWitnessCertificate(actor.history, certificate)).resolves.toBe('bound');
    expect(actor.history.read().applied!.sequence).toBe(frozenSequence + 2);
    expect(actor.history.read().applied!.id).not.toBe(frozenHead);
    await actor.reopen();
    expect(actor.history.get(row.spend)).toEqual(row);
    expect(actor.history.handoffState()!.inherited.certificates).toEqual([certificate]);

    // Exact historical signatures prove this prefix, without proving currentness.
    expect(parseWitnessFreezeReport(frozen[0].report, proposal)).toEqual(frozen[0].report);
    await expect(prepareProtectedWitnessTransfer(proposal, frozen)).rejects.toThrow();
    const refreshed = [...frozen];
    refreshed[0] = await freezeProtectedWitness(actor.history, proposal, actor.key, actor.encryptionKey);
    await expect(prepareProtectedWitnessTransfer(proposal, refreshed)).rejects.toThrow();
    expect(parseWitnessFreezeReport(refreshed[0].report, proposal).head).toBe(actor.history.read().applied!.id);
    // A missing original tail is refused; no unsigned summary repairs it.
    await expect(prepareProtectedWitnessTransfer(proposal, [{ ...refreshed[0], blocks: refreshed[0].blocks.slice(0, -1) }, ...refreshed.slice(1)]))
      .rejects.toThrow();

    // The existing authenticated storage-generation barrier is stronger than
    // OLD_FENCED. Preparation alone does not allocate/activate a successor.
    const terminalHead = actor.history.read().applied!.id;
    const terminal = await actor.prepareTerminal();
    expect(terminal.receipts).toHaveLength(4);
    expect(historyCheckpointEnvelopeId(terminal.envelopes.at(-1)!)).toBe(terminalHead);
    expect(actor.stores.filter(store => store.describe().freeze?.nextGeneration === 1).length).toBeGreaterThanOrEqual(4);
    const nextRow = { ...row, spend: randomBytes(32).toString('base64url') };
    await expect(actor.history.write(nextRow)).rejects.toThrow('Four durable history acknowledgements unavailable');
    expect(actor.history.read().applied!.id).toBe(terminalHead);
    expect(actor.history.read().image.state.spends.some(value => value.spend === nextRow.spend)).toBe(false);
    expect(actor.history.read().pending).not.toBeNull();
    await expect(retainOriginalWitnessCertificate(actor.history, certificate)).rejects.toThrow('Four durable history acknowledgements unavailable');
    await expect(actor.reopen()).rejects.toThrow('Four durable history acknowledgements unavailable');
  });
}, 30000);
