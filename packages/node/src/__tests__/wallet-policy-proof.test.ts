import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as profiles from '../admission-wallet-profile.js';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(close => close()); });
const signingKey = generateSigningKeyPair(), authority = Buffer.from(signingKey.publicKey).toString('base64url');
const observerKeys = Array.from({ length: 5 }, generateSigningKeyPair);
const members = observerKeys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${44000 + i}/` }));
const limits: AdmissionPolicyArchiveLimits = { maxPages: 256, maxEntries: 16384, maxArchiveBytes: 20_000_000,
  maxHistoryBytes: 20_000_000, maxTransitions: 100, maxPageReads: 256, timeoutMs: 3000 };
let entries: AdmissionPolicyKey[], genesis: Awaited<ReturnType<typeof signAdmissionPolicy>>, context: ReturnType<typeof parseAdmissionPolicyObservers>;
let advances: ArchivedAdmissionPolicyAdvance[], migrationPages: Array<{ digest: string; bytes: Uint8Array }>, tokens: string[][];
const relayUrl = 'ws://127.0.0.1:45000/';
beforeAll(async () => {
  const rsa = Array.from({ length: 66 }, () => generateKeyPairSync('rsa', { modulusLength: 2048 }));
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
  const resolved = await resolveAdmissionPolicy({ context, genesis, advances, selectedHead: head, reader, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous: resolved, next: fields(65), reader, limits });
  migrationPages = plan.pages; for (const page of plan.pages) pages.set(page.digest, page.bytes);
  const signed = await signAdmissionPolicyV3(plan.body, authority, signingKey.secretKey);
  advances.push((await createResolvedAdmissionPolicyAdvance({ previous: resolved, policy: signed, key: signingKey, reader, limits })).advance);
  tokens = [];
  for (const i of [0, 65]) {
    const parsed = await parseAdmissionWalletProfile(entries[i].profile);
    const privateKey = await crypto.subtle.importKey('pkcs8', rsa[i].privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
    const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, entries[i].profile.scope.issuer, privateKey, parsed.publicKey);
    const request = await createBlindAdmissionRequestV2(entries[i].profile.scope, parsed.publicKey);
    tokens[i] = [await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request))];
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
it('retains66 real profiles across65 rotations, permanent retry denials, v3 restart and missing evidence refusals', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet(n.options); cleanup.push(() => wallet.close());
  await wallet.installPolicy(genesis, authority, context); await wallet.importTokens(tokens[0]);
  const reserved = wallet.capabilityFor({ ...request, policyObservation: n.observation() });
  expect(wallet.capabilityFor({ ...request, policyObservation: n.observation() })).toEqual(reserved);
  for (let i = 0; i < advances.length; i++) {
    n.setNow(1010 + i * 10);
    await wallet.appendPolicyProof({ advance: advances[i], pages: i === 64 ? migrationPages : [] });
  }
  expect(wallet.status()).toMatchObject({ policy: { revision: 66, archivedKeys: 65, currentKeys: 1 } });
  expect(wallet.status().archived).toHaveLength(65);
  expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[64].commitment.next) })).toThrow('not active');
  const plan = wallet.planRetirement(genesis.activeKey); wallet.retire(genesis.activeKey, plan.approvalDigest);
  await wallet.importTokens(tokens[65]);
  const freshRequest = { ...request, requestBinding: createAdmissionRequestBindingV2('search', { real: 'current' }), policyObservation: n.observation(advances[64].commitment.next) };
  const current = wallet.capabilityFor(freshRequest);
  wallet.close(); wallet = await openManagedAdmissionWallet(n.options);
  expect(wallet.capabilityFor(freshRequest)).toEqual(current);
  expect(() => wallet.capabilityFor({ ...request, policyObservation: n.observation(advances[64].commitment.next) })).toThrow('permanently retired');
  wallet.close();
  await expect(openManagedAdmissionWallet({ ...n.options, proofStorage: undefined })).rejects.toThrow('funded policy proof');
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
    if (String(destination).endsWith('/record-1.bin')) throw new Error('publication interrupted');
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

it('promotes exact completed pinnedv5 backfill after actual process death before profile activation', async () => {
  const n = fixture(); let wallet = await openManagedAdmissionWallet({ ...n.options, proofStorage: undefined });
  await wallet.installPolicy(genesis, authority, context); n.setNow(1010); await wallet.installPolicy(advances[0], authority);
  wallet.observePolicy(n.observation(advances[1].commitment.next)); wallet.close(); n.funding.close();
  const inputPath = join(n.root, 'crash-input.json');
  writeFileSync(inputPath, JSON.stringify({ directory: n.options.directory, key: n.options.encryptionKey.toString('hex'),
    authorityDirectory: join(n.root, 'authority'), authorityId: n.options.proofStorage.authorityId, proofDirectory: n.proofDirectory,
    maxCiphertextBytes: n.options.proofStorage.maxCiphertextBytes, maxRecords: n.options.proofStorage.maxRecords, limits,
    genesis, context, advance: advances[0] }));
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/wallet-proof-crash.ts', import.meta.url)), inputPath],
    { encoding: 'utf8', timeout: 15000 });
  expect(child.error).toBeUndefined(); expect(child.signal, child.stderr).toBe('SIGKILL');
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
