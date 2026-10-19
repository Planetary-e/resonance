import { afterEach, afterAll, beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, renameSync, openSync, fsyncSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { performance } from 'node:perf_hooks';
import * as walletModule from '../blind-admission-wallet.js';
import * as profiles from '../admission-wallet-profile.js';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createRelayTestEndpoints, type RelayTestEndpoint } from '../../../relay/src/__tests__/fixtures/relay-test-endpoint.js';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, createAdmissionRequestBindingV2, generateSigningKeyPair } from '@resonance/core';
import * as policyModule from '@resonance/core/admission-policy';
import { signAdmissionPolicy, admissionKeyFingerprint, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { createAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { createResolvedAdmissionPolicyAdvance, prepareAdmissionPolicyV3Successor, resolveAdmissionPolicy, signAdmissionPolicyV3,
  type ArchivedAdmissionPolicyAdvance, type AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { parseAdmissionWalletProfile } from '../admission-wallet-profile.js';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import type { WalletPolicyObservation } from '../wallet-policy-freshness.js';
const handles = vi.hoisted(() => ({ open: 0, peak: 0 }));
vi.mock('../blind-admission-wallet.js', async original => {
  const module = await original<typeof import('../blind-admission-wallet.js')>();
  return { ...module, openBlindAdmissionWalletV2: (...args: Parameters<typeof module.openBlindAdmissionWalletV2>) => {
    const wallet = module.openBlindAdmissionWalletV2(...args); handles.open++; handles.peak = Math.max(handles.peak, handles.open);
    let closed = false; return { ...wallet, close() { if (!closed) { closed = true; handles.open--; wallet.close(); } } };
  } };
});
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync), openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(close => close()); });
const signingKey = generateSigningKeyPair(), authority = Buffer.from(signingKey.publicKey).toString('base64url');
const observerKeys = Array.from({ length: 5 }, generateSigningKeyPair);
const members = observerKeys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${44000 + i}/` }));
const limits: AdmissionPolicyArchiveLimits = { maxPages: 256, maxEntries: 16384, maxArchiveBytes: 20_000_000,
  maxHistoryBytes: 20_000_000, maxTransitions: 100, maxPageReads: 256, timeoutMs: 3000 };
let entries: AdmissionPolicyKey[], genesis: Awaited<ReturnType<typeof signAdmissionPolicy>>, context: ReturnType<typeof parseAdmissionPolicyObservers>;
let pagesByStep: Array<Array<{ digest: string; bytes: Uint8Array }>>;
let advances: ArchivedAdmissionPolicyAdvance[], migrationPages: Array<{ digest: string; bytes: Uint8Array }>, tokens: string[][];
let relayUrl = 'ws://127.0.0.1:45000/';
let boundaryEndpoint: RelayTestEndpoint;
afterAll(async () => { await boundaryEndpoint?.close(); });
beforeAll(async () => {
  [boundaryEndpoint] = await createRelayTestEndpoints(1, '::1'); relayUrl = `ws://[::1]:${boundaryEndpoint.port}/`; request.relayUrl = relayUrl;
  const rsa = Array.from({ length: 101 }, () => generateKeyPairSync('rsa', { modulusLength: 2048 }));
  const witnesses = { version: 1 as const, quorum: 4 as const, members, coordinators: [authority] };
  entries = rsa.map((pair, i) => ({ profile: { version: 1, scope: { issuer: 'wallet-proof', community: 'public', epoch: `period-${i}` },
    issuerPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: [relayUrl] },
    notBefore: 1000 + i * 10, issueUntil: 1001 + i * 10, spendUntil: 1002 + i * 10, retryUntil: 1003 + i * 10, witnesses }));
  const fields = (i: number) => ({ revision: i + 1, issuedAt: 1000 + i * 10, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[i].profile.issuerPublicKey), keys: [entries[i]] });
  genesis = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', ...fields(0) }, authority, signingKey.secretKey);
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(genesis), quorum: 4, members });
  advances = []; let previous = genesis, head = context.genesis;
  for (let index = 1; index <= 64; index++) {
    const next = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', ...fields(index), archivedKeys: entries.slice(0, index) }, authority, signingKey.secretKey);
    const advance = await createAdmissionPolicyAdvance(previous, next, context, signingKey, head); advances.push(advance); previous = next; head = advance.commitment.next;
  }
  const pages = new Map<string, Uint8Array>(), reader = async (digest: string) => { const bytes = pages.get(digest); if (!bytes) throw new Error('Missing fixture page'); return bytes; };
  let resolved = await resolveAdmissionPolicy({ context, genesis, advances, selectedHead: head, reader, limits });
  pagesByStep = Array.from({ length: 64 }, () => []);
  for (let index = 65; index <= 100; index++) {
    const plan = await prepareAdmissionPolicyV3Successor({ previous: resolved, next: fields(index), reader, limits });
    if (index === 65) migrationPages = plan.pages;
    pagesByStep.push(plan.pages); for (const page of plan.pages) pages.set(page.digest, page.bytes);
    const signed = await signAdmissionPolicyV3(plan.body, authority, signingKey.secretKey);
    const next = await createResolvedAdmissionPolicyAdvance({ previous: resolved, policy: signed, key: signingKey, reader, limits });
    advances.push(next.advance); resolved = next.resolved;
  }
  tokens = [];
  for (const i of [0, 1, 2, 100]) {
    const parsed = await parseAdmissionWalletProfile(entries[i].profile);
    const privateKey = await crypto.subtle.importKey('pkcs8', rsa[i].privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
    const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, entries[i].profile.scope.issuer, privateKey, parsed.publicKey);
    tokens[i] = [];
    for (let j = 0; j < 2; j++) {
      const request = await createBlindAdmissionRequestV2(entries[i].profile.scope, parsed.publicKey);
      tokens[i].push(await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request)));
    }
  }
}, 60000);
function fixture(maxCiphertextBytes = 16 * 1024 * 1024, maxRecords = 256) {
  const root = mkdtempSync(join(tmpdir(), 'wallet-proof-')), directory = join(root, 'wallet'), proofDirectory = join(root, 'proof');
  const funding = openStorageReservationAuthority({ directory: join(root, 'authority'), mode: 'create-new', limitBytes: 2 * 1024 ** 3 });
  const options = { directory, encryptionKey: randomBytes(32), now: () => now,
    proofStorage: { authority: funding, authorityId: funding.status().authorityId, directory: proofDirectory, maxCiphertextBytes, maxRecords, limits } };
  let now = 1000;
  cleanup.push(() => { funding.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, proofDirectory, funding, setNow(value: number) { now = value; }, observation(head: AdmissionPolicyHead = context.genesis): WalletPolicyObservation {
    const query = createAdmissionPolicyQuery(context, now);
    return { query, reply: { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
      votes: observerKeys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, context, key, now)) } } };
  } };
}
const request = { relayUrl, action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { real: 'wallet-proof' }) };
it('retains101 local profiles across100 signed transitions with bounded handles, paged status and funded reopen', async () => {
  const n = fixture(); handles.peak = handles.open;
  const boundary = await preparePrivateBoundary(n);
  try {
  const started = performance.now(); let privateUpdateMs = 0; let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); await wallet.importTokens(tokens[0]);
  const reserved = wallet.capabilityFor({ ...request, policyObservation: n.observation() });
  expect(wallet.capabilityFor({ ...request, policyObservation: n.observation() })).toEqual(reserved);
  for (let i = 0; i < advances.length; i++) {
    n.setNow(1010 + i * 10);
    if (i === 99) { wallet.close(); privateUpdateMs = await boundary.update(); wallet = await openManagedAdmissionWallet(n.options); }
    else await wallet.appendPolicyProof({ advance: advances[i], pages: pagesByStep[i] });
    if ([70, 71, 98].includes(i)) {
      wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
      expect(wallet.status().archivedTotal).toBe(i + 1);
    }
  }
  expect(wallet.status()).toMatchObject({ policy: { revision: 101, archivedKeys: 100, currentKeys: 1 } });
  const firstPage = wallet.status(); expect(firstPage.archived).toHaveLength(72); expect(firstPage.archivedTotal).toBe(100);
  const lastPage = wallet.status(firstPage.nextCursor); expect(lastPage.archived).toHaveLength(28); expect(lastPage.nextCursor).toBeUndefined();
  expect(new Set([...firstPage.archived, ...lastPage.archived].map(entry => entry.keyFingerprint)).size).toBe(100);
  expect(() => wallet.status(Buffer.from(JSON.stringify({ generation: 'old', offset: 72 })).toString('base64url'))).toThrow('Stale');
  expect(handles.peak).toBeLessThanOrEqual(2); expect(handles.open).toBe(1);
  expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[99].commitment.next) })).toThrow('not active');
  const plan = wallet.planRetirement(genesis.activeKey); wallet.retire(genesis.activeKey, plan.approvalDigest);
  await wallet.importTokens(tokens[100]);
  const freshRequest = { ...request, requestBinding: createAdmissionRequestBindingV2('search', { real: 'current' }), policyObservation: n.observation(advances[99].commitment.next) };
  const current = wallet.capabilityFor(freshRequest);
  wallet.close();
  const actualOpen = vi.mocked(openSync).getMockImplementation()!, reads = { pages: 0 };
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => { if (basename(String(args[0])).startsWith('page-')) reads.pages++; return actualOpen(...args); });
  let lastRead: (() => void) | undefined; const visited: string[] = [];
  const actualOpenWallet = walletModule.openBlindAdmissionWalletV2;
  const walletReadSpy = vi.spyOn(walletModule, 'openBlindAdmissionWalletV2').mockImplementation(options => {
    const low = actualOpenWallet(options);
    return { ...low, reservedCapabilityFor(value) {
      const result = low.reservedCapabilityFor(value);
      if (lastRead) { visited.push(options.path); if (options.path.endsWith(`admission-wallet-${admissionKeyFingerprint(entries[100].profile.issuerPublicKey).slice(7)}.json`)) lastRead(); }
      return result;
    } };
  });
  const reopenStart = performance.now(); wallet = await openManagedAdmissionWallet(n.options); const reopenMs = performance.now() - reopenStart;
  vi.mocked(openSync).mockImplementation(actualOpen);
  expect(reads.pages).toBe(148); expect(reopenMs).toBeLessThan(limits.timeoutMs);
  const actual = inventory(n.proofDirectory), snapshotBytes = statSync(join(n.options.directory, 'admission-profile.json')).size;
  expect(actual.bytes + 2 * 32768 + 8192).toBeLessThan(n.options.proofStorage.maxCiphertextBytes);
  expect(actual.records + 3).toBeLessThanOrEqual(n.options.proofStorage.maxRecords); expect(snapshotBytes).toBeLessThan(2 * 1024 * 1024);
  expect(n.options.proofStorage.authority.status().reservedBytes).toBeLessThanOrEqual(2 * 1024 ** 3);
  writeFileSync(join(tmpdir(), 'resonance-wallet-v7-measurement.json'), JSON.stringify({ profiles: 101, transitions: 100, ...actual, snapshotBytes, privateUpdateMs, reservedBytes: n.options.proofStorage.authority.status().reservedBytes, peakWalletHandles: handles.peak, reopenPageReads: reads.pages, reopenMs, lifecycleMs: performance.now() - started }));
  expect(wallet.capabilityFor(freshRequest)).toEqual(current);
  const activePath = join(n.options.directory, `admission-wallet-${admissionKeyFingerprint(entries[100].profile.issuerPublicKey).slice(7)}.json`), activeBytes = readFileSync(activePath);
  expect(wallet.status().available).toBe(1);
  const monotonicStart = performance.now(), monotonic = vi.spyOn(performance, 'now').mockReturnValue(monotonicStart);
  try {
    lastRead = () => monotonic.mockReturnValue(monotonicStart + limits.timeoutMs); visited.length = 0;
    expect(() => wallet.capabilityFor({ ...request, requestBinding: createAdmissionRequestBindingV2('search', { deadline: 'last-read' }), policyObservation: n.observation(advances[99].commitment.next) })).toThrow('scan timed out');
    expect(visited).toHaveLength(101); expect(visited.at(-1)).toBe(activePath); expect(readFileSync(activePath)).toEqual(activeBytes);
  } finally { monotonic.mockRestore(); lastRead = undefined; }
  const query = createAdmissionPolicyQuery(context, 2000, 1), shortObservation: WalletPolicyObservation = { query, reply: { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate', votes: observerKeys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, advances[99].commitment.next, context, key, 2000)) } } };
  try {
    lastRead = () => n.setNow(query.request.expiresAt); visited.length = 0;
    expect(() => wallet.capabilityFor({ ...request, requestBinding: createAdmissionRequestBindingV2('search', { freshness: 'last-read' }), policyObservation: shortObservation })).toThrow('expired admission policy head request');
    expect(visited).toHaveLength(101); expect(visited.at(-1)).toBe(activePath); expect(readFileSync(activePath)).toEqual(activeBytes);
  } finally { n.setNow(2000); lastRead = undefined; walletReadSpy.mockRestore(); }
  expect(wallet.status().available).toBe(1);
  expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[99].commitment.next) })).toThrow('permanently retired');
  wallet.close();
  await expect(openManagedAdmissionWallet({ ...n.options, proofStorage: undefined })).rejects.toThrow('funded policy proof');
  const catalogue = join(n.proofDirectory, readdirSync(n.proofDirectory).find(name => name.startsWith('catalogue-'))!);
  const catalogueBytes = readFileSync(catalogue); rmSync(catalogue);
  await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow(); writeFileSync(catalogue, catalogueBytes);
  writeFileSync(catalogue, randomBytes(catalogueBytes.length)); await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow(); writeFileSync(catalogue, catalogueBytes);
  const page = join(n.proofDirectory, readdirSync(n.proofDirectory).find(name => name.startsWith('page-'))!);
  const original = readFileSync(page); writeFileSync(page, randomBytes(original.length));
  await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow(); writeFileSync(page, original);
  const genesisRecord = join(n.proofDirectory, 'record-0.bin'), genesisBytes = readFileSync(genesisRecord);
  writeFileSync(genesisRecord, Buffer.alloc(512 * 1024 + 4096 + 8192 + 1));
  await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow('Invalid wallet proof ciphertext'); writeFileSync(genesisRecord, genesisBytes);
  const record = join(n.proofDirectory, 'record-32.bin'), retained = readFileSync(record); rmSync(record);
  await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow(); writeFileSync(record, retained);
  rmSync(join(n.options.directory, 'admission-wallet.json'));
  await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow('wallet is missing');
  } finally { await boundary.close(); }
}, 60000);

