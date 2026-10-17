import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest, parseHistoryProvisionReceipt } from '@resonance/core/history-provision';
import { createHistoryCompactionProposal, parseHistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { createHistoryCompactionControlRequest, historyCompactionCertificateId, parseHistoryCompactionControlResponse } from '@resonance/core/history-compaction-control';
import { collectHistoryCompactionCertificate, requestHistoryCompactionControl } from '../history-compaction-coordinator.js';
import { discoverHistoryCompactionFrontier } from '../history-frontier-discovery.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { listenHistoryAgreementReplica, exchangeHistoryProvision, exchangeHistoryCompactionControl } from '../history-agreement-exchange.js';
import { exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { discoverHistoryContinuations } from '../history-continuation-discovery.js';
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
      provision: raw => services[i].provision(raw), checkpoint: raw => services[i].checkpoint(raw),
      endorseCompactionCheckpoint: raw => services[i].endorseCompactionCheckpoint(raw), compaction: raw => services[i].compaction(raw) });
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
      nextGeneration: proposal.nextGeneration, initialize: { proposal }, historyTransfer: { retained: () => blocks } }); cleanup.push(() => agreement.close());
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

it('endorses retained checkpoints under independent genesis pins while preserving suffixes and frozen ancestors', async () => {
  const n = await fixture(), genesisId = historyCheckpointEnvelopeId(n.root), blocks = await n.append(n.root);
  const discover = () => discoverHistoryCompactionFrontier({ context: n.context, genesisId, signingKey: n.owner.signingKey, members: n.members });
  expect((await discover()).certificate).toBeNull();
  function append(block: HistoryCheckpointEnvelope, rootId: string) {
    const issuedAt = Date.now();
    for (let i = 0; i < 5; i++) {
      const request = createHistoryExchangeRequest({ action: 'append', rootId, generation: block.generation,
        replica: n.context.members[i], challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000,
        sequence: block.sequence, envelopeId: historyCheckpointEnvelopeId(block) }, n.context, n.owner.signingKey);
      n.services[i].checkpoint({ request, envelope: block });
    }
  }
  function proposal(block: HistoryCheckpointEnvelope, rootId = genesisId) {
    const issuedAt = Date.now();
    return createHistoryCompactionProposal({ genesisId, rootId, checkpoint: block, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner.signingKey);
  }
  const checkpoint = n.next(blocks[1], 'complete opaque image', 'checkpoint'), p = proposal(checkpoint);
  expect(() => n.services[0].endorseCompactionCheckpoint(p)).toThrow('complete retained');
  append(checkpoint, genesisId); const tail = n.next(checkpoint); append(tail, genesisId);
  const heads = n.services.map(s => s.describe()), reviews = n.services.map(s => s.reviewDigest()), health = n.services.map(s => s.health());
  const votes = n.services.slice(0, 4).map(s => s.endorseCompactionCheckpoint(p));
  const certificate = { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal: p, votes };
  expect(parseHistoryCompactionCertificate(certificate, n.context, genesisId, checkpoint).votes).toHaveLength(4);
  const networkCertificate = await collectHistoryCompactionCertificate({ context: n.context, genesisId, proposal: p, checkpoint, members: n.members });
  expect(networkCertificate.votes).toHaveLength(4);
  expect(n.services.map(s => s.describe())).toEqual(heads); expect(n.services.map(s => s.reviewDigest())).toEqual(reviews);
  expect(n.services.map(s => s.health())).toEqual(health);
  expect(n.reopen(0).endorseCompactionCheckpoint(p)).toEqual(votes[0]);
  expect(() => n.services[0].retainCompactionCheckpoint(certificate, 'stale')).toThrow('whole-service review');
  for (let i = 0; i < 5; i++) {
    const issuedAt = Date.now(), request = createHistoryCompactionControlRequest({ action: 'retain', genesisId, rootId: genesisId, generation: 0,
      replica: n.members[i].publicKey, certificateId: historyCompactionCertificateId(certificate, n.context, genesisId),
      challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner.signingKey);
    const frame = { request, certificate };
    expect(() => n.services[i].compaction({ ...frame, request: { ...request, signature: 'forged' } })).toThrow();
    const response = await requestHistoryCompactionControl({ context: n.context, genesisId, member: n.members[i], frame });
    expect(response.certificate).toEqual(certificate);
    // Repeated delivery after an uncertain reply returns the original durable proof.
    expect(parseHistoryCompactionControlResponse(await exchangeHistoryCompactionControl(n.members[i], frame, new AbortController().signal), frame, n.context, genesisId).certificate).toEqual(certificate);
  }
  expect(n.services.map(s => s.describe())).toEqual(heads); expect(n.services.map(s => s.health())).toEqual(health);
  for (let i = 0; i < 5; i++) expect(n.reopen(i).retainedCompactionCheckpoint(genesisId)).toEqual(certificate);
  const child = await n.decide([...blocks, checkpoint, tail]); await n.provision(child);
  // An uncheckpointed successor preserves the last usable ancestor frontier.
  expect((await discover()).certificate).toEqual(certificate);
  expect(() => n.services[0].endorseCompactionCheckpoint(p)).toThrow('current unfrozen');
  expect(n.services[0].retainCompactionCheckpoint(certificate, 'old-review')).toEqual(certificate);
  // Historical evidence remains valid; it cannot remove the frozen tail or reactivate its owner.
  expect(parseHistoryCompactionCertificate(certificate, n.context, genesisId, checkpoint).proposal.envelopeId).toBe(historyCheckpointEnvelopeId(checkpoint));
  const childBlocks = await n.append(child), childCheckpoint = n.next(childBlocks[1], 'complete successor image', 'checkpoint');
  const childId = historyCheckpointEnvelopeId(child); append(childCheckpoint, childId);
  const current = proposal(childCheckpoint, childId);
  const childCertificate = await collectHistoryCompactionCertificate({ context: n.context, genesisId, proposal: current, checkpoint: childCheckpoint, members: n.members });
  expect(childCertificate.votes).toHaveLength(4);
  for (const service of n.services) service.retainCompactionCheckpoint(childCertificate, service.reviewDigest());
  const retained = n.services.map(s => s.reviewDigest());
  for (let i = 0; i < 5; i++) n.reopen(i);
  expect((await discover()).certificate).toEqual(childCertificate);
  expect(n.services.every(s => s.retainedCompactionCheckpoint(childId)?.proposal.genesisId === genesisId)).toBe(true);
  const successorVotes = n.services.slice(0, 4).map(s => s.endorseCompactionCheckpoint(current));
  expect(parseHistoryCompactionCertificate({ ...certificate, proposal: current, votes: successorVotes }, n.context, genesisId, childCheckpoint).proposal.generation).toBe(1);
  expect(n.services.map(s => s.reviewDigest())).toEqual(retained);
  const foreign = createHistoryCompactionProposal({ genesisId: `sha256:${'b'.repeat(64)}`, rootId: childId, checkpoint: childCheckpoint,
    issuedAt: Date.now(), expiresAt: Date.now() + 10000 }, n.context, n.owner.signingKey);
  expect(() => n.services[0].endorseCompactionCheckpoint(foreign)).toThrow();
}, 30000);

it('keeps a committed compaction certificate when its control request expires during persistence and recovers through a fresh read', async () => {
  const n = await fixture(), genesisId = historyCheckpointEnvelopeId(n.root), blocks = await n.append(n.root), checkpoint = n.next(blocks[1], 'state', 'checkpoint');
  const issuedAt = Date.now();
  for (let i = 0; i < 5; i++) {
    const request = createHistoryExchangeRequest({ action: 'append', rootId: genesisId, generation: 0, sequence: checkpoint.sequence,
      envelopeId: historyCheckpointEnvelopeId(checkpoint), replica: n.members[i].publicKey, challenge: randomBytes(32).toString('base64url'),
      issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner.signingKey);
    n.services[i].checkpoint({ request, envelope: checkpoint });
  }
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner.signingKey);
  const certificate = await collectHistoryCompactionCertificate({ context: n.context, genesisId, checkpoint, proposal, members: n.members });
  const request = createHistoryCompactionControlRequest({ action: 'retain', genesisId, rootId: genesisId, generation: 0,
    replica: n.members[0].publicKey, certificateId: historyCompactionCertificateId(certificate, n.context, genesisId),
    challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner.signingKey);
  expect(() => n.services[1].compaction({ request, certificate })).toThrow('another volunteer');
  n.services[0].close(); let calls = 0;
  n.services[0] = openHistoryVolunteerService({ ...n.options(0), now: () => calls++ === 0 ? issuedAt : issuedAt + 30000 });
  expect(() => n.services[0].compaction({ request, certificate })).toThrow('expired');
  expect(n.services[0].retainedCompactionCheckpoint(genesisId)).toEqual(certificate); n.reopen(0);
  const time = Date.now(), read = createHistoryCompactionControlRequest({ action: 'read', genesisId, rootId: genesisId, generation: 0,
    replica: n.members[0].publicKey, certificateId: null, challenge: randomBytes(32).toString('base64url'), issuedAt: time, expiresAt: time + 30000 }, n.context, n.owner.signingKey);
  const response = await requestHistoryCompactionControl({ context: n.context, genesisId, member: n.members[0], frame: { request: read, certificate: null } });
  expect(response.certificate).toEqual(certificate); expect(response.head.sequence).toBe(checkpoint.sequence);
}, 30000);

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
  const retainedBytes = ancestry.reduce((sum, block) => sum + Buffer.byteLength(JSON.stringify(block)), 0);
  for (const service of n.services) {
    const health = service.health();
    expect(health).toMatchObject({ generations: 3, retainedBlocks: ancestry.length, stagedBlocks: 0,
      retainedCiphertextBytes: retainedBytes, manifestReserveBytes: 12 * 1024 * 1024, currentGenerationBlocks: 2 });
    expect(health.reservedBytes).toBe(retainedBytes + 12 * 1024 * 1024);
    expect(JSON.stringify(health)).not.toMatch(/rootId|envelopeId|did:key:|sha256:/);
  }
  const before = n.services.map(s => s.describe());
  const observed = await discoverHistoryContinuations({ ...n.owner, genesisId: historyCheckpointEnvelopeId(n.root), members: n.members });
  expect(observed.continuations.map(r => r.generation)).toEqual([1, 2]);
  expect(observed.observedLeaf.rootId).toBe(historyCheckpointEnvelopeId(root));
  expect(observed.observedLeaf.receipts).toHaveLength(4);
  expect(n.services.map(s => s.describe())).toEqual(before);
  // All ancestry hops share one deadline; a silent/slow hop cannot reset it.
  let calls = 0;
  await expect(discoverHistoryContinuations({ ...n.owner, genesisId: historyCheckpointEnvelopeId(n.root), members: n.members,
    timeoutMs: 200, transport: (member, frame, signal) => new Promise((resolve, reject) => {
      calls++;
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        try { resolve(n.services[n.members.findIndex(m => m.publicKey === member.publicKey)].checkpoint(frame)); } catch (error) { reject(error); }
      }, 120);
      const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
    }) })).rejects.toThrow('timed out');
  expect(calls).toBeLessThanOrEqual(10);
}, 60000);

