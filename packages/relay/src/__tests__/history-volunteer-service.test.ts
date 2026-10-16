import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest, parseHistoryProvisionReceipt } from '@resonance/core/history-provision';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { listenHistoryAgreementReplica, exchangeHistoryProvision } from '../history-agreement-exchange.js';
import { exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(maxGenerations = 65) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-volunteer-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const options = (i: number) => ({ directory: join(directory, `replica-${i}`), localKey: f.localKey, context: f.context,
    signingKey: f.memberKeys[i], genesisId: historyCheckpointEnvelopeId(f.root), maxGenerations });
  const services = f.context.members.map((_, i) => openHistoryVolunteerService({ ...options(i), initialize: f.root }));
  cleanup.push(() => services.forEach(s => s.close()));
  const listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryAgreementReplica({ exchange: raw => services[i].exchange(raw), transfer: raw => services[i].transfer(raw),
      provision: raw => services[i].provision(raw), checkpoint: raw => services[i].checkpoint(raw) });
    listeners.push(listener); cleanup.push(() => listener.close());
  }
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].checkpointEndpoint }));
  const agreementMembers = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].endpoint }));
  const owner = { context: f.context, localKey: f.localKey, signingKey: f.owner };
  async function append(root: HistoryCheckpointEnvelope) {
    const writer = createHistoryCheckpointWriter({ ...owner, directory: join(directory, `writer-${root.generation}`), members,
      rootId: historyCheckpointEnvelopeId(root), generation: root.generation, initialize: true,
      ...(root.kind === 'continuation' ? { continuation: root } : {}) }); cleanup.push(() => writer.close());
    const delta = f.next(root); await writer.replicate(root); await writer.replicate(delta); return [root, delta];
  }
  async function freeze(blocks: HistoryCheckpointEnvelope[]) {
    const root = blocks[0], rootId = historyCheckpointEnvelopeId(root), generation = root.generation;
    const issuedAt = Date.now(), challenge = randomBytes(32).toString('base64url');
    const barrier = createHistoryFreeze(f.context, generation, generation + 1, challenge, f.owner);
    const receipts = await Promise.all(members.map(async member => {
      const request = createHistoryExchangeRequest({ action: 'freeze', rootId, generation, replica: member.publicKey, challenge,
        issuedAt, expiresAt: issuedAt + 30000, sequence: generation + 1, envelopeId: null }, f.context, f.owner);
      return parseHistoryExchangeResponse(await exchangeHistoryCheckpoint(member, { request, envelope: null, freeze: barrier }, new AbortController().signal), request, f.context);
    }));
    return createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation, nextGeneration: generation + 1,
      receipts: receipts.slice(0, 4), envelopes: blocks }, f.context, f.owner);
  }
  async function decide(blocks: HistoryCheckpointEnvelope[]) {
    const proposal = await freeze(blocks);
    const agreement = createHistoryAgreementCoordinator({ ...owner, directory: join(directory, `agreement-${proposal.generation}`),
      members: agreementMembers, rootId: proposal.rootId, generation: proposal.generation,
      nextGeneration: proposal.nextGeneration, initialize: { proposal } }); cleanup.push(() => agreement.close());
    return createHistoryContinuationRoot(proposal, await agreement.run(), f.context);
  }
  const request = (root: HistoryContinuationRoot, i: number) => {
    const issuedAt = Date.now(); return createHistoryProvisionRequest({ root, replica: f.context.members[i],
      challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner);
  };
  async function provision(root: HistoryContinuationRoot) {
    await Promise.all(agreementMembers.map(async (member, i) => {
      const r = request(root, i); parseHistoryProvisionReceipt(await exchangeHistoryProvision(member, r, new AbortController().signal), r);
    }));
  }
  return { ...f, directory, options, services, listeners, members, owner, append, freeze, decide, request, provision,
    reopen(i: number) { services[i].close(); services[i] = openHistoryVolunteerService(options(i)); return services[i]; } };
}

