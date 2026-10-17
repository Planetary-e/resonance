import { afterEach, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot, historyContinuationRootId, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest, parseHistoryProvisionReceipt } from '@resonance/core/history-provision';
import { createHistoryCompactionProposal, parseHistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { createHistoryCompactionControlRequest, historyCompactionCertificateId, parseHistoryCompactionControlResponse } from '@resonance/core/history-compaction-control';
import { collectHistoryCompactionCertificate, requestHistoryCompactionControl, retainHistoryCompactionCertificate } from '../history-compaction-coordinator.js';
import { parseHistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { HISTORY_VOLUNTEER_FRONTIER_FILENAME } from '../history-volunteer-frontier.js';
import { HISTORY_POOL_FILENAME, historyPoolPaths } from '../history-volunteer-pool.js';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
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
async function fixture(maxGenerations = 65, managed = false) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-volunteer-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authority = managed ? openStorageReservationAuthority({ directory: join(directory, 'reservations'), mode: 'create-new', limitBytes: 1024 * 1024 * 1024 }) : undefined;
  cleanup.push(() => authority?.close());
  const owned = <T>(operation: () => T) => authority ? withStorageReservationAuthority(authority, operation) : operation();
  const options = (i: number) => ({ directory: join(directory, `replica-${i}`), localKey: f.localKey, context: f.context,
    signingKey: f.memberKeys[i], genesisId: historyCheckpointEnvelopeId(f.root), maxGenerations });
  const services = f.context.members.map((_, i) => owned(() => openHistoryVolunteerService({ ...options(i), initialize: f.root })));
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
  return { ...f, directory, options, services, listeners, members, owner, append, freeze, decide, request, provision, authority,
    reopen(i: number) { services[i].close(); services[i] = owned(() => openHistoryVolunteerService(options(i))); return services[i]; } };
}

async function certifiedGeneration(n: Awaited<ReturnType<typeof fixture>>, root: HistoryCheckpointEnvelope) {
  const blocks = await n.append(root), checkpoint = n.next(blocks[1], 'complete opaque owner state', 'checkpoint');
  const rootId = historyCheckpointEnvelopeId(root), genesisId = historyCheckpointEnvelopeId(n.root), issuedAt = Date.now();
  for (let i = 0; i < 5; i++) {
    const request = createHistoryExchangeRequest({ action: 'append', rootId, generation: root.generation, replica: n.context.members[i],
      challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000,
      sequence: checkpoint.sequence, envelopeId: historyCheckpointEnvelopeId(checkpoint) }, n.context, n.owner.signingKey);
    n.services[i].checkpoint({ request, envelope: checkpoint });
  }
  const proposal = createHistoryCompactionProposal({ genesisId, rootId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner.signingKey);
  const certificate = await collectHistoryCompactionCertificate({ context: n.context, genesisId, proposal, checkpoint, members: n.members });
  const receipts = await retainHistoryCompactionCertificate({ context: n.context, genesisId, certificate,
    signingKey: n.owner.signingKey, members: n.members });
  // The fifth need not have answered before collection returns. Enroll the same
  // already-certified local checkpoint before this test maintains every service.
  for (const service of n.services) service.retainCompactionCheckpoint(certificate, service.reviewDigest());
  const retention = parseHistoryCompactionRetention({ version: 1, kind: 'history-compaction-retention', certificate, receipts }, n.context, genesisId);
  return { blocks: [...blocks, checkpoint], certificate, retention };
}

it('reuses two funded locations through seven generations without growing lifetime reservations or losing accepted history', async () => {
  const n = await fixture(3, true), service = n.services[0], stale = service.planPool(2);
  const first = await n.append(n.root);
  expect(() => service.enablePool(2, stale.approvalDigest)).toThrow('review');
  for (const current of n.services) current.enablePool(2, current.planPool(2).approvalDigest);
  const authority = n.authority!, funded = authority.status().reservedBytes;
  authority.applyLimit(funded, authority.reviewLimit(funded).approvalDigest);
  const budget = authority.status();
  let root: HistoryCheckpointEnvelope = n.root;
  // Genesis has already accepted its first delta; do not recreate that owner.
  const firstChild = await n.decide(first); await n.provision(firstChild); root = firstChild;
  const genesis = n.services.map((_, i) => readFileSync(join(n.options(i).directory, 'genesis', 'history-manifest.json')));
  for (let generation = 1; generation <= 7; generation++) {
    const current = await certifiedGeneration(n, root);
    let chosen: HistoryContinuationRoot | undefined;
    if (generation === 2) {
      chosen = await n.decide(current.blocks);
      await expect(n.provision(chosen)).rejects.toThrow(); // Preserve the agreed successor when every location is occupied.
      expect(n.services.every(s => s.describe().latest.generation === 2)).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      const previous = n.services[i].describe().latest, plan = n.services[i].planGenerationRetirement(current.retention);
      n.services[i].retireGenerations(current.retention, plan.approvalDigest);
      expect(n.reopen(i).describe()).toMatchObject({ generations: 2, maximumGenerations: 3, poolSlots: 2, latest: previous });
      expect(n.services[i].retainedCompactionCheckpoint(historyCheckpointEnvelopeId(root))).toEqual(current.certificate);
      expect(readFileSync(join(n.options(i).directory, 'genesis', 'history-manifest.json'))).toEqual(genesis[i]);
      expect(readdirSync(n.options(i).directory).some(name => name.startsWith('successors-'))).toBe(false);
    }
    expect(authority.status()).toEqual(budget);
    if (generation < 7) { root = chosen ?? await n.decide(current.blocks); await n.provision(root as HistoryContinuationRoot); }
  }
  expect((await discoverHistoryCompactionFrontier({ context: n.context, genesisId: historyCheckpointEnvelopeId(n.root),
    signingKey: n.owner.signingKey, members: n.members })).certificate?.proposal.generation).toBe(7);
}, 120000);

it('does not infer reusable capacity from missing slots, unexpected occupants, altered limits or a lost pool selection', async () => {
  const n = await fixture(3), base = n.options(0).directory, service = n.services[0];
  expect(() => service.planPool(3)).toThrow('bounded slot count');
  service.enablePool(2, service.planPool(2).approvalDigest); service.close();
  const slot = historyPoolPaths(base, 2, 2).base, unknown = join(slot, 'keep.txt');
  writeFileSync(unknown, 'preserve'); expect(() => n.reopen(0)).toThrow('Unregistered history pool occupant');
  expect(readFileSync(unknown, 'utf8')).toBe('preserve'); rmSync(unknown);
  rmSync(slot, { recursive: true }); expect(() => n.reopen(0)).toThrow('slot is missing');
  symlinkSync(historyPoolPaths(base, 2, 1).base, slot); expect(() => n.reopen(0)).toThrow('ordinary directories'); rmSync(slot); mkdirSync(slot);
  const journal = join(base, HISTORY_POOL_FILENAME), saved = readFileSync(journal);
  expect(() => openHistoryVolunteerService({ ...n.options(0), maxBlocks: 20 })).toThrow();
  writeFileSync(journal, '{}'); expect(() => n.reopen(0)).toThrow(); expect(readFileSync(journal, 'utf8')).toBe('{}');
  rmSync(journal); expect(() => n.reopen(0)).toThrow('Unregistered volunteer history');
  // A lost marker neither authorizes cleanup nor recreates the old successor layout.
  expect(existsSync(join(base, `successors-${historyCheckpointEnvelopeId(n.root).slice(7)}`))).toBe(false);
  const external = join(n.directory, 'linked-pool.json'); writeFileSync(external, saved); linkSync(external, journal);
  expect(() => n.reopen(0)).toThrow('ordinary file'); expect(readFileSync(external)).toEqual(saved); rmSync(journal);
  writeFileSync(journal, saved); expect(n.reopen(0).describe()).toMatchObject({ poolSlots: 2, latest: { generation: 0 } });
});

it('funds every fixed slot before publishing the pool selection and can retry partial reservations without additional allocation', async () => {
  const n = await fixture(3, true), authority = n.authority!, used = authority.status().reservedBytes;
  authority.applyLimit(used, authority.reviewLimit(used).approvalDigest);
  const service = n.services[0], plan = service.planPool(2), before = service.describe();
  expect(() => service.enablePool(2, plan.approvalDigest)).toThrow('exhausted');
  expect(existsSync(join(n.options(0).directory, HISTORY_POOL_FILENAME))).toBe(false); expect(service.describe()).toEqual(before);
  authority.applyLimit(used + 1024 * 1024, authority.reviewLimit(used + 1024 * 1024).approvalDigest);
  expect(() => service.enablePool(2, plan.approvalDigest)).toThrow('exhausted');
  expect(authority.status().reservedBytes).toBeGreaterThan(used);
  expect(existsSync(join(n.options(0).directory, HISTORY_POOL_FILENAME))).toBe(false); expect(service.describe()).toEqual(before);
  authority.applyLimit(1024 * 1024 * 1024, authority.reviewLimit(1024 * 1024 * 1024).approvalDigest);
  service.enablePool(2, plan.approvalDigest); const funded = authority.status();
  expect(n.reopen(0).describe()).toMatchObject({ poolSlots: 2 }); expect(authority.status()).toEqual(funded);
});

it.each([
  ['enable', 'before-pool-commit'], ['enable', 'after-pool-commit'], ['enable', 'after-slot-directory'],
  ['enable', 'after-unlink'], ['enable', 'before-cleanup-completion'], ['enable', 'after-cleanup-completion'],
  ['retire', 'before-pool-commit'], ['retire', 'after-pool-commit'], ['retire', 'before-unlink'], ['retire', 'after-unlink'],
  ['retire', 'after-directory'], ['retire', 'before-cleanup-completion'], ['retire', 'after-cleanup-completion'], ['retire', 'durable'],
  ['migrate', 'before-pool-commit'], ['migrate', 'after-pool-commit'], ['migrate', 'before-relocation'], ['migrate', 'after-relocation'],
  ['migrate', 'before-unlink'], ['migrate', 'after-unlink'], ['migrate', 'after-legacy-frontier'],
  ['migrate', 'before-cleanup-completion'], ['migrate', 'after-cleanup-completion'],
])('resumes fixed-pool %s after actual SIGKILL at %s before accepting a new slot occupant', async (action, boundary) => {
  const n = await fixture(3); let root: HistoryCheckpointEnvelope = n.root;
  if (action !== 'enable') {
    if (action === 'retire') for (const service of n.services) service.enablePool(2, service.planPool(2).approvalDigest);
    for (let generation = 0; generation < 2; generation++) {
      const blocks = await n.append(root); root = await n.decide(blocks); await n.provision(root as HistoryContinuationRoot);
    }
  }
  const current = await certifiedGeneration(n, root), before = n.services[0].describe().latest;
  if (action === 'migrate') for (const service of n.services) service.retireGenerations(current.retention, service.planGenerationRetirement(current.retention).approvalDigest);
  const genesisPath = join(n.options(0).directory, 'genesis', 'history-manifest.json'), genesis = readFileSync(genesisPath);
  n.services[0].close();
  const child = fork(new URL('./fixtures/history-pool-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const { signingKey, localKey, ...options } = n.options(0);
  child.send({ options, localKey: localKey.toString('hex'), member: { publicKey: Buffer.from(signingKey.publicKey).toString('hex'),
    secretKey: Buffer.from(signingKey.secretKey).toString('hex') }, ...(action !== 'enable' ? { retention: current.retention } : {}), migrate: action === 'migrate', boundary });
  await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
  if (action === 'migrate' && boundary === 'after-pool-commit') {
    if (root.kind !== 'continuation') throw new Error('Expected a continued history');
    const source = join(options.directory, `successors-${root.proposal.rootId.slice(7)}`, `generation-${historyCheckpointEnvelopeId(root).slice(7)}`);
    const target = historyPoolPaths(options.directory, 2, 2).history, files = readdirSync(source);
    mkdirSync(target, { recursive: true }); expect(() => n.reopen(0)).toThrow('exactly one');
    expect(readdirSync(source)).toEqual(files); rmSync(target, { recursive: true });
    const checkpoint = join(source, `${current.certificate.proposal.envelopeId.slice(7)}.block`), saved = readFileSync(checkpoint);
    writeFileSync(checkpoint, '{}'); expect(() => n.reopen(0)).toThrow(); expect(existsSync(source)).toBe(true); expect(existsSync(target)).toBe(false);
    writeFileSync(checkpoint, saved);
  }
  if (action === 'migrate' && boundary === 'after-relocation') {
    const primary = join(options.directory, HISTORY_POOL_FILENAME), saved = readFileSync(primary);
    const target = historyPoolPaths(options.directory, 2, 2).history, files = readdirSync(target);
    rmSync(primary); expect(() => n.reopen(0)).toThrow(); expect(readdirSync(target)).toEqual(files); writeFileSync(primary, saved);
  }
  if (action === 'retire' && boundary === 'after-pool-commit') {
    const stale = historyPoolPaths(options.directory, 2, 1).history, selected = historyPoolPaths(options.directory, 2, 2).history;
    const checkpoint = join(selected, `${current.certificate.proposal.envelopeId.slice(7)}.block`), saved = readFileSync(checkpoint);
    const oldFiles = readdirSync(stale); writeFileSync(checkpoint, '{}');
    expect(() => n.reopen(0)).toThrow(); expect(readdirSync(stale)).toEqual(oldFiles); writeFileSync(checkpoint, saved);
    const unknown = join(stale, 'preserve.txt'); writeFileSync(unknown, 'preserve');
    expect(() => n.reopen(0)).toThrow('Unexpected retired pool'); expect(readFileSync(unknown, 'utf8')).toBe('preserve');
    expect(readdirSync(stale)).toContain(oldFiles[0]); rmSync(unknown);
  }
  let service = n.reopen(0);
  expect(service.describe().latest).toEqual(before); expect(readFileSync(genesisPath)).toEqual(genesis);
  if (boundary === 'before-pool-commit') {
    if (action === 'retire') service.retireGenerations(current.retention, service.planGenerationRetirement(current.retention).approvalDigest);
    else {
      const evidence = action === 'migrate' ? current.retention : undefined;
      service.enablePool(2, service.planPool(2, evidence).approvalDigest, evidence);
    }
    service = n.reopen(0);
  }
  expect(service.describe()).toMatchObject({ poolSlots: 2, generations: action === 'enable' ? 1 : 2 });
  for (let i = 1; i < 5; i++) {
    if (action === 'retire') n.services[i].retireGenerations(current.retention, n.services[i].planGenerationRetirement(current.retention).approvalDigest);
    else {
      const evidence = action === 'migrate' ? current.retention : undefined;
      n.services[i].enablePool(2, n.services[i].planPool(2, evidence).approvalDigest, evidence);
    }
  }
  // Reuse the just-cleared physical location, accept a delta and checkpoint,
  // then reopen twice. The old cleanup intent must never delete its new occupant.
  const next = await n.decide(current.blocks); await n.provision(next);
  const accepted = await certifiedGeneration(n, next), head = n.services[0].describe().latest;
  for (let i = 0; i < 2; i++) {
    expect(n.reopen(0).describe().latest).toEqual(head);
    expect(n.services[0].retainedCompactionCheckpoint(historyCheckpointEnvelopeId(next))).toEqual(accepted.certificate);
  }
}, 60000);

it.each(['complete ancestry', 'retained frontier'] as const)('migrates %s to fixed locations without changing the selected state or losing its chosen successor', async layout => {
  const n = await fixture(3, true); let root: HistoryCheckpointEnvelope = n.root;
  for (let generation = 0; generation < 2; generation++) {
    root = await n.decide(await n.append(root)); await n.provision(root as HistoryContinuationRoot);
  }
  const current = await certifiedGeneration(n, root), chosen = await n.decide(current.blocks);
  if (root.kind !== 'continuation') throw new Error('Expected a continued history');
  if (layout === 'retained frontier') for (const service of n.services) service.retireGenerations(current.retention, service.planGenerationRetirement(current.retention).approvalDigest);
  const authority = n.authority!, used = authority.status().reservedBytes;
  authority.applyLimit(used, authority.reviewLimit(used).approvalDigest);
  const first = n.services[0], plan = first.planPool(2, current.retention), oldHead = first.describe().latest;
  expect(() => first.planPool(2)).toThrow();
  expect(() => first.planPool(2, { ...current.retention, receipts: current.retention.receipts.slice(0, 3) })).toThrow();
  expect(() => first.enablePool(2, 'wrong', current.retention)).toThrow('review');
  expect(() => first.enablePool(2, plan.approvalDigest, current.retention)).toThrow('exhausted');
  expect(existsSync(join(n.options(0).directory, HISTORY_POOL_FILENAME))).toBe(false); expect(first.describe().latest).toEqual(oldHead);
  authority.applyLimit(2 * 1024 * 1024 * 1024, authority.reviewLimit(2 * 1024 * 1024 * 1024).approvalDigest);
  for (let i = 0; i < 5; i++) {
    const base = n.options(i).directory, source = join(base, `successors-${root.proposal.rootId.slice(7)}`, `generation-${historyCheckpointEnvelopeId(root).slice(7)}`);
    const before = readFileSync(join(source, 'history-manifest.json')), service = n.services[i];
    service.enablePool(2, service.planPool(2, current.retention).approvalDigest, current.retention);
    expect(readFileSync(join(historyPoolPaths(base, 2, 2).history, 'history-manifest.json'))).toEqual(before);
    expect(n.reopen(i).describe()).toMatchObject({ poolSlots: 2, generations: 2, latest: oldHead });
    expect(readdirSync(base).some(name => name.startsWith('successors-') || name === HISTORY_VOLUNTEER_FRONTIER_FILENAME)).toBe(false);
  }
  const funded = authority.status().reservedBytes; authority.applyLimit(funded, authority.reviewLimit(funded).approvalDigest);
  const budget = authority.status(); await n.provision(chosen); const next = await certifiedGeneration(n, chosen);
  for (const service of n.services) service.retireGenerations(next.retention, service.planGenerationRetirement(next.retention).approvalDigest);
  const fourth = await n.decide(next.blocks); await n.provision(fourth); await certifiedGeneration(n, fourth);
  expect(n.reopen(0).describe()).toMatchObject({ latest: { generation: 4 }, poolSlots: 2 }); expect(authority.status()).toEqual(budget);
}, 60000);

it('preserves an interrupted legacy successor and requires its completion before pool migration', async () => {
  const n = await fixture(3), first = await n.decide(await n.append(n.root)); await n.provision(first);
  const certified = await certifiedGeneration(n, first), chosen = await n.decide(certified.blocks), base = n.options(0).directory;
  const parentDirectory = join(base, `successors-${historyCheckpointEnvelopeId(n.root).slice(7)}`, `generation-${historyCheckpointEnvelopeId(first).slice(7)}`);
  n.services[0].close();
  const child = fork(new URL('./fixtures/history-provision-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Provision child exited before readiness'); })]))[0]).toBe('ready');
  child.send({ options: { directory: parentDirectory, context: n.context, replica: n.context.members[0], rootId: historyCheckpointEnvelopeId(first),
    generation: 1, retainedFrontier: { genesisId: historyCheckpointEnvelopeId(n.root), certificate: certified.certificate } },
    directory: join(base, `successors-${historyCheckpointEnvelopeId(first).slice(7)}`), localKey: n.localKey.toString('hex'), request: n.request(chosen, 0), boundary: 'intent',
    member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
  await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
  const service = n.reopen(0); expect(service.describe()).toMatchObject({ latest: { generation: 1 }, provisioning: 'creating' });
  const manifest = readFileSync(join(parentDirectory, 'history-manifest.json'));
  expect(() => service.planPool(2, certified.retention)).toThrow('Complete pending successor');
  expect(readFileSync(join(parentDirectory, 'history-manifest.json'))).toEqual(manifest);
  expect(existsSync(join(base, HISTORY_POOL_FILENAME))).toBe(false);
  await n.provision(chosen); const current = await certifiedGeneration(n, chosen);
  service.enablePool(2, service.planPool(2, current.retention).approvalDigest, current.retention);
  expect(n.reopen(0).describe()).toMatchObject({ poolSlots: 2, latest: { generation: 2 } });
}, 30000);

it.each(['genesis', 'legacy'] as const)('reviews and enables a fixed pool through the actual CLI with existing accepted %s data', async layout => {
  const n = await fixture(); let evidencePath: string | undefined;
  if (layout === 'genesis') await n.append(n.root);
  else {
    let root: HistoryCheckpointEnvelope = n.root;
    for (let generation = 0; generation < 2; generation++) { root = await n.decide(await n.append(root)); await n.provision(root as HistoryContinuationRoot); }
    const current = await certifiedGeneration(n, root); evidencePath = join(n.directory, 'retention.json'); writeFileSync(evidencePath, JSON.stringify(current.retention));
  }
  const enrollment = join(n.directory, 'enrollment.json'), member = join(n.directory, 'member.json'), key = join(n.directory, 'member.hex');
  writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.root }));
  writeFileSync(member, JSON.stringify({ publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('base64url'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(key, n.localKey.toString('hex'), { mode: 0o600 }); const before = n.services[0].describe().latest; n.services[0].close();
  const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url)), args = [enrollment, member, key, n.options(0).directory, '2', ...(evidencePath ? [evidencePath] : [])];
  const command = (...input: string[]) => new Promise<{ code: number | string; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', script, ...input], { timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  const planned = await command('replica-pool-plan', ...args); expect(planned.code).toBe(0); expect(planned.stderr).toBe('');
  const review = JSON.parse(planned.stdout); expect(review).toMatchObject({ slots: 2, maximumGenerations: 3, readiness: 'unverified' });
  expect((await command('replica-pool-enable', '--approve', 'stale', ...args)).code).not.toBe(0);
  const applied = await command('replica-pool-enable', '--approve', review.approvalDigest, ...args);
  expect(applied.stderr).toBe(''); expect(applied.code).toBe(0); expect(JSON.parse(applied.stdout)).toMatchObject({ result: 'history-pool-enabled', readiness: 'unverified' });
  expect(n.reopen(0).describe()).toMatchObject({ poolSlots: 2, latest: before });
}, 30000);

it('retires ancestors through five actual generations within a three-generation limit, retaining genesis and all current barriers', async () => {
  const n = await fixture(3), genesisId = historyCheckpointEnvelopeId(n.root);
  let root: HistoryCheckpointEnvelope = n.root;
  const oldRoots: string[] = [];
  for (let generation = 0; generation < 5; generation++) {
    const current = await certifiedGeneration(n, root); let child: HistoryContinuationRoot | undefined;
    if (generation === 2) {
      child = await n.decide(current.blocks);
      await expect(n.provision(child)).rejects.toThrow(); // Capacity refusal keeps the chosen successor recoverable.
    }
    if (generation >= 2) {
      const heads = n.services.map(service => service.describe().latest);
      for (let i = 0; i < 5; i++) {
        const service = n.services[i], review = service.planGenerationRetirement(current.retention);
        expect(review.retiredDirectories).toBeGreaterThan(0); expect(review.bytesReclaimed).toBeGreaterThan(0);
        expect(() => service.planGenerationRetirement({ ...current.retention, receipts: current.retention.receipts.slice(0, 3) })).toThrow();
        expect(() => service.retireGenerations(current.retention, 'stale')).toThrow('review');
        service.retireGenerations(current.retention, review.approvalDigest);
        expect(n.reopen(i).describe()).toMatchObject({ generations: 2, latest: heads[i] });
        expect(n.services[i].health().generations).toBe(2);
        expect(n.services[i].retainedCompactionCheckpoint(historyCheckpointEnvelopeId(root))).toEqual(current.certificate);
        expect(readdirSync(n.options(i).directory).filter(name => name.startsWith('successors-'))).toHaveLength(2);
      }
      for (const rootId of oldRoots) {
        const issuedAt = Date.now(), request = createHistoryExchangeRequest({ action: 'head', rootId, generation: oldRoots.indexOf(rootId),
          replica: n.context.members[0], challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000,
          sequence: 0, envelopeId: null }, n.context, n.owner.signingKey);
        expect(() => n.services[0].checkpoint({ request, envelope: null })).toThrow('not enrolled');
      }
      expect((await discoverHistoryCompactionFrontier({ context: n.context, genesisId, signingKey: n.owner.signingKey,
        members: n.members })).certificate).toEqual(current.certificate);
    }
    if (generation < 4) { oldRoots.push(historyCheckpointEnvelopeId(root)); child ??= await n.decide(current.blocks); await n.provision(child); root = child; }
  }
  const path = join(n.options(0).directory, HISTORY_VOLUNTEER_FRONTIER_FILENAME), saved = readFileSync(path);
  n.services[0].close(); writeFileSync(path, '{}'); expect(() => n.reopen(0)).toThrow(); expect(readFileSync(path, 'utf8')).toBe('{}');
  rmSync(path); expect(() => n.reopen(0)).toThrow('successor journal'); // No fallback to genesis after marker loss.
  const external = join(n.directory, 'saved-frontier.json'); writeFileSync(external, saved); linkSync(external, path);
  expect(() => n.reopen(0)).toThrow('ordinary file'); expect(readFileSync(external)).toEqual(saved); rmSync(path);
  writeFileSync(path, saved); expect(n.reopen(0).describe().latest.generation).toBe(4);
}, 120000);

it('reviews and retires stopped-volunteer generations through the actual CLI without remote readiness', async () => {
  const n = await fixture(); let root: HistoryCheckpointEnvelope = n.root;
  for (let i = 0; i < 2; i++) { const current = await certifiedGeneration(n, root); root = await n.decide(current.blocks); await n.provision(root as HistoryContinuationRoot); }
  const current = await certifiedGeneration(n, root), enrollment = join(n.directory, 'enrollment.json'), member = join(n.directory, 'member.json');
  const key = join(n.directory, 'member.hex'), evidence = join(n.directory, 'retention.json');
  writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.root }));
  writeFileSync(member, JSON.stringify({ publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('base64url'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(key, n.localKey.toString('hex'), { mode: 0o600 }); writeFileSync(evidence, JSON.stringify(current.retention)); n.services[0].close();
  const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url)), args = [enrollment, member, key, n.options(0).directory, evidence];
  const command = (...input: string[]) => new Promise<{ code: number | string; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', script, ...input], { timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  const plan = await command('replica-generations-plan', ...args); expect(plan.code).toBe(0); expect(plan.stderr).toBe('');
  const review = JSON.parse(plan.stdout); expect(review).toMatchObject({ generation: 2, readiness: 'unverified', retiredDirectories: 1 });
  expect((await command('replica-generations-retire', '--approve', 'wrong', ...args)).code).not.toBe(0);
  const applied = await command('replica-generations-retire', '--approve', review.approvalDigest, ...args);
  expect(applied.stderr).toBe(''); expect(applied.code).toBe(0); expect(JSON.parse(applied.stdout)).toMatchObject({ result: 'history-generations-retired', readiness: 'unverified' });
  expect(n.reopen(0).describe().generations).toBe(2);
}, 60000);

it('funds the authoritative frontier before retirement and preserves lifetime reservations after deleting ancestors', async () => {
  const n = await fixture(65, true); let root: HistoryCheckpointEnvelope = n.root;
  for (let i = 0; i < 2; i++) { const current = await certifiedGeneration(n, root); root = await n.decide(current.blocks); await n.provision(root as HistoryContinuationRoot); }
  const current = await certifiedGeneration(n, root), authority = n.authority!, used = authority.status().reservedBytes;
  authority.applyLimit(used, authority.reviewLimit(used).approvalDigest);
  const before = authority.status(), heads = n.services.map(s => s.describe().latest);
  expect(() => n.services[0].retireGenerations(current.retention, n.services[0].planGenerationRetirement(current.retention).approvalDigest)).toThrow('exhausted');
  expect(existsSync(join(n.options(0).directory, HISTORY_VOLUNTEER_FRONTIER_FILENAME))).toBe(false);
  expect(n.reopen(0).describe().generations).toBe(3); expect(authority.status()).toEqual(before);
  const limit = used + 2 * 128 * 1024 + 8192; authority.applyLimit(limit, authority.reviewLimit(limit).approvalDigest);
  n.services[0].retireGenerations(current.retention, n.services[0].planGenerationRetirement(current.retention).approvalDigest);
  const charged = authority.status(); expect(charged).toMatchObject({ availableBytes: 0, reservedBytes: limit, components: before.components + 1 });
  expect(n.reopen(0).describe()).toMatchObject({ generations: 2, latest: heads[0] }); expect(authority.status()).toEqual(charged);
  const child = await n.decide(current.blocks); await expect(n.provision(child)).rejects.toThrow();
  expect(n.services.every(s => s.describe().latest.generation === 2)).toBe(true);
  expect(authority.status()).toEqual(charged);
}, 60000);

it.each(['before-lock-publication', 'before-journal-write', 'before-commit', 'after-commit', 'before-unlink', 'after-unlink', 'after-directory', 'durable'] as const)(
  'preserves or resumes ancestor retirement after actual SIGKILL at %s', async boundary => {
    const n = await fixture(); let root: HistoryCheckpointEnvelope = n.root;
    for (let i = 0; i < 2; i++) { const current = await certifiedGeneration(n, root); root = await n.decide(current.blocks); await n.provision(root as HistoryContinuationRoot); }
    const current = await certifiedGeneration(n, root), before = n.services[0].describe().latest;
    const genesisPath = join(n.options(0).directory, 'genesis', 'history-manifest.json'), genesis = readFileSync(genesisPath);
    n.services[0].close();
    const child = fork(new URL('./fixtures/history-generation-retirement-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    const { signingKey, localKey, ...options } = n.options(0);
    child.send({ options, localKey: localKey.toString('hex'), member: { publicKey: Buffer.from(signingKey.publicKey).toString('hex'),
      secretKey: Buffer.from(signingKey.secretKey).toString('hex') }, retention: current.retention, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    if (boundary === 'after-commit') {
      if (root.kind !== 'continuation') throw new Error('Expected continuation');
      const base = n.options(0).directory, obsolete = join(base, `successors-${historyCheckpointEnvelopeId(n.root).slice(7)}`);
      const block = join(base, `successors-${root.proposal.rootId.slice(7)}`, `generation-${historyCheckpointEnvelopeId(root).slice(7)}`,
        `${current.certificate.proposal.envelopeId.slice(7)}.block`), saved = readFileSync(block), names = readdirSync(obsolete);
      writeFileSync(block, '{}'); expect(() => n.reopen(0)).toThrow(); expect(readdirSync(obsolete)).toEqual(names); writeFileSync(block, saved);
      const unexpected = join(obsolete, 'keep-for-inspection.txt'); writeFileSync(unexpected, 'preserve');
      expect(() => n.reopen(0)).toThrow('Unexpected retired'); expect(readFileSync(unexpected, 'utf8')).toBe('preserve');
      expect(readdirSync(obsolete)).toContain(names[0]); rmSync(unexpected);
    }
    const committed = !['before-lock-publication', 'before-journal-write', 'before-commit'].includes(boundary); const service = n.reopen(0);
    expect(service.describe()).toMatchObject({ generations: committed ? 2 : 3, latest: before });
    expect(readFileSync(genesisPath)).toEqual(genesis);
    expect(service.retainedCompactionCheckpoint(historyCheckpointEnvelopeId(root))).toEqual(current.certificate);
    if (!committed) service.retireGenerations(current.retention, service.planGenerationRetirement(current.retention).approvalDigest);
    expect(n.reopen(0).describe()).toMatchObject({ generations: 2, latest: before });
    const childRoot = await n.decide(current.blocks); await n.provision(childRoot);
    expect(n.reopen(0).describe().latest.generation).toBe(3);
  }, 60000);

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