it('backfills pinnedv5 resumably without changing the installed policy or observed floor', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet({ ...n.options, proofStorage: undefined }); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context);
  for (let i = 0; i < 3; i++) { n.setNow(1010 + i * 10); await wallet.installPolicy(advances[i], authority); }
  wallet.observePolicy(n.observation(advances[4].commitment.next));
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  await wallet.beginPolicyProof(genesis, context); await wallet.appendPolicyProof({ advance: advances[0], pages: [] });
  expect(wallet.status().freshness).toMatchObject({ installedRevision: 4, observedRevision: 6 });
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  expect(wallet.policyProofCursor()?.head).toEqual(advances[0].commitment.next);
  await wallet.appendPolicyProof({ advance: advances[1], pages: [] }); await wallet.appendPolicyProof({ advance: advances[2], pages: [] });
  expect(wallet.status().freshness).toMatchObject({ installedRevision: 4, observedRevision: 6 });
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  expect(wallet.policyProofCursor()?.head).toEqual(advances[2].commitment.next);
  expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[2].commitment.next) })).toThrow('older than');
});

it('refuses insufficient token-file funding before publishing or activating a successor', async () => {
  const n = fixture(); const funding = n.funding;
  let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context);
  const used = funding.status().reservedBytes, review = funding.reviewLimit(used); funding.applyLimit(used, review.approvalDigest);
  n.setNow(1010);
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('budget exhausted');
  expect(wallet.status().policy?.revision).toBe(1); expect(readdirSync(n.proofDirectory)).not.toContain('record-1.bin');
});

