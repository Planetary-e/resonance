import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { createRelayServer } from '../server.js';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import { createRelayContactHintV1 } from '@resonance/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSigningKeyPair } from '@resonance/core';
import { signAdmissionPolicy, admissionPolicyDigest } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance, admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { resolveAdmissionPolicy, prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3, createResolvedAdmissionPolicyAdvance, type AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint, openHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from '../admission-history-recovery.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { loadAdmissionHistoryProtectionFile, parseAdmissionHistoryConfiguration } from '../admission-history-config.js';
import { captureHistoryAncestrySource } from '../history-ancestry-source.js';
import { HISTORY_DOWNLOAD_FILENAME } from '../history-ancestry-download.js';
import { takePreparedAdmissionAncestry } from '../admission-history-restore.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const limits: AdmissionPolicyArchiveLimits = { maxPages: 200, maxEntries: 1000, maxArchiveBytes: 64 * 1024 * 1024,
  maxHistoryBytes: 256 * 1024 * 1024, maxTransitions: 100, maxPageReads: 1000, timeoutMs: 3000 };
async function fixture() {
  const n = await witnessFixture(), h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'relay-ancestry-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const time = Date.now(), body = { ...n.body, issuedAt: time - 1000, expiresAt: time + 86400000 };
  const first = await signAdmissionPolicy(body, n.authority, n.authorityKey.secretKey);
  const second = await signAdmissionPolicy({ ...body, version: 2, revision: 2, archivedKeys: [] }, n.authority, n.authorityKey.secretKey);
  const observers = Array.from({ length: 5 }, generateSigningKeyPair);
  const observerContext = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: n.authority,
    genesis: admissionPolicyHead(first), quorum: 4, members: observers.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${44000 + i}/` })) });
  const advance = await createAdmissionPolicyAdvance(first, second, observerContext, n.authorityKey);
  const context = { ...h.context, authority: n.authority, policyDigest: `sha256:${admissionPolicyDigest(first)}` };
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${43000 + i}/history-checkpoint` }));
  const services: ReturnType<typeof openHistoryVolunteerService>[] = []; let online = 5;
  const service = (publicKey: string) => { const i = context.members.indexOf(publicKey); if (i >= online) throw new Error('offline'); return services[i]; };
  const protection = { context, signingKey: h.owner, members, transport: async (member: { publicKey: string }, frame: any) => service(member.publicKey).checkpoint(frame) };
  const directoryOwner = join(directory, 'original');
  let owner = await openProtectedAdmissionSpendHistory({ directory: directoryOwner, policy: first, authority: n.authority, encryptionKey: h.key,
    initialize: true, protection: { ...protection, initializeWriter: true } }); cleanup.push(owner.close);
  const genesis = owner.enrollment().root; if (genesis.kind !== 'checkpoint') throw new Error('Expected original genesis');
  const genesisId = historyCheckpointEnvelopeId(genesis);
  for (let i = 0; i < 5; i++) { const s = openHistoryVolunteerService({ directory: join(directory, `replica-${i}`), context, genesisId, localKey: h.localKey, signingKey: h.memberKeys[i], initialize: genesis }); services.push(s); cleanup.push(s.close); }
  await owner.ready(); owner.close();
  owner = await openProtectedAdmissionSpendHistory({ directory: directoryOwner, policy: second, authority: n.authority, encryptionKey: h.key, protection }); cleanup.push(owner.close); await owner.ready();
  const trust = { context: observerContext, installed: advance.commitment.next, observed: advance.commitment.next };
  await owner.backfillPolicyProof({ version: 1, kind: 'genesis', policy: first }, trust, limits);
  await owner.backfillPolicyProof({ version: 1, kind: 'advance', advance, pages: [] }, trust); owner.close();
  const reader = async () => { throw new Error('No earlier v3 pages'); };
  const previous = await resolveAdmissionPolicy({ context: observerContext, genesis: first, advances: [advance], selectedHead: advance.commitment.next, reader, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 3, issuedAt: time, expiresAt: second.expiresAt, activeKey: second.activeKey, keys: second.keys }, reader, limits });
  const next = await createResolvedAdmissionPolicyAdvance({ previous, policy: await signAdmissionPolicyV3(plan.body, n.authority, n.authorityKey.secretKey), key: n.authorityKey,
    reader: async digest => { const page = plan.pages.find(p => p.digest === digest); if (!page) throw new Error('Missing page'); return page.bytes; }, limits });
  expect(plan.pages).toHaveLength(0);
  const policy = next.advance.policy;
  owner = await openProtectedAdmissionSpendHistory({ directory: directoryOwner, policy, authority: n.authority, encryptionKey: h.key, protection, policyAdvance: next.advance, policyPages: plan.pages }); cleanup.push(owner.close); await owner.ready(); owner.close();
  const options = { directory: join(directory, 'recovery'), encryptionKey: h.key, genesis, protection,
    agreementTransport: async (member: { publicKey: string }, frame: any) => service(member.publicKey).exchange(frame),
    dataTransport: async (member: { publicKey: string }, frame: any) => service(member.publicKey).transfer(frame),
    provisionTransport: async (member: { publicKey: string }, frame: any) => service(member.publicKey).provision(frame) };
  const review = await prepareAdmissionHistoryRecovery(options), recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  for (let i = 0; i < 10 && !recovery.status().complete; i++) await recovery.advance(); expect(recovery.status().complete).toBe(true);
  const json = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; };
  return { ...h, services, directory, options, recovery, context, genesis, genesisId, policy, protection, json, online: (count: number) => { online = count; } };
}