it('does not infer the absence of a confirmed decision from four unactivated child observations', async () => {
  const n = await fixture(), root = await n.decide(await n.append(n.root));
  const options = { ...n.owner, genesisId: historyCheckpointEnvelopeId(n.root), members: n.members };
  expect((await discoverHistoryContinuations(options)).observedLeaf.generation).toBe(0);
  await n.provision(root);
  const observed = await discoverHistoryContinuations(options);
  expect(observed.continuations).toEqual([root]); expect(observed.observedLeaf.generation).toBe(1);
  await expect(discoverHistoryContinuations({ ...options, maxGenerations: 1 })).rejects.toThrow('capacity');
  expect(n.services.map(s => s.describe().generations)).toEqual([2, 2, 2, 2, 2]);
  const issuedAt = Date.now(), request = createHistoryExchangeRequest({ action: 'continuation', rootId: options.genesisId, generation: 0,
    replica: n.members[0].publicKey, challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000,
    sequence: 0, envelopeId: null }, n.context, n.owner.signingKey);
  const response = parseHistoryExchangeResponse(n.services[0].checkpoint({ request, envelope: null }), request, n.context);
  for (const head of [{ ...response.head, sequence: 0, envelopeId: options.genesisId }, { ...response.head, freeze: null }]) {
    expect(() => createHistoryExchangeResponse(request, 'continuation', head, root, n.context, n.memberKeys[0])).toThrow();
  }
  expect(() => parseHistoryExchangeResponse({ ...response, envelope: { ...root, certificate: { ...root.certificate,
    votes: root.certificate.votes.slice(0, 3) } } }, request, n.context)).toThrow();
}, 30000);

