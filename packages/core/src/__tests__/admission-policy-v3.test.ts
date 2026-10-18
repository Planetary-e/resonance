import { beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import { admissionKeyFingerprint, admissionPolicyDigest, admissionPolicyKeys, assertAdmissionPolicySuccessor, isArchivedAdmissionKey,
  parseAdmissionPolicyBody, signAdmissionPolicy, verifyAdmissionPolicy, type AdmissionPolicyBody, type AdmissionPolicyKey } from '../admission-policy.js';
import { admissionPolicyHead, createAdmissionPolicyAdvance, createAdmissionPolicyAdvanceCommitment } from '../admission-policy-advance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers } from '../admission-policy-freshness.js';
import { parseAdmissionWitnessSet } from '../admission-witness.js';
import { admissionPolicyArchivePageDigest, admissionPolicyV3Digest, archivedAdmissionPolicyDigest, createResolvedAdmissionPolicyAdvance,
  decodeAdmissionPolicyArchivePage, emptyAdmissionPolicyArchive, encodeAdmissionPolicyArchivePage, inspectResolvedAdmissionPolicy,
  lookupResolvedAdmissionPolicyKey, prepareAdmissionPolicyV3Successor, resolveAdmissionPolicy, resolveAdmissionPolicyAdvance,
  signAdmissionPolicyV3, verifyAdmissionPolicyV3, visitResolvedAdmissionPolicyArchive,
  type AdmissionPolicyArchiveLimits, type ArchivedAdmissionPolicyAdvance, type ResolvedAdmissionPolicy, type SignedAdmissionPolicyV3 } from '../admission-policy-archive.js';

const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
// Test envelope only. Production callers must provide their own funded, cumulative ceilings.
const limits: AdmissionPolicyArchiveLimits = { maxPages: 1000, maxEntries: 10000, maxArchiveBytes: 20_000_000,
  maxHistoryBytes: 20_000_000, maxTransitions: 100, maxPageReads: 1000, timeoutMs: 30000 };
const pages = new Map<string, Uint8Array>();
const reader = async (digest: string) => { const bytes = pages.get(digest); if (!bytes) throw new Error('Missing archive page'); return bytes; };
let entries: AdmissionPolicyKey[], genesis: Awaited<ReturnType<typeof signAdmissionPolicy>>, context: ReturnType<typeof parseAdmissionPolicyObservers>,
  legacy: typeof genesis, advances: ArchivedAdmissionPolicyAdvance[], previous: ResolvedAdmissionPolicy,
  prepared: Awaited<ReturnType<typeof prepareAdmissionPolicyV3Successor>>, signed: SignedAdmissionPolicyV3,
  migrated: Awaited<ReturnType<typeof createResolvedAdmissionPolicyAdvance>>;
beforeAll(async () => {
  const members = Array.from({ length: 5 }, (_, i) => ({ publicKey: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${41000 + i}/` }));
  const witnesses = parseAdmissionWitnessSet({ version: 1, quorum: 4, members, coordinators: [authority] });
  // Generate/cache each real RSA public key once for the complete file, not for every test.
  entries = Array.from({ length: 67 }, (_, i) => ({ profile: { version: 1, scope: { issuer: 'v3-core-proof', community: 'public', epoch: `period-${i}` },
    issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:41100/'] },
    notBefore: 1000 + i * 10, issueUntil: 1001 + i * 10, spendUntil: 1002 + i * 10, retryUntil: 1003 + i * 10, witnesses }));
  genesis = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: 1000, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: [entries[0]] }, authority, key.secretKey);
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(genesis), quorum: 4, members });
  legacy = genesis; advances = []; let head = context.genesis;
  for (let i = 1; i <= 64; i++) {
    const next = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', revision: i + 1, issuedAt: 1000 + i * 10, expiresAt: 5000,
      activeKey: admissionKeyFingerprint(entries[i].profile.issuerPublicKey), keys: [entries[i]], archivedKeys: entries.slice(0, i) }, authority, key.secretKey);
    const advance = await createAdmissionPolicyAdvance(legacy, next, context, key, head); advances.push(advance); head = advance.commitment.next; legacy = next;
  }
  previous = await resolveAdmissionPolicy({ context, genesis, advances, selectedHead: head, reader, limits });
  prepared = await prepareAdmissionPolicyV3Successor({ previous, next: nextFields(65), reader, limits });
  for (const page of prepared.pages) pages.set(page.digest, page.bytes);
  signed = await signAdmissionPolicyV3(prepared.body, authority, key.secretKey);
  migrated = await createResolvedAdmissionPolicyAdvance({ previous, policy: signed, key, reader, limits });
}, 60000);
function nextFields(index: number) { return { revision: index + 1, issuedAt: 1000 + index * 10, expiresAt: 5000,
  activeKey: admissionKeyFingerprint(entries[index].profile.issuerPublicKey), keys: [entries[index]] }; }
function reopen() { return { context, genesis, advances: [...advances, migrated.advance], selectedHead: migrated.advance.commitment.next, reader, limits }; }

it('authenticates the 65th archived entry in v3 from original v1 genesis (core proof, no protected-role activation)', async () => {
  expect(signed.archive.entryCount).toBe(65); expect(signed.archive.pageCount).toBe(2); expect(prepared.pages).toHaveLength(2);
  expect(inspectResolvedAdmissionPolicy(migrated.resolved).currentKeys).toHaveLength(1);
  expect(archivedAdmissionPolicyDigest(signed)).toBe(admissionPolicyV3Digest(signed));
  const restored = await resolveAdmissionPolicy(reopen());
  for (const index of [0, 63, 64, 65]) {
    expect(await lookupResolvedAdmissionPolicyKey({ policy: restored, issuerKey: admissionKeyFingerprint(entries[index].profile.issuerPublicKey), reader, limits }))
      .toEqual({ entry: entries[index], archived: index < 65 });
  }
  const offsets: number[] = [];
  await visitResolvedAdmissionPolicyArchive({ policy: restored, reader, limits, visit: (entry, offset) => { expect(entry).toEqual(entries[offset]); offsets.push(offset); } });
  expect(offsets.sort((a,b) => a-b)).toEqual(Array.from({ length: 65 }, (_, i) => i));
});

it('keeps signatures/schema separate from capabilities and explicitly fences every legacy complete-array path', async () => {
  expect(await verifyAdmissionPolicyV3(signed, authority)).toEqual(signed);
  await expect(verifyAdmissionPolicy(signed, authority)).rejects.toThrow();
  await expect(parseAdmissionPolicyBody(prepared.body)).rejects.toThrow();
  for (const operation of [() => admissionPolicyKeys(signed as unknown as AdmissionPolicyBody), () => isArchivedAdmissionKey(signed as unknown as AdmissionPolicyBody, legacy.activeKey),
    () => assertAdmissionPolicySuccessor(legacy, signed as unknown as AdmissionPolicyBody), () => assertAdmissionPolicySuccessor(signed as unknown as AdmissionPolicyBody, legacy),
    () => admissionPolicyDigest(signed as unknown as AdmissionPolicyBody)]) expect(operation).toThrow('refuses v3');
  for (const value of [signed, {}, structuredClone(migrated.resolved), JSON.parse(JSON.stringify(migrated.resolved))]) {
    await expect(lookupResolvedAdmissionPolicyKey({ policy: value as ResolvedAdmissionPolicy, issuerKey: legacy.activeKey, reader, limits })).rejects.toThrow('original resolved');
  }
});

it('signs every descriptor field and refuses invalid signatures, wrong original contexts and fresh v3 genesis', async () => {
  for (const field of ['contextId','root','pageCount','entryCount','archiveBytes'] as const) {
    const bad = structuredClone(signed);
    if (field === 'contextId' || field === 'root') bad.archive[field] = 'sha256:' + 'b'.repeat(64);
    else bad.archive[field]++;
    await expect(verifyAdmissionPolicyV3(bad, authority)).rejects.toThrow();
  }
  const bad = structuredClone(signed); bad.archive.kind = 'other' as never;
  await expect(verifyAdmissionPolicyV3(bad, authority)).rejects.toThrow();
  const version = structuredClone(signed); version.archive.version = 2 as never;
  await expect(verifyAdmissionPolicyV3(version, authority)).rejects.toThrow();
  const changed = structuredClone(prepared.body); changed.archive.contextId = 'sha256:' + 'c'.repeat(64);
  const wrongContext = await signAdmissionPolicyV3(changed, authority, key.secretKey);
  await expect(createResolvedAdmissionPolicyAdvance({ previous, policy: wrongContext, key, reader, limits })).rejects.toThrow('original context');
  await expect(resolveAdmissionPolicy({ ...reopen(), genesis: signed })).rejects.toThrow();
  const circularContext = { ...context, genesis: { revision: signed.revision, digest: admissionPolicyV3Digest(signed), transition: admissionPolicyV3Digest(signed) } };
  await expect(resolveAdmissionPolicy({ ...reopen(), context: circularContext, genesis: signed, advances: [], selectedHead: circularContext.genesis })).rejects.toThrow();
  const signature = structuredClone(signed); signature.signature = 'A'.repeat(86);
  await expect(verifyAdmissionPolicyV3(signature, authority)).rejects.toThrow('signature');
});

it('extends v3 with the exact immutable prior root and resolves one authenticated immediate advance', async () => {
  const plan = await prepareAdmissionPolicyV3Successor({ previous: migrated.resolved, next: nextFields(66), reader, limits });
  expect(plan.pages).toHaveLength(1);
  expect((await decodeAdmissionPolicyArchivePage(plan.pages[0].bytes)).previous).toBe(signed.archive.root);
  expect(plan.body.archive.entryCount).toBe(66);
  for (const p of plan.pages) pages.set(p.digest, p.bytes);
  const policy = await signAdmissionPolicyV3(plan.body, authority, key.secretKey);
  const next = await createResolvedAdmissionPolicyAdvance({ previous: migrated.resolved, policy, key, reader, limits });
  expect(inspectResolvedAdmissionPolicy(await resolveAdmissionPolicyAdvance({ previous: migrated.resolved, advance: next.advance, selectedHead: next.advance.commitment.next, reader, limits })).head).toEqual(next.advance.commitment.next);
  expect(await lookupResolvedAdmissionPolicyKey({ policy: next.resolved, issuerKey: signed.activeKey, reader, limits })).toEqual({ entry: entries[65], archived: true });
});

it('refuses downgrade, v1 migration, omitted ancestry, stale/conflicting heads and digest-substituted advance bodies', async () => {
  const initial = await resolveAdmissionPolicy({ context, genesis, advances: [], selectedHead: context.genesis, reader, limits });
  await expect(prepareAdmissionPolicyV3Successor({ previous: initial, next: nextFields(65), reader, limits })).rejects.toThrow('v2 predecessor');
  for (const changes of [{ advances: [migrated.advance] }, { advances: [...advances.slice(1), migrated.advance] }, { selectedHead: advances[63].commitment.next },
    { selectedHead: { ...migrated.advance.commitment.next, transition: 'a'.repeat(64) } }]) await expect(resolveAdmissionPolicy({ ...reopen(), ...changes })).rejects.toThrow();
  const downgrade = await signAdmissionPolicy({ ...legacy, authority: undefined, signature: undefined }, authority, key.secretKey).catch(() => undefined);
  expect(downgrade).toBeUndefined();
  const { authority: _, signature: __, ...body } = legacy;
  const old = await signAdmissionPolicy({ ...body, revision: signed.revision + 1, issuedAt: signed.issuedAt + 10 }, authority, key.secretKey);
  const commitment = createAdmissionPolicyAdvanceCommitment(migrated.advance.commitment.next, { revision: old.revision, digest: admissionPolicyDigest(old) }, context, key);
  await expect(resolveAdmissionPolicyAdvance({ previous: migrated.resolved, advance: { commitment, policy: old }, selectedHead: commitment.next, reader, limits })).rejects.toThrow('downgrade');
  const substituted = structuredClone(migrated.advance); substituted.policy = old;
  await expect(resolveAdmissionPolicyAdvance({ previous, advance: substituted, selectedHead: migrated.advance.commitment.next, reader, limits })).rejects.toThrow('digest');
});

it('checks all prior archive entries for reused issuers and periods and preserves final cutoffs and pins', async () => {
  for (const next of [
    { ...nextFields(66), activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: [entries[0]] },
    { ...nextFields(66), keys: [{ ...entries[66], profile: { ...entries[66].profile, scope: entries[0].profile.scope } }] },
    { ...nextFields(66), issuedAt: entries[65].retryUntil - 1 },
    { ...nextFields(66), keys: [{ ...entries[65], witnesses: undefined }] },
  ]) await expect(prepareAdmissionPolicyV3Successor({ previous: migrated.resolved, next, reader, limits })).rejects.toThrow();
});

it('rejects rewritten root prefixes, count/byte lies and substituted migration pages even with valid authority signatures', async () => {
  const plan = await prepareAdmissionPolicyV3Successor({ previous: migrated.resolved, next: nextFields(66), reader, limits });
  const rewritten = await decodeAdmissionPolicyArchivePage(plan.pages[0].bytes); rewritten.previous = 'sha256:' + 'd'.repeat(64);
  const bytes = await encodeAdmissionPolicyArchivePage(rewritten), root = admissionPolicyArchivePageDigest(bytes); pages.set(root, bytes);
  for (const archive of [{ ...plan.body.archive, root }, { ...plan.body.archive, entryCount: 65 }, { ...plan.body.archive, archiveBytes: plan.body.archive.archiveBytes + 1 }]) {
    const policy = await signAdmissionPolicyV3({ ...plan.body, archive }, authority, key.secretKey);
    await expect(createResolvedAdmissionPolicyAdvance({ previous: migrated.resolved, policy, key, reader, limits })).rejects.toThrow();
  }
  const page = await decodeAdmissionPolicyArchivePage(prepared.pages[1].bytes); page.entries[0] = entries[63];
  const changed = await encodeAdmissionPolicyArchivePage(page), changedRoot = admissionPolicyArchivePageDigest(changed); pages.set(changedRoot, changed);
  const invalid = await signAdmissionPolicyV3({ ...prepared.body, archive: { ...signed.archive, root: changedRoot, archiveBytes: signed.archive.archiveBytes - prepared.pages[1].bytes.length + changed.length } }, authority, key.secretKey);
  await expect(createResolvedAdmissionPolicyAdvance({ previous, policy: invalid, key, reader, limits })).rejects.toThrow('chronological');
});

it('reader failures refuse current/archived matches and absence; visitation revalidates and charges rescans', async () => {
  const missing = async () => { throw new Error('Missing pages'); };
  for (const index of [0,65,66]) await expect(lookupResolvedAdmissionPolicyKey({ policy: migrated.resolved, issuerKey: admissionKeyFingerprint(entries[index].profile.issuerPublicKey), reader: missing, limits })).rejects.toThrow('Missing');
  let calls = 0;
  await expect(visitResolvedAdmissionPolicyArchive({ policy: migrated.resolved, reader: missing, limits, visit: () => { calls++; } })).rejects.toThrow(); expect(calls).toBe(0);
  await expect(visitResolvedAdmissionPolicyArchive({ policy: migrated.resolved, reader, limits: { ...limits, maxPageReads: 3 }, visit: () => {} })).rejects.toThrow('maxPageReads');
  const snapshot = inspectResolvedAdmissionPolicy(migrated.resolved); snapshot.policy.keys[0].retryUntil++;
  expect(inspectResolvedAdmissionPolicy(migrated.resolved).policy.keys[0].retryUntil).toBe(entries[65].retryUntil);
});

it('refuses cumulative exhaustion and cancellation while preserving the accepted resolved capability', async () => {
  for (const limit of ['maxPages','maxEntries','maxArchiveBytes','maxHistoryBytes','maxTransitions','maxPageReads'] as const) {
    await expect(resolveAdmissionPolicy({ ...reopen(), limits: { ...limits, [limit]: 0 } })).rejects.toThrow();
  }
  const controller = new AbortController(); controller.abort();
  await expect(resolveAdmissionPolicy({ ...reopen(), signal: controller.signal })).rejects.toThrow('cancelled');
  await expect(lookupResolvedAdmissionPolicyKey({ policy: migrated.resolved, issuerKey: signed.activeKey, reader: async () => new Promise(() => {}),
    limits: { ...limits, timeoutMs: 10 } })).rejects.toThrow('timed out');
  expect(await lookupResolvedAdmissionPolicyKey({ policy: migrated.resolved, issuerKey: signed.activeKey, reader, limits })).toEqual({ entry: entries[65], archived: false });
});