it('rejects unknown configuration fields and accepts only strict explicit ancestry', () => {
  const n = historyCheckpointFixture(), value = { version: 1, context: n.context, members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${43000+i}/history-checkpoint` })), ownerKeyFile: 'owner.json' };
  expect(parseAdmissionHistoryConfiguration(value).ancestry).toBeUndefined();
  const ancestry = { version: 1, kind: 'recovery-download', directory: 'download', enrollmentFile: 'original.json', continuationFile: 'continued.json', funding: { authorityDirectory: 'funding', authorityId: 'a'.repeat(32) } };
  expect(parseAdmissionHistoryConfiguration({ ...value, ancestry }).ancestry).toEqual(ancestry);
  for (const bad of [{ ...value, initialize: true }, { ...value, ancestry: { ...ancestry, adopt: true } }, { ...value, ancestry: { ...ancestry, funding: { ...ancestry.funding, allowUnmanaged: true } } }]) expect(() => parseAdmissionHistoryConfiguration(bad)).toThrow();
});

it('restores real minimal v3 through actual funded recovery review, transfers source lifetime and reopens/readies strictly', async () => {
  const n = await fixture(), destination = join(n.directory, 'restored');
  await expect(n.recovery.reviewRestore(destination, n.policy)).rejects.toThrow('explicitly selected');
  expect(existsSync(destination)).toBe(false);
  const authorityDirectory = join(n.directory, 'funding'), funding = openStorageReservationAuthority({ directory: authorityDirectory, mode: 'create-new', limitBytes: 1024 ** 3 }); cleanup.push(funding.close);
  const authorityId = funding.status().authorityId, run = <T>(operation: () => T) => withStorageReservationAuthority(funding, operation);
  const downloadDirectory = join(n.options.directory, 'download');
  const enrollment = n.json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis });
  const continuation = n.recovery.status().continuation!, continuationFile = n.json('continuation.json', continuation);
  const ownerKeyFile = n.json('owner.json', { publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') });
  const ancestry = { version: 1 as const, kind: 'recovery-download' as const, directory: downloadDirectory, enrollmentFile: enrollment, continuationFile, funding: { authorityDirectory, authorityId } };
  const configValue = { version: 1, context: n.context, members: n.protection.members, ownerKeyFile, ancestry }, config = n.json('config.json', configValue);
  const captured = captureHistoryAncestrySource(ancestry, config, n.context), originalFunding = funding.status();
  expect(() => run(() => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('reservation'); expect(funding.status()).toEqual(originalFunding);
  funding.reserve({ path: downloadDirectory, scope: 'directory', component: 'history-download-ciphertext', maximumBytes: 252 * 1024 * 1024 });
  const partialFunding = funding.status();
  expect(() => run(() => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('reservation'); expect(funding.status()).toEqual(partialFunding);
  funding.reserve({ path: join(downloadDirectory, HISTORY_DOWNLOAD_FILENAME), scope: 'file', component: 'encrypted-local-state', maximumBytes: 4 * 1024 * 1024 + 8192 });
  const funded = funding.status();
  expect(() => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members })).toThrow('explicitly selected');
  const wrong = captureHistoryAncestrySource({ ...ancestry, funding: { ...ancestry.funding, authorityId: '0'.repeat(32) } }, config, n.context);
  expect(() => run(() => wrong.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('funding'); expect(funding.status()).toEqual(funded);
  const duplicate = join(n.directory, 'duplicate-download'); cpSync(downloadDirectory, duplicate, { recursive: true });
  const other = captureHistoryAncestrySource({ ...ancestry, directory: duplicate }, config, n.context);
  expect(() => run(() => other.assertRecoveryDownload({ directory: downloadDirectory, genesisId: n.genesisId, continuation }))).toThrow('actual recovery'); expect(funding.status()).toEqual(funded);
  const alias = join(n.directory, 'download-alias'); symlinkSync(downloadDirectory, alias, 'dir');
  const aliased = captureHistoryAncestrySource({ ...ancestry, directory: alias }, config, n.context); unlinkSync(alias); symlinkSync(duplicate, alias, 'dir');
  expect(() => run(() => aliased.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('identity changed'); expect(funding.status()).toEqual(funded);
  const originalEnrollment = readFileSync(enrollment);
  const otherGenesis = sealHistoryCheckpoint({ context: n.context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: openHistoryCheckpoint(n.genesis, n.context, n.key), encryptionKey: n.key, signingKey: n.owner });
  n.json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: otherGenesis });
  const wrongGenesis = captureHistoryAncestrySource(ancestry, config, n.context);
  expect(() => run(() => wrongGenesis.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('original genesis'); writeFileSync(enrollment, originalEnrollment);
  const manifestPath = join(downloadDirectory, HISTORY_DOWNLOAD_FILENAME), originalManifest = readFileSync(manifestPath);
  const journal = openEncryptedLocalState<any>({ path: manifestPath, key: n.key, domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024,
    mode: 'open-existing', initial: undefined!, validate: (_): _ is any => true });
  const complete = journal.read(); journal.write({ ...complete, blocks: complete.blocks.slice(0, -1) }); journal.close();
  const incomplete = captureHistoryAncestrySource(ancestry, config, n.context);
  expect(() => run(() => incomplete.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('incomplete'); writeFileSync(manifestPath, originalManifest); expect(funding.status()).toEqual(funded);
  const loaded = loadAdmissionHistoryProtectionFile(config); cleanup.push(() => { loaded.signingKey.secretKey.fill(0); });
  const protection = { ...loaded, transport: n.protection.transport };
  n.recovery.close();
  const recovery = await run(() => openAdmissionHistoryRecovery({ ...n.options, protection })); cleanup.push(recovery.close);
  const abandoned = await run(() => recovery.reviewRestore(join(n.directory, 'abandoned'), n.policy)); abandoned.close?.();
  await expect(run(() => openProtectedAdmissionSpendHistory({ directory: join(n.directory, 'abandoned'), encryptionKey: n.key, authority: n.context.authority, policy: n.policy, initialize: true,
    protection: { ...protection, initializeWriter: true, restore: { preparation: abandoned, approvedDigest: abandoned.review.approvalDigest } } }))).rejects.toThrow('reviewed');
  expect(() => takePreparedAdmissionAncestry(abandoned)).toThrow('closed');
  const parentA = join(n.directory, 'parent-a'), parentB = join(n.directory, 'parent-b'), destinationAlias = join(n.directory, 'destination-alias');
  mkdirSync(parentA); mkdirSync(parentB); symlinkSync(parentA, destinationAlias, 'dir');
  const aliasedDestination = join(destinationAlias, 'restored'), pathReview = await run(() => recovery.reviewRestore(aliasedDestination, n.policy));
  unlinkSync(destinationAlias); symlinkSync(parentB, destinationAlias, 'dir');
  await expect(run(() => openProtectedAdmissionSpendHistory({ directory: aliasedDestination, encryptionKey: n.key, authority: n.context.authority, policy: n.policy, initialize: true,
    protection: { ...protection, initializeWriter: true, restore: { preparation: pathReview, approvedDigest: pathReview.review.approvalDigest } } }))).rejects.toThrow('reviewed'); pathReview.close?.();
  expect(existsSync(join(parentA, 'restored')) || existsSync(join(parentB, 'restored'))).toBe(false);
  const preparation = await run(() => recovery.reviewRestore(destination, n.policy));
  expect(preparation.review.generation).toBe(1);
  const history = await run(() => openProtectedAdmissionSpendHistory({ directory: destination, encryptionKey: n.key, authority: n.context.authority, policy: n.policy, initialize: true,
    protection: { ...protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } })); cleanup.push(history.close);
  recovery.close(); preparation.close?.();
  expect(() => run(() => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members }))).toThrow('already open');
  n.online(3); await expect(history.ready()).rejects.toThrow('Four'); n.online(4); await history.ready(); n.online(5);
  expect((await history.resolvedPolicy()).reference.head.revision).toBe(3); history.close();
  expect(() => takePreparedAdmissionAncestry(preparation)).toThrow();
  const open = () => openProtectedAdmissionSpendHistory({ directory: destination, encryptionKey: n.key, authority: n.context.authority, policy: n.policy, protection });
  const reopened = await run(open); cleanup.push(reopened.close); expect(() => reopened.policy()).toThrow('fresh readiness'); await reopened.ready(); reopened.close();
  // Inspection and reviewed apply consume original ancestry independently of the recovery parent's lifetime.
  const retainedParent = await run(() => openAdmissionHistoryRecovery({ ...n.options, protection })); cleanup.push(retainedParent.close);
  const readiness = await run(() => retainedParent.reviewReadiness(destination, n.policy)); cleanup.push(readiness.close); retainedParent.close();
  expect(readiness.review().readiness).toBe('unverified'); await run(() => readiness.apply(readiness.review().approvalDigest)); readiness.close();
  const before = readFileSync(join(destination, 'admission-spends-v2.jsonl'));
  const manifest = join(downloadDirectory, HISTORY_DOWNLOAD_FILENAME), manifestBytes = readFileSync(manifest); writeFileSync(manifest, 'damaged');
  await expect(run(open)).rejects.toThrow('manifest changed'); expect(readFileSync(join(destination, 'admission-spends-v2.jsonl')).equals(before)).toBe(true); writeFileSync(manifest, manifestBytes);
  const block = join(downloadDirectory, readdirSync(downloadDirectory).find(name => name.endsWith('.block'))!), ciphertext = readFileSync(block); writeFileSync(block, '{}');
  await expect(run(open)).rejects.toThrow(); expect(readFileSync(join(destination, 'admission-spends-v2.jsonl')).equals(before)).toBe(true); writeFileSync(block, ciphertext);
  const pin = readFileSync(continuationFile); n.json('continuation.json', { ...continuation, generation: 2 }); await expect(run(open)).rejects.toThrow('pin file changed'); writeFileSync(continuationFile, pin);
  const wrongRoot = { ...protection, ancestrySelection: undefined, ancestrySource: undefined, expectedAncestry: { rootId: n.genesisId, genesisId: n.genesisId }, initializeWriter: true };
  await expect(run(() => openProtectedAdmissionSpendHistory({ directory: destination, encryptionKey: n.key, authority: n.context.authority, policy: n.policy, protection: wrongRoot }))).rejects.toThrow('persisted');
  expect(readFileSync(join(destination, 'admission-spends-v2.jsonl')).equals(before)).toBe(true);
  const source = run(() => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members })); source.close();
  await runtimeChecks(n, destination, funding, configValue, config, captured);
}, 90000);

async function runtimeChecks(n: Awaited<ReturnType<typeof fixture>>, destination: string,
  funding: ReturnType<typeof openStorageReservationAuthority>, configValue: any, config: string, captured: ReturnType<typeof captureHistoryAncestrySource>) {
  const verifier = await withStorageReservationAuthority(funding, () => createConfiguredAdmissionVerifier({ directory: destination, authority: n.context.authority,
    policy: n.policy, encryptionKey: n.key, initialize: true, initializeSpendHistory: false, historyProtection: { ...n.protection, ancestrySelection: captured } }));
  verifier.close();
  let online = 5;
  const listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
  for (let i = 0; i < 5; i++) { const listener = await listenHistoryAgreementReplica({
    checkpoint: frame => { if (i >= online) throw new Error('offline'); return n.services[i].checkpoint(frame); },
    exchange: frame => n.services[i].exchange(frame), transfer: frame => n.services[i].transfer(frame), provision: frame => n.services[i].provision(frame),
  }); listeners.push(listener); cleanup.push(listener.close); }
  n.json('config.json', { ...configValue, members: configValue.members.map((member: any, i: number) => ({ ...member, endpoint: listeners[i].checkpointEndpoint })) });
  const authority = join(n.directory, 'authority.pub'), policy = n.json('policy.json', n.policy), key = join(n.directory, 'policy-key.hex');
  writeFileSync(authority, n.context.authority); writeFileSync(key, n.key.toString('hex'), { mode: 0o600 });
  const holder = createServer(); holder.listen(0, '127.0.0.1'); await once(holder, 'listening');
  const port = (holder.address() as { port: number }).port; await new Promise<void>(resolve => holder.close(() => resolve()));
  const id = funding.status().authorityId, authorityDirectory = configValue.ancestry.funding.authorityDirectory;
  const targets = [{ path: destination, scope: 'directory' as const }, { path: n.options.directory, scope: 'directory' as const }], adoption = funding.reviewExisting(targets); funding.adoptExisting(targets, adoption.approvalDigest);
  const selected = n.json('selection.json', { version: 1, kind: 'relay-storage-selection', authorityDirectory, authorityId: id, runtimeDirectory: destination,
    runtimePort: port, runtimeHost: '127.0.0.1', controls: [] });
  funding.close();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  function start(overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../main.ts', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...inherited, RELAY_DATA_DIR: destination, RELAY_PORT: String(port), RELAY_HOST: '127.0.0.1', RELAY_STORAGE_SELECTION_FILE: selected,
      RELAY_STORAGE_CAPACITY_BYTES: '1048576', RELAY_STORAGE_AVAILABLE_BYTES: '1048576', RELAY_JOURNAL_STORAGE_QUOTA_BYTES: '1048576',
      RELAY_ADMISSION_AUTHORITY_FILE: authority, RELAY_ADMISSION_POLICY_FILE: policy, RELAY_ADMISSION_POLICY_KEY_FILE: key, RELAY_ADMISSION_HISTORY_FILE: config, ...overrides } });
    const exited = once(child, 'exit'); let output = '';
    child.stdout.on('data', bytes => { output += String(bytes); }); child.stderr.on('data', bytes => { output += String(bytes); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000); exited.finally(() => clearTimeout(timer));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    return { child, exited, output: () => output, async event(name: string) { const until = performance.now() + 15000;
      while (!output.includes(`"event":"${name}"`)) { if (child.exitCode !== null || child.signalCode !== null || performance.now() > until) throw new Error(`Runtime missing ${name}: ${output}`); await new Promise(resolve => setTimeout(resolve, 10)); } } };
  }
  const first = start(); await first.event('started'); first.child.kill('SIGTERM'); expect((await first.exited)[0], first.output()).toBe(0);
  const reopenedFunding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId: id, mode: 'open-existing' });
  const source = withStorageReservationAuthority(reopenedFunding, () => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members })); source.close(); reopenedFunding.close();
  online = 3; const failed = start(); expect((await failed.exited)[0], failed.output()).toBe(1); expect(failed.output()).not.toContain('"event":"started"'); online = 5;
  // Reverse links listen first and retain the same authenticated source until deferred shutdown.
  const controller = loadOrCreateRelayIdentity(destination), volunteerDirectories = n.context.members.map((_, i) => join(n.directory, `relay-${i}`));
  const ids = volunteerDirectories.map(directory => loadOrCreateRelayIdentity(directory).did);
  const links = n.json('links.json', { version: 1, members: n.context.members.map((publicKey, i) => ({ publicKey, relayId: ids[i] })) });
  n.json('config.json', configValue); // Direct endpoints deliberately remain unreachable.
  const reverse = start({ RELAY_ADMISSION_HISTORY_LINKS_FILE: links, RELAY_PUBLIC_ENDPOINTS: `ws://127.0.0.1:${port}/` }); await reverse.event('started'); expect(reverse.output()).not.toContain('"event":"admission_ready"');
  const volunteers = [];
  for (let i = 0; i < 5; i++) {
    const router = new HistoryRelayRouter({ acceptedRelayIds: [controller.did], handler(method, frame) { return method === 'agreement' ? n.services[i].exchange(frame) : n.services[i][method](frame); } }); cleanup.push(router.close.bind(router));
    const relay = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: volunteerDirectories[i], historyLinks: router,
      relayDiscovery: { endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'], descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
      relayLinks: { targets: [createRelayContactHintV1('configured', `ws://127.0.0.1:${port}/`, controller.did)], reconnectBaseMs: 50, reconnectMaxMs: 100 } });
    volunteers.push(relay); cleanup.push(() => relay.stop({ graceful: false })); await relay.start();
  }
  await reverse.event('admission_ready'); reverse.child.kill('SIGTERM'); expect((await reverse.exited)[0], reverse.output()).toBe(0);
  for (const relay of volunteers) await relay.stop({ graceful: false });
  const shutdown = start({ RELAY_ADMISSION_HISTORY_LINKS_FILE: links, RELAY_PUBLIC_ENDPOINTS: `ws://127.0.0.1:${port}/` }); await shutdown.event('started'); shutdown.child.kill('SIGTERM'); expect((await shutdown.exited)[0], shutdown.output()).toBe(0);
  const finalFunding = openStorageReservationAuthority({ directory: authorityDirectory, authorityId: id, mode: 'open-existing' });
  const finalSource = withStorageReservationAuthority(finalFunding, () => captured.open({ localKey: n.key, signingKey: n.owner, members: n.protection.members })); finalSource.close(); finalFunding.close();
}