it('ignores one forged observation, refuses two, and rejects replayed observations for new challenges', async () => {
  const n = await fixture(), options = { ...n.owner, genesisId: historyCheckpointEnvelopeId(n.root), members: n.members };
  const saved = new Map<string, unknown>();
  // The API copies endpoint records; select by the public pin rather than object identity.
  const transport: typeof exchangeHistoryCheckpoint = async (member, frame) => {
    const raw = n.services[n.members.findIndex(m => m.publicKey === member.publicKey)].checkpoint(frame);
    saved.set(member.publicKey, raw); return raw;
  };
  expect((await discoverHistoryContinuations({ ...options, transport })).observedLeaf.receipts).toHaveLength(4);
  await expect(discoverHistoryContinuations({ ...options, transport: async member => saved.get(member.publicKey) })).rejects.toThrow('unavailable');
  for (const broken of [1, 2]) {
    const attempt = discoverHistoryContinuations({ ...options, transport: async (member, frame, signal) => {
      const raw = await transport(member, frame, signal);
      return n.members.findIndex(m => m.publicKey === member.publicKey) < broken ? { ...raw as object, signature: 'forged' } : raw;
    } });
    if (broken === 1) expect((await attempt).observedLeaf.receipts).toHaveLength(4);
    else await expect(attempt).rejects.toThrow('unavailable');
  }
});