it('charges staged orphan bytes/count and refuses wrong heads or cancellation before activation', async () => {
  const n = fixture(); const wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010);
  await expect(wallet.appendPolicyProof({ advance: advances[1], pages: [] })).rejects.toThrow('gap or fork');
  const controller = new AbortController(); controller.abort();
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] }, controller.signal)).rejects.toThrow();
  writeFileSync(join(n.proofDirectory, '.interrupted-ciphertext'), Buffer.alloc(n.options.proofStorage.maxCiphertextBytes));
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('capacity exhausted');
  rmSync(join(n.proofDirectory, '.interrupted-ciphertext'));
  expect(wallet.status().policy?.revision).toBe(1);
  for (let i = 0; i < n.options.proofStorage.maxRecords; i++) writeFileSync(join(n.proofDirectory, `orphan-${i}`), '');
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('capacity exhausted');
});

it('poisons after proof publication flush failure and reuses exact staged evidence after reopening', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010);
  const originalRename = vi.mocked(renameSync).getMockImplementation()!;
  vi.mocked(renameSync).mockImplementation((source, destination) => {
    if (basename(String(destination)) === 'record-1.bin') throw new Error('publication interrupted');
    return originalRename(source, destination);
  });
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('publication interrupted');
  expect(() => wallet.status()).toThrow();
  wallet.close(); vi.mocked(renameSync).mockImplementation(originalRename); wallet = await openManagedAdmissionWallet(n.options);
  expect(wallet.status().policy?.revision).toBe(1);
  await wallet.appendPolicyProof({ advance: advances[0], pages: [] });
  expect(wallet.status().policy?.revision).toBe(2);
});