it('runs freeze, agreement, provisioning and retained reads across three generations on five real sockets and reopens the whole chain', async () => {
  const n = await fixture(); let root: HistoryCheckpointEnvelope = n.root; const ancestry: HistoryCheckpointEnvelope[] = [];
  for (let generation = 0; generation < 2; generation++) {
    const blocks = await n.append(root); ancestry.push(...blocks); root = await n.decide(blocks); await n.provision(root);
    for (let i = 0; i < 5; i++) expect(n.reopen(i).describe().generations).toBe(generation + 2);
  }
  const blocks = await n.append(root); ancestry.push(...blocks); const proposal = await n.freeze(blocks);
  for (let i = 0; i < 5; i++) n.reopen(i);
  const download = createHistoryAncestryDownload({ ...n.owner, directory: join(n.directory, 'download'), members: n.members,
    proposal, initialize: true }); cleanup.push(() => download.close());
  expect((await download.run()).complete).toBe(true); expect([...download.blocks()]).toEqual(ancestry);
  expect(n.services.map(s => s.describe().latest.generation)).toEqual([2, 2, 2, 2, 2]);
}, 60000);

it.each(['missing-slot', 'missing-child', 'corrupt-slot', 'unregistered-contents'])(
  'preserves and refuses %s after a certified child has been published', async damage => {
    const n = await fixture(), root = await n.decide(await n.append(n.root)); await n.provision(root);
    n.services[0].close(); const directory = n.options(0).directory;
    const slot = join(directory, `successors-${historyCheckpointEnvelopeId(n.root).slice(7)}`), journal = join(slot, 'history-provision.json');
    if (damage === 'missing-slot') rmSync(journal);
    if (damage === 'missing-child') rmSync(join(slot, `generation-${historyContinuationRootId(root).slice(7)}`), { recursive: true });
    if (damage === 'corrupt-slot') writeFileSync(journal, 'damaged');
    if (damage === 'unregistered-contents') writeFileSync(join(directory, 'unknown-history'), 'keep this evidence');
    const entries = readdirSync(directory).sort();
    expect(() => openHistoryVolunteerService(n.options(0))).toThrow(); expect(readdirSync(directory).sort()).toEqual(entries);
    if (damage === 'missing-slot') expect(() => readFileSync(journal)).toThrow();
    if (damage === 'corrupt-slot') expect(readFileSync(journal, 'utf8')).toBe('damaged');
  }, 30000,
);
it('refuses new generations at its capacity without clearing the frozen parent or poisoning valid reads', async () => {
  const n = await fixture(1), root = await n.decide(await n.append(n.root));
  expect(() => n.services[0].provision(n.request(root, 0))).toThrow('capacity');
  expect(n.services[0].describe().generations).toBe(1); expect(n.services[0].describe().latest.freeze).not.toBeNull();
  expect(() => n.services[0].checkpoint({ request: { rootId: 'untrusted' } })).toThrow('not enrolled');
  expect(n.services[0].describe().generations).toBe(1);
});
it('preserves unknown files instead of treating an unactivated slot as empty setup', async () => {
  const n = await fixture(); n.services[0].close();
  const slot = join(n.options(0).directory, `successors-${historyCheckpointEnvelopeId(n.root).slice(7)}`);
  rmSync(join(slot, 'history-provision.json')); const unknown = join(slot, 'unregistered.block'); writeFileSync(unknown, 'preserve unknown evidence');
  expect(() => openHistoryVolunteerService(n.options(0))).toThrow('Unregistered');
  expect(readFileSync(unknown, 'utf8')).toBe('preserve unknown evidence');
});

it.each(['before-slot', 'after-slot'])(
  'resumes the unactivated child slot after SIGKILL at %s without replacing the already published child', async boundary => {
    const n = await fixture(), root = await n.decide(await n.append(n.root)); n.services[0].close();
    const child = fork(new URL('./fixtures/history-volunteer-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
    const { signingKey, localKey, ...options } = n.options(0);
    child.send({ options, localKey: localKey.toString('hex'), member: { publicKey: Buffer.from(signingKey.publicKey).toString('hex'),
      secretKey: Buffer.from(signingKey.secretKey).toString('hex') }, request: n.request(root, 0), boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    expect(n.reopen(0).describe().generations).toBe(2); await n.provision(root);
    const blocks = await n.append(root); expect(blocks[1].generation).toBe(1);
    expect(n.reopen(0).describe().generations).toBe(2);
  }, 30000,
);