it('bounds silent peers, closes attempts on cancellation and ignores late replies', async () => {
  const n = await fixture(), options = { ...n.owner, genesisId: historyCheckpointEnvelopeId(n.root), members: n.members };
  let started = 0, aborted = 0; const pending: Array<() => void> = [];
  const transport: typeof exchangeHistoryCheckpoint = (member, frame, signal) => new Promise(resolve => {
    started++; signal.addEventListener('abort', () => aborted++, { once: true });
    const response = n.services[n.members.findIndex(m => m.publicKey === member.publicKey)].checkpoint(frame);
    pending.push(() => resolve(response));
  });
  const controller = new AbortController(), run = discoverHistoryContinuations({ ...options, transport, signal: controller.signal });
  await Promise.resolve(); expect(started).toBe(5); controller.abort();
  await expect(run).rejects.toThrow('cancelled'); expect(aborted).toBe(5);
  pending.splice(0).forEach(resolve => resolve()); await Promise.resolve();
  const beforeDeadline = started;
  const deadline = discoverHistoryContinuations({ ...options, transport, timeoutMs: 100 });
  await expect(deadline).rejects.toThrow('timed out');
  // Real signing/verification may exhaust 100 ms before every (or even the first) member is dispatched.
  // Every attempt that actually started must be aborted, including that partial fan-out.
  expect(started - beforeDeadline).toBeLessThanOrEqual(5);
  expect(aborted).toBe(started); const atDeadline = started;
  pending.splice(0).forEach(resolve => resolve());
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await expect(discoverHistoryContinuations({ ...options, transport, signal: alreadyCancelled.signal })).rejects.toThrow('cancelled');
  expect(started).toBe(atDeadline); expect(n.owner.signingKey.secretKey.some(byte => byte !== 0)).toBe(true);
});

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