it('checks independently supplied authority before creating a funded genesis journal', async () => {
  const n = fixture(), wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  const wrong = Buffer.from(generateSigningKeyPair().publicKey).toString('base64url');
  await expect(wallet.installPolicy(genesis, wrong, context)).rejects.toThrow('independently pinned authority');
  expect(wallet.configured()).toBe(false); expect(readdirSync(n.proofDirectory)).not.toContain('record-0.bin');
});

it('retains the selected resource envelope and captures authority configuration for delayed token-wallet creation', async () => {
  const n = fixture(), original = n.options.proofStorage.authority, wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context);
  n.options.proofStorage.authority = { reserve() { throw new Error('mutated caller authority'); }, status() { return { authorityId: '0'.repeat(32) }; } } as unknown as typeof original;
  n.setNow(1010); await wallet.appendPolicyProof({ advance: advances[0], pages: [] });
  wallet.close(); n.options.proofStorage.authority = original;
  await expect(openManagedAdmissionWallet({ ...n.options, proofStorage: { ...n.options.proofStorage, maxRecords: 255 } })).rejects.toThrow('selection or limits');
  const reopened = await openManagedAdmissionWallet(n.options); reopened.close();
});

function inventory(directory: string): { bytes: number; records: number } {
  let bytes = 0, records = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), stat = statSync(path); records++;
    if (stat.isDirectory()) { const nested = inventory(path); bytes += nested.bytes; records += nested.records; }
    else bytes += stat.size;
  }
  return { bytes, records };
}
it('refuses one-byte and one-record aggregate exhaustion and reopens a near-capacity activated head', async () => {
  const n = fixture(100_000), wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010);
  const current = inventory(n.proofDirectory), controlBytes = 2 * 32768 + 8192;
  const ciphertext = readFileSync(join(n.proofDirectory, 'record-0.bin'));
  const priorTip = 'sha256:' + (await import('node:crypto')).createHash('sha256').update(ciphertext).digest('hex');
  const nextBytes = Buffer.byteLength(JSON.stringify({ version: 1, previous: priorTip, kind: 'advance', value: advances[0] })) + 28;
  const orphan = join(n.proofDirectory, '.orphan-boundary');
  writeFileSync(orphan, Buffer.alloc(n.options.proofStorage.maxCiphertextBytes - controlBytes - current.bytes - nextBytes + 1));
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('capacity exhausted');
  expect(wallet.status().policy?.revision).toBe(1); rmSync(orphan);
  const count = inventory(n.proofDirectory).records;
  for (let i = count + 3; i < n.options.proofStorage.maxRecords; i++) writeFileSync(join(n.proofDirectory, `.orphan-${i}`), '');
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('capacity exhausted');
  for (const name of readdirSync(n.proofDirectory)) if (name.startsWith('.orphan-')) rmSync(join(n.proofDirectory, name));
  let accepted = 0, refused = false;
  for (let i = 0; i < 10; i++) {
    n.setNow(1010 + i * 10);
    try { await wallet.appendPolicyProof({ advance: advances[i], pages: [] }); accepted++; }
    catch (error) { expect(String(error)).toContain('capacity exhausted'); refused = true; break; }
  }
  expect(refused).toBe(true); expect(accepted).toBeGreaterThan(0); wallet.close();
  const reopened = await openManagedAdmissionWallet(n.options);
  try { expect(reopened.status().policy?.revision).toBe(accepted + 1); } finally { reopened.close(); }
});

it('refuses forged resolved retirement membership and bounds cancellation during activation key parsing', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010);
  const resolved = await resolveAdmissionPolicy({ context, genesis, advances: [advances[0]], selectedHead: advances[0].commitment.next,
    reader: async () => { throw new Error('Unexpected page'); }, limits, retainIssuerKeys: [genesis.activeKey] });
  const parsed = await parseAdmissionWalletProfile(entries[0].profile), low = openBlindAdmissionWalletV2({ path: join(n.root, 'forged-wallet.json'),
    scope: entries[0].profile.scope, issuerPublicKey: parsed.publicKey, encryptionKey: n.options.encryptionKey, now: () => 1010 });
  try { expect(() => low.planResolvedRetirement(resolved, { ...entries[0], retryUntil: 0 } as never)).toThrow('membership capability'); } finally { low.close(); }
  const controller = new AbortController();
  vi.spyOn(profiles, 'parseAdmissionWalletProfile').mockImplementationOnce(async () => { controller.abort(); return new Promise(() => {}); });
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] }, controller.signal)).rejects.toThrow('cancelled');
  expect(wallet.status().policy?.revision).toBe(1);
  vi.restoreAllMocks(); wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  await wallet.appendPolicyProof({ advance: advances[0], pages: [] }); expect(wallet.status().policy?.revision).toBe(2);
});

it.each(['before-catalogue', 'after-catalogue', 'before-profile-activation', 'after-profile-activation'])('preserves activation across actual process death at %s', async boundary => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet({ ...n.options, proofStorage: undefined });
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010); await wallet.installPolicy(advances[0], authority);
  wallet.observePolicy(n.observation(advances[1].commitment.next)); wallet.close(); n.funding.close();
  const inputPath = join(n.root, 'crash-input.json'), marker = join(n.root, 'crash-boundary.txt');
  writeFileSync(inputPath, JSON.stringify({ directory: n.options.directory, key: n.options.encryptionKey.toString('hex'),
    authorityDirectory: join(n.root, 'authority'), authorityId: n.options.proofStorage.authorityId, proofDirectory: n.proofDirectory,
    maxCiphertextBytes: n.options.proofStorage.maxCiphertextBytes, maxRecords: n.options.proofStorage.maxRecords, limits,
    genesis, context, advance: advances[0], marker, boundary }));
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/wallet-proof-crash.ts', import.meta.url)), inputPath],
    { encoding: 'utf8', timeout: 15000 });
  expect(child.error).toBeUndefined();
  expect(readFileSync(marker, 'utf8')).toBe(boundary);
  expect(child.stderr).toBe('');
  if (process.platform === 'win32') { expect(child.status).not.toBeNull(); expect(child.status).not.toBe(0); }
  else expect(child.signal).toBe('SIGKILL');
  const reopenedAuthority = openStorageReservationAuthority({ directory: join(n.root, 'authority'), mode: 'open-existing', authorityId: n.options.proofStorage.authorityId });
  cleanup.push(() => reopenedAuthority.close()); n.options.proofStorage.authority = reopenedAuthority;
  wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  expect(wallet.status().freshness).toMatchObject({ installedRevision: 2, observedRevision: 3 });
  wallet.close(); await expect(openManagedAdmissionWallet({ ...n.options, proofStorage: undefined })).rejects.toThrow('funded policy proof');
  wallet = await openManagedAdmissionWallet(n.options);
  n.setNow(1020); await wallet.appendPolicyProof({ advance: advances[1], pages: [] }); expect(wallet.status().policy?.revision).toBe(3);
}, 20000);


it('preserves permanent observation conflicts during exact pinnedv5 proof migration', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet({ ...n.options, proofStorage: undefined }); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010); await wallet.installPolicy(advances[0], authority);
  const legacy = advances[0].policy;
  if (legacy.version === 3) throw new Error('Expected legacy fixture');
  const { authority: ignoredAuthority, signature: ignoredSignature, ...body } = legacy;
  const fork = await signAdmissionPolicy({ ...body, expiresAt: legacy.expiresAt + 1 }, authority, signingKey.secretKey);
  const conflicting = await createAdmissionPolicyAdvance(genesis, fork, context, signingKey, context.genesis);
  expect(() => wallet.observePolicy(n.observation(conflicting.commitment.next))).toThrow('fenced'); expect(wallet.status().freshness?.conflicted).toBe(true);
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  await wallet.beginPolicyProof(genesis, context); await wallet.appendPolicyProof({ advance: advances[0], pages: [] });
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  expect(wallet.status().freshness).toMatchObject({ conflicted: true, installedRevision: 2, observedRevision: 2 });
  await expect(wallet.appendPolicyProof({ advance: advances[1], pages: [] })).rejects.toThrow('fenced');
});


it('bounds funded legacy opening signature verification and releases locks after a stalled verifier', async () => {
  const n = fixture(), legacy = await openManagedAdmissionWallet({ ...n.options, proofStorage: undefined });
  await legacy.installPolicy(genesis, authority, context); legacy.close();
  n.options.proofStorage.limits = { ...limits, timeoutMs: 100 };
  vi.spyOn(policyModule, 'verifyAdmissionPolicy').mockImplementationOnce(() => new Promise(() => {}));
  await expect(openManagedAdmissionWallet(n.options)).rejects.toThrow('timed out');
  vi.restoreAllMocks();
  const reopened = await openManagedAdmissionWallet(n.options);
  try { expect(reopened.status().policy?.revision).toBe(1); } finally { reopened.close(); }
});


it('migrates authenticated v6 local enrollment without rewriting original token filenames', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010); await wallet.appendPolicyProof({ advance: advances[0], pages: [] }); wallet.close();
  const tokenNames = readdirSync(n.options.directory).filter(name => name.startsWith('admission-wallet') && name.endsWith('.json'));
  const original = new Map(tokenNames.map(name => [name, readFileSync(join(n.options.directory, name))]));
  const raw = openEncryptedLocalState<any>({ path: join(n.options.directory, 'admission-profile.json'), key: n.options.encryptionKey, domain: 'resonance:admission-profile:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (v): v is any => !!v });
  const saved = raw.read();
  raw.write({ version: 6, active: 1, profiles: entries.slice(0, 2).map(entry => entry.profile), policy: saved.policy, freshness: saved.freshness, proof: saved.proof }); raw.close();
  wallet = await openManagedAdmissionWallet(n.options); expect(wallet.status().archivedTotal).toBe(1); wallet.close();
  for (const [name, bytes] of original) expect(readFileSync(join(n.options.directory, name))).toEqual(bytes);
  const reopened = openEncryptedLocalState<any>({ path: join(n.options.directory, 'admission-profile.json'), key: n.options.encryptionKey, domain: 'resonance:admission-profile:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (v): v is any => !!v });
  expect(reopened.read()).toMatchObject({ version: 7, catalogue: { count: 2 }, firstWalletId: genesis.activeKey }); expect(reopened.read()).not.toHaveProperty('profiles'); reopened.close();
});


it('refuses changed enrolled file identity between transitions and accepts own retirement publication', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010); await wallet.appendPolicyProof({ advance: advances[0], pages: [] });
  const path = join(n.options.directory, 'admission-wallet.json'), bytes = readFileSync(path);
  renameSync(path, path + '.replaced'); writeFileSync(path, bytes); n.setNow(1020);
  await expect(wallet.appendPolicyProof({ advance: advances[1], pages: [] })).rejects.toThrow('history changed'); expect(wallet.policyProofCursor()?.head.revision).toBe(2); expect(() => wallet.status()).toThrow('history changed');
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  const plan = wallet.planRetirement(genesis.activeKey); wallet.retire(genesis.activeKey, plan.approvalDigest);
  await wallet.appendPolicyProof({ advance: advances[1], pages: [] }); expect(wallet.status().policy?.revision).toBe(3);
  expect(wallet.status().archived[0].permanentlyRetired).toBe(true);
});


it.each(['status', 'provider', 'retirement-plan'] as const)('refuses a historical replacement during read-only %s without adopting it or allocating', async kind => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); await wallet.importTokens(tokens[0]);
  wallet.capabilityFor({ ...request, policyObservation: n.observation() });
  n.setNow(1010); await wallet.appendPolicyProof({ advance: advances[0], pages: [] }); await wallet.importTokens(tokens[1]);
  const path = join(n.options.directory, 'admission-wallet.json'), original = readFileSync(path);
  const activePath = join(n.options.directory, `admission-wallet-${admissionKeyFingerprint(entries[1].profile.issuerPublicKey).slice(7)}.json`), activeBytes = readFileSync(activePath);
  const actualOpenWallet = walletModule.openBlindAdmissionWalletV2; let replaced = false;
  const replace = () => { if (!replaced) { replaced = true; renameSync(path, path + '.replaced'); writeFileSync(path, original); } };
  vi.spyOn(walletModule, 'openBlindAdmissionWalletV2').mockImplementation(options => {
    const low = actualOpenWallet(options); if (options.path !== path) return low;
    let summaries = 0;
    return { ...low,
      summary() { const result = low.summary(); if (kind === 'status' && ++summaries === 2) replace(); return result; },
      reservedCapabilityFor(value) { const result = low.reservedCapabilityFor(value); if (kind === 'provider') replace(); return result; },
      planResolvedRetirement(...args) { const result = low.planResolvedRetirement(...args); if (kind === 'retirement-plan') replace(); return result; },
    };
  });
  const read = () => kind === 'status' ? wallet.status() : kind === 'provider'
    ? wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[0].commitment.next) }) : wallet.planRetirement(genesis.activeKey);
  expect(read).toThrow('history changed'); expect(replaced).toBe(true);
  expect(() => wallet.status()).toThrow('history changed'); expect(readFileSync(activePath)).toEqual(activeBytes);
  expect(handles.open).toBe(1); wallet.close();
  wallet = await openManagedAdmissionWallet(n.options); expect(wallet.status().archivedTotal).toBe(1);
});

it('poisons a failed initial token-file flush until reopening and releases the failed acquisition', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  const profilePath = join(n.options.directory, 'admission-profile.json'), before = readFileSync(profilePath);
  const actualOpen = vi.mocked(openSync).getMockImplementation()!, actualFsync = vi.mocked(fsyncSync).getMockImplementation()!;
  let tokenFd = -1, failed = false;
  vi.mocked(openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
    const fd = actualOpen(...args), name = basename(String(args[0]));
    if (name.startsWith('.admission-wallet.json.') && name.endsWith('.tmp')) tokenFd = fd;
    return fd;
  });
  vi.mocked(fsyncSync).mockImplementation(fd => {
    if (!failed && fd === tokenFd) { failed = true; throw new Error('initial token file flush failed'); }
    return actualFsync(fd);
  });
  try {
    await expect(wallet.installPolicy(genesis, authority, context)).rejects.toThrow('initial token file flush failed');
    expect(failed).toBe(true); expect(readFileSync(profilePath)).toEqual(before);
    expect(() => wallet.status()).toThrow('write failed'); await expect(wallet.installPolicy(genesis, authority, context)).rejects.toThrow('write failed');
  } finally { vi.mocked(openSync).mockImplementation(actualOpen); vi.mocked(fsyncSync).mockImplementation(actualFsync); wallet.close(); }
  wallet = await openManagedAdmissionWallet(n.options); expect(wallet.configured()).toBe(false);
  await wallet.installPolicy(genesis, authority, context); expect(wallet.status().policy?.revision).toBe(1); expect(handles.open).toBe(1);
});

it('closes a newly opened active candidate when its retained retirement evidence rejects activation', async () => {
  const n = fixture(), wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010);
  const profile = entries[1].profile, issuerKey = admissionKeyFingerprint(profile.issuerPublicKey);
  const path = join(n.options.directory, `admission-wallet-${issuerKey.slice(7)}.json`);
  const raw = openEncryptedLocalState<any>({ path, key: n.options.encryptionKey, domain: 'resonance:blind-admission-wallet:v1', maxBytes: 8 * 1024 * 1024,
    initial: { version: 2, scope: profile.scope, entries: [], deniedReservations: [], retirement: { issuerKey, authorityFingerprint: 'sha256:' + 'a'.repeat(64), policyRevision: 1, policyDigest: 'b'.repeat(64), retiredAt: 1010, retryUntil: 1000, tokensRemoved: 0, reservationsRemoved: 0 } }, validate: (value): value is any => !!value });
  raw.close();
  await expect(wallet.appendPolicyProof({ advance: advances[0], pages: [] })).rejects.toThrow('reactivate');
  expect(wallet.status().policy?.revision).toBe(1); expect(handles.open).toBe(1);
  const parsed = await parseAdmissionWalletProfile(profile), probe = openBlindAdmissionWalletV2({ path, scope: profile.scope, issuerPublicKey: parsed.publicKey, encryptionKey: n.options.encryptionKey, mode: 'open-existing' });
  try { expect(probe.summary().permanentlyRetired).toBe(true); } finally { probe.close(); }
  expect(handles.open).toBe(1);
});

it('backfills sparse pinnedv5 enrollment without enrolling any original-proof-only keys or changing the floor', async () => {
  const n = fixture(); n.setNow(1030);
  let wallet = await openManagedAdmissionWallet({ ...n.options, proofStorage: undefined }); cleanup.push(() => wallet.close());
  await wallet.installPolicy(advances[2].policy, authority); wallet.close();
  const path = join(n.options.directory, 'admission-profile.json'), tokenPath = join(n.options.directory, 'admission-wallet.json'), tokenBytes = readFileSync(tokenPath);
  const raw = openEncryptedLocalState<any>({ path, key: n.options.encryptionKey, domain: 'resonance:admission-profile:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (value): value is any => !!value });
  const old = raw.read(); expect(old.profiles).toEqual([entries[3].profile]);
  raw.write({ ...old, version: 5, freshness: { context, installed: advances[2].commitment.next, observed: advances[4].commitment.next } }); raw.close();
  wallet = await openManagedAdmissionWallet(n.options); await wallet.beginPolicyProof(genesis, context);
  for (let i = 0; i < 3; i++) {
    await wallet.appendPolicyProof({ advance: advances[i], pages: [] });
    expect(readdirSync(n.options.directory).filter(name => name.startsWith('admission-wallet') && name.endsWith('.json'))).toEqual(['admission-wallet.json']);
  }
  expect(wallet.status()).toMatchObject({ archivedTotal: 0, keyFingerprint: admissionKeyFingerprint(entries[3].profile.issuerPublicKey), freshness: { installedRevision: 4, observedRevision: 6 } });
  expect(readFileSync(tokenPath)).toEqual(tokenBytes); wallet.close();
  const activated = openEncryptedLocalState<any>({ path, key: n.options.encryptionKey, domain: 'resonance:admission-profile:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (value): value is any => !!value });
  expect(activated.read()).toMatchObject({ version: 7, firstWalletId: admissionKeyFingerprint(entries[3].profile.issuerPublicKey), catalogue: { count: 1 } }); activated.close();
  wallet = await openManagedAdmissionWallet(n.options); expect(wallet.status().archivedTotal).toBe(0); expect(wallet.policyProofCursor()?.head.revision).toBe(4);
});

it('fences a historical ownership failure after an earlier exact reservation instead of returning it or allocating', async () => {
  const n = fixture(), wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); await wallet.importTokens(tokens[0]);
  const reserved = wallet.capabilityFor({ ...request, policyObservation: n.observation() }); expect(reserved).toBeDefined();
  for (let i = 0; i < 2; i++) { n.setNow(1010 + i * 10); await wallet.appendPolicyProof({ advance: advances[i], pages: [] }); }
  await wallet.importTokens(tokens[2]);
  const activePath = join(n.options.directory, `admission-wallet-${admissionKeyFingerprint(entries[2].profile.issuerPublicKey).slice(7)}.json`), activeBytes = readFileSync(activePath);
  const blockedProfile = await parseAdmissionWalletProfile(entries[1].profile);
  const blocked = openBlindAdmissionWalletV2({ path: join(n.options.directory, `admission-wallet-${admissionKeyFingerprint(entries[1].profile.issuerPublicKey).slice(7)}.json`),
    encryptionKey: n.options.encryptionKey, scope: blockedProfile.profile.scope, issuerPublicKey: blockedProfile.publicKey, mode: 'open-existing' });
  const actualOpenWallet = walletModule.openBlindAdmissionWalletV2; let sawEarlierReservation = false;
  vi.spyOn(walletModule, 'openBlindAdmissionWalletV2').mockImplementation(options => {
    const low = actualOpenWallet(options);
    return { ...low, reservedCapabilityFor(value) { const result = low.reservedCapabilityFor(value); if (options.path.endsWith('admission-wallet.json')) sawEarlierReservation = !!result; return result; } };
  });
  try {
    expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[1].commitment.next) })).toThrow('already open');
    expect(sawEarlierReservation).toBe(true); expect(readFileSync(activePath)).toEqual(activeBytes);
    expect(() => wallet.status()).toThrow('write failed'); expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[1].commitment.next) })).toThrow('write failed');
  } finally { blocked.close(); }
  const parsed = await parseAdmissionWalletProfile(entries[0].profile), earlier = openBlindAdmissionWalletV2({ path: join(n.options.directory, 'admission-wallet.json'), encryptionKey: n.options.encryptionKey, scope: parsed.profile.scope, issuerPublicKey: parsed.publicKey, mode: 'open-existing' });
  earlier.close(); expect(handles.open).toBe(1); wallet.close();
  const reopened = await openManagedAdmissionWallet(n.options); try { expect(reopened.status().policy?.revision).toBe(3); } finally { reopened.close(); }
});

/** The101-profile lifecycle uses one real private desktop update at100→101. */
async function preparePrivateBoundary(n: ReturnType<typeof fixture>) {
  const serverModule = '../../../app/src/server/server.js', sessionModule = '../../../app/src/server/session.js';
  const [{ createAppServer }, session, { createRelayServer }, { createAdmissionPolicyTransferResponder }, { parseAdmissionPolicyQuery }, { EmbeddingEngine }, { deriveAdmissionWalletKey }] = await Promise.all([
    import(serverModule), import(sessionModule), import('../../../relay/src/server.js'),
    import('../../../relay/src/admission-policy-transfer.js'), import('@resonance/core/admission-policy-query'), import('@resonance/core'), import('../config.js'),
  ]);
  const systemNow = vi.spyOn(Date, 'now').mockImplementation(n.options.now);
  vi.stubEnv('RESONANCE_DATA_DIR', n.options.directory); vi.stubEnv('RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE', undefined);
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const responder = createAdmissionPolicyTransferResponder({ context, successor: async () => advances[99], page: async (_head, digest) => {
    const page = pagesByStep[99].find(page => page.digest === digest); if (!page) throw new Error('Unexpected private page'); return page.bytes;
  } });
  const discovery = { reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  const entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(n.root, 'entry'), relayDiscovery: { ...discovery, endpoints: ['ws://127.0.0.1:0/'] } });
  const destination = createRelayServer({ host: '::1', port: 0, persistDir: join(n.root, 'destination'), relayDiscovery: { ...discovery, endpoints: [relayUrl] },
    policyQuery: async value => {
      const request = parseAdmissionPolicyQuery(value, context, 2000).request;
      return { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
        votes: observerKeys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(request, advances[99].commitment.next, context, key, 2000)) } };
    }, policyTransfer: (value, signal) => responder.exchange(value, signal) });
  await entry.start(); await destination.start(); boundaryEndpoint.forwardTo(destination.getListeningPort()!);
  entry.observeRelayDescriptor(destination.getRelayDescriptor()!);
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `ws://127.0.0.1:${entry.getListeningPort()}/,${relayUrl}`);
  const app = createAppServer({ port: 0, relayUrl }); const base = `http://127.0.0.1:${await app.start()}`;
  let token = '';
  const request = async (path: string, body?: unknown, authenticated = true) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const unlock = async () => { const result = await request('/api/unlock', { password: 'catalogue-private-password' }); expect(result.status).toBe(200); token = result.body.token; };
  expect((await request('/api/init', { password: 'catalogue-private-password' })).status).toBe(200); await unlock();
  n.options.encryptionKey = Buffer.from(deriveAdmissionWalletKey(session.getSession()!.identity)); session.lockSession();
  const existing = [{ path: n.options.directory, scope: 'directory' as const }]; n.funding.adoptExisting(existing, n.funding.reviewExisting(existing).approvalDigest);
  const fresh = [{ path: n.proofDirectory, scope: 'directory' as const }]; n.funding.approveNewScopes(fresh, n.funding.reviewNewScopes(fresh).approvalDigest);
  cleanup.push(() => vi.unstubAllEnvs());
  async function close() { session.lockSession(); await app.stop(); await responder.close(); await destination.stop({ graceful: false }); await entry.stop({ graceful: false }); systemNow.mockRestore(); }
  return { close, async update() {
    const authorityId = n.options.proofStorage.authorityId; n.funding.close();
    const selection = join(n.root, 'selection.json');
    writeFileSync(selection, JSON.stringify({ version: 1, authorityDirectory: join(n.root, 'authority'), authorityId,
      walletDirectory: n.options.directory, directory: n.proofDirectory, maxCiphertextBytes: n.options.proofStorage.maxCiphertextBytes,
      maxRecords: n.options.proofStorage.maxRecords, limits }));
    vi.stubEnv('RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE', selection);
    const now = vi.spyOn(Date, 'now').mockReturnValue(2000);
    try {
      await unlock();
      expect((await request('/api/admission-wallet?cursor=invalid', undefined, false)).status).toBe(401);
      expect((await request('/api/admission-wallet?unexpected=1')).status).toBe(400);
      expect((await request('/api/admission-wallet?cursor=invalid')).status).toBe(409);
      const before = await request('/api/admission-wallet'); expect(before.body.archivedTotal).toBe(99);
      const started = performance.now(), updated = await request('/api/admission-wallet/update', {}), elapsedMs = performance.now() - started;
      expect(updated.status, JSON.stringify(updated.body)).toBe(200); expect(updated.body).toMatchObject({ updated: true, revision: 101, remaining: 0 }); expect(elapsedMs).toBeLessThan(25000);
      expect((await request('/api/admission-wallet?cursor=' + encodeURIComponent(before.body.nextCursor))).status).toBe(409);
      const first = await request('/api/admission-wallet'); expect(first.body.archived).toHaveLength(72); expect(first.body.archivedTotal).toBe(100);
      const second = await request('/api/admission-wallet?cursor=' + encodeURIComponent(first.body.nextCursor)); expect(second.status).toBe(200); expect(second.body.archived).toHaveLength(28);
      session.lockSession();
      const funding = openStorageReservationAuthority({ directory: join(n.root, 'authority'), mode: 'open-existing', authorityId });
      cleanup.push(() => funding.close()); n.options.proofStorage.authority = funding;
      return elapsedMs;
    } finally { now.mockRestore(); }
  } };
}
