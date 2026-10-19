import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyKey } from '../admission-policy.js';
import { admissionPolicyHead, createAdmissionPolicyAdvance, type AdmissionPolicyAdvance } from '../admission-policy-advance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '../admission-policy-freshness.js';
import { parseAdmissionWitnessSet } from '../admission-witness.js';
import { ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES, admissionPolicyArchivePageDigest, appendAdmissionPolicyArchive,
  prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3, createResolvedAdmissionPolicyAdvance, resolveAdmissionPolicyCatalogueMembership, inspectResolvedAdmissionPolicyKey,
  decodeAdmissionPolicyArchivePage, emptyAdmissionPolicyArchive, encodeAdmissionPolicyArchivePage, lookupAdmissionPolicyArchive,
  verifyAdmissionPolicyArchive, AdmissionPolicyArchiveBudget, AdmissionPolicyArchiveExecutionContext, admissionPolicyProofReference, resolveAdmissionPolicy, resolveAdmissionPolicyHistoryMembership, type AdmissionPolicyArchiveDescriptor, type AdmissionPolicyArchiveLimits,
  type AdmissionPolicyArchivePage, type VerifiedAdmissionPolicyArchive } from '../admission-policy-archive.js';

const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
const limits: AdmissionPolicyArchiveLimits = { maxPages: 20, maxEntries: 1000, maxArchiveBytes: 5_000_000,
  maxHistoryBytes: 5_000_000, maxTransitions: 20, maxPageReads: 20, timeoutMs: 10000 };
let context: AdmissionPolicyObservers, entries: AdmissionPolicyKey[], genesis: Awaited<ReturnType<typeof signAdmissionPolicy>>,
  second: typeof genesis, third: typeof genesis, firstAdvance: AdmissionPolicyAdvance, secondAdvance: AdmissionPolicyAdvance;
const store = new Map<string, Uint8Array>();
const reader = async (digest: string) => { const bytes = store.get(digest); if (!bytes) throw new Error('Missing page'); return bytes; };
beforeAll(async () => {
  const members = Array.from({ length: 5 }, (_, i) => ({ publicKey: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${37000 + i}/` }));
  const witnesses = parseAdmissionWitnessSet({ version: 1, quorum: 4, members, coordinators: [authority] });
  entries = Array.from({ length: 3 }, (_, i) => ({ profile: { version: 1, scope: { issuer: 'archive-pages', community: 'public', epoch: `period-${i}` },
    issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:37100/'] },
    notBefore: 1000 + i * 10, issueUntil: 1001 + i * 10, spendUntil: 1002 + i * 10, retryUntil: 1003 + i * 10, witnesses }));
  genesis = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: 1000, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: [entries[0]] }, authority, key.secretKey);
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(genesis), quorum: 4, members });
  second = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', revision: 2, issuedAt: 1010, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[1].profile.issuerPublicKey), keys: [entries[1]], archivedKeys: [entries[0]] }, authority, key.secretKey);
  firstAdvance = await createAdmissionPolicyAdvance(genesis, second, context, key);
  third = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', revision: 3, issuedAt: 1020, expiresAt: 5000,
    activeKey: admissionKeyFingerprint(entries[2].profile.issuerPublicKey), keys: [entries[2]], archivedKeys: entries.slice(0, 2) }, authority, key.secretKey);
  secondAdvance = await createAdmissionPolicyAdvance(second, third, context, key, firstAdvance.commitment.next);
}, 30000);
function empty() { return verifyAdmissionPolicyArchive({ context, genesis, advances: [], selectedHead: context.genesis,
  descriptor: emptyAdmissionPolicyArchive(admissionPolicyObserversId(context)), reader, limits }); }
async function staged() {
  const first = await appendAdmissionPolicyArchive({ handle: await empty(), advance: firstAdvance, selectedHead: firstAdvance.commitment.next, reader, limits });
  for (const p of first.pages) store.set(p.digest, p.bytes);
  const next = await appendAdmissionPolicyArchive({ handle: first.handle, advance: secondAdvance, selectedHead: secondAdvance.commitment.next, reader, limits });
  for (const p of next.pages) store.set(p.digest, p.bytes);
  return { first, next };
}
function reopen(descriptor: AdmissionPolicyArchiveDescriptor) { return { context, genesis, advances: [firstAdvance, secondAdvance],
  selectedHead: secondAdvance.commitment.next, descriptor, reader, limits }; }
function page(entriesValue = entries.slice(0, 1)): AdmissionPolicyArchivePage { return { version: 1, kind: 'admission-policy-archive-page', contextId: admissionPolicyObserversId(context), previous: null, index: 0, firstEntry: 0, entries: entriesValue }; }

it('round trips canonical bounded pages and rejects empty, 65-entry, noncanonical and invalid profile inputs', async () => {
  const input = page(), bytes = await encodeAdmissionPolicyArchivePage(input);
  expect(await decodeAdmissionPolicyArchivePage(bytes)).toEqual(input);
  expect(admissionPolicyArchivePageDigest(bytes)).toMatch(/^sha256:[a-f0-9]{64}$/);
  await expect(encodeAdmissionPolicyArchivePage(page([]))).rejects.toThrow();
  await expect(encodeAdmissionPolicyArchivePage(page(Array(65).fill(entries[0])))).rejects.toThrow();
  expect((await decodeAdmissionPolicyArchivePage(await encodeAdmissionPolicyArchivePage(page(Array(64).fill(entries[0]))))).entries).toHaveLength(64);
  await expect(decodeAdmissionPolicyArchivePage(Buffer.from(JSON.stringify(input) + '\n'))).rejects.toThrow('canonical');
  await expect(decodeAdmissionPolicyArchivePage(new Uint8Array(ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES + 1))).rejects.toThrow('oversized');
  const invalid = page(); invalid.entries[0] = structuredClone(entries[0]); invalid.entries[0].profile.issuerPublicKey = 'fake';
  await expect(encodeAdmissionPolicyArchivePage(invalid)).rejects.toThrow();
});

it('enforces the exact 512 KiB canonical byte ceiling (unauthenticated page mechanics)', async () => {
  // Repeated RSA profiles are mechanical fixtures, never claimed as a valid policy archive.
  const wide = structuredClone(entries[0]);
  wide.profile.scope.issuer = 'i'.repeat(128); wide.profile.scope.epoch = 'e'.repeat(128);
  const endpoint = (host: string, i: number) => { const base = `wss://${host}.example/${i}/`; return base + 'p'.repeat(512 - base.length); };
  wide.profile.relayUrls = Array.from({ length: 8 }, (_, i) => endpoint('relay', i));
  wide.witnesses!.members = wide.witnesses!.members.map((m, i) => ({ ...m, endpoint: endpoint('witness', i) }));
  wide.witnesses!.coordinators = Array.from({ length: 8 }, () => Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'));
  const normalized = (await decodeAdmissionPolicyArchivePage(await encodeAdmissionPolicyArchivePage(page([wide])))).entries[0];
  const candidate = page(Array.from({ length: 64 }, () => structuredClone(normalized)));
  const size = () => Buffer.byteLength(JSON.stringify(candidate));
  expect(size()).toBeGreaterThan(ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES);
  for (const entry of candidate.entries) {
    if (size() <= ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) break;
    const original = entry.profile.relayUrls[0];
    entry.profile.relayUrls[0] = 'wss://relay.example/0/';
    if (size() < ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) {
      entry.profile.relayUrls[0] += 'p'.repeat(ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES - size());
      expect(entry.profile.relayUrls[0].length).toBeLessThanOrEqual(original.length);
    }
  }
  const bytes = await encodeAdmissionPolicyArchivePage(candidate);
  expect(bytes.byteLength).toBe(ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES);
  expect((await decodeAdmissionPolicyArchivePage(bytes)).entries).toHaveLength(64);
  // The explicit byte decoder boundary does not depend on entry schema rejection.
  await expect(decodeAdmissionPolicyArchivePage(Buffer.concat([Buffer.from(bytes), Buffer.from(' ')]))).rejects.toThrow('oversized');
});

it('builds a real signed v1→v2 archive, never rewrites a partial page, and reopens with the identical root', async () => {
  const { first, next } = await staged();
  expect(first.pages).toHaveLength(1); expect(next.pages).toHaveLength(1);
  const newPage = await decodeAdmissionPolicyArchivePage(next.pages[0].bytes);
  expect(newPage.previous).toBe(first.descriptor.root); expect(newPage.firstEntry).toBe(1);
  expect(next.descriptor).toMatchObject({ pageCount: 2, entryCount: 2 });
  const handle = await verifyAdmissionPolicyArchive(reopen(next.descriptor));
  expect(await lookupAdmissionPolicyArchive({ handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader, limits })).toEqual(entries[0]);
  expect(await lookupAdmissionPolicyArchive({ handle, issuerKey: admissionKeyFingerprint(entries[2].profile.issuerPublicKey), reader, limits })).toBeUndefined();
  expect(first.pages[0].bytes).toEqual(store.get(first.descriptor.root!));
});

it('refuses invalid signatures, original pins, incomplete/gapped/forked provenance and stale/conflicting selected heads', async () => {
  const { next } = await staged(), options = reopen(next.descriptor);
  const bad = structuredClone(firstAdvance); bad.policy.signature = 'A'.repeat(86);
  for (const change of [
    { advances: [bad, secondAdvance] }, { advances: [secondAdvance] }, { advances: [firstAdvance] },
    { advances: [firstAdvance, firstAdvance] }, { selectedHead: firstAdvance.commitment.next },
    { selectedHead: { ...options.selectedHead, transition: 'a'.repeat(64) } },
    { genesis: second }, { context: { ...context, authority: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url') } },
    { context: { ...context, members: context.members.map((m, i) => ({ ...m, endpoint: `ws://127.0.0.1:${38000 + i}/` })) } },
  ]) await expect(verifyAdmissionPolicyArchive({ ...options, ...change })).rejects.toThrow();
  const signature = structuredClone(firstAdvance); signature.commitment.signature = 'A'.repeat(86);
  await expect(appendAdmissionPolicyArchive({ handle: await empty(), advance: signature, selectedHead: firstAdvance.commitment.next, reader, limits })).rejects.toThrow();
});

it('refuses correctly signed semantic regressions, changed witness pins and reused periods', async () => {
  const { authority: _, signature: __, ...body } = second;
  for (const edit of [
    (b: typeof body) => { b.archivedKeys = []; },
    (b: typeof body) => { b.archivedKeys![0].retryUntil--; },
    (b: typeof body) => { b.archivedKeys![0].witnesses!.members[0].endpoint = 'ws://127.0.0.1:39999/'; },
    (b: typeof body) => { b.keys[0].profile.scope.epoch = entries[0].profile.scope.epoch; },
  ]) {
    const invalid = structuredClone(body); edit(invalid);
    const signed = await signAdmissionPolicy(invalid, authority, key.secretKey);
    if (invalid.archivedKeys?.length && invalid.keys[0].profile.scope.epoch === entries[0].profile.scope.epoch) {
      const advance = await createAdmissionPolicyAdvance(genesis, signed, context, key);
      await expect(appendAdmissionPolicyArchive({ handle: await empty(), advance, selectedHead: advance.commitment.next, reader, limits })).rejects.toThrow('fresh shared period');
    } else await expect(createAdmissionPolicyAdvance(genesis, signed, context, key)).rejects.toThrow();
  }
});

it('revalidates all pages before match or absence and refuses missing, substituted, extra, reordered and changed reader data', async () => {
  const { next } = await staged(), options = reopen(next.descriptor), handle = await verifyAdmissionPolicyArchive(options);
  const lookup = (issuerKey: string, alternate = reader) => lookupAdmissionPolicyArchive({ handle, issuerKey, reader: alternate, limits });
  const corruptReader = async (digest: string) => digest === (await decodeAdmissionPolicyArchivePage(next.pages[0].bytes)).previous ? new Uint8Array([1]) : reader(digest);
  // Newest page contains the match, but the older corrupted page still must be checked.
  await expect(lookup(admissionKeyFingerprint(entries[1].profile.issuerPublicKey), corruptReader)).rejects.toThrow();
  await expect(lookup(admissionKeyFingerprint(entries[2].profile.issuerPublicKey), corruptReader)).rejects.toThrow();
  for (const change of [ { pageCount: 3 }, { pageCount: 1 }, { entryCount: 3 }, { archiveBytes: next.descriptor.archiveBytes + 1 }, { root: 'sha256:' + 'a'.repeat(64) } ]) {
    await expect(verifyAdmissionPolicyArchive({ ...options, descriptor: { ...next.descriptor, ...change } })).rejects.toThrow();
  }
  await expect(verifyAdmissionPolicyArchive({ ...options, reader: async () => next.pages[0].bytes })).rejects.toThrow();
  await expect(appendAdmissionPolicyArchive({ handle: next.handle, advance: secondAdvance, selectedHead: secondAdvance.commitment.next, reader, limits })).rejects.toThrow('immediate successor');
  await expect(lookup(admissionKeyFingerprint(entries[0].profile.issuerPublicKey), async () => { throw new Error('Missing'); })).rejects.toThrow('Missing');
});

it('rejects forged, cloned and serialized handles; returned bytes, descriptors and entries cannot mutate retained state', async () => {
  const { next } = await staged();
  for (const handle of [{}, structuredClone(next.handle), JSON.parse(JSON.stringify(next.handle))]) {
    await expect(lookupAdmissionPolicyArchive({ handle: handle as VerifiedAdmissionPolicyArchive, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader, limits })).rejects.toThrow('original');
  }
  const root = next.descriptor.root; next.descriptor.root = null;
  const found = await lookupAdmissionPolicyArchive({ handle: next.handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader, limits });
  found!.retryUntil++;
  expect((await lookupAdmissionPolicyArchive({ handle: next.handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader, limits }))!.retryUntil).toBe(entries[0].retryUntil);
  expect(root).not.toBeNull();
});

it('snapshots all caller history, pins, limits and selected head before awaiting', async () => {
  const { next } = await staged(), options = structuredClone({ ...reopen(next.descriptor), reader: undefined });
  const pending = verifyAdmissionPolicyArchive({ ...options, reader });
  options.genesis.signature = 'bad'; options.advances[1].commitment.next.transition = 'b'.repeat(64);
  options.context.authority = 'bad'; options.selectedHead.revision = 999; options.descriptor.root = null; options.limits.maxEntries = 0;
  await expect(pending).resolves.toBeDefined();
});

it.each(['maxPages','maxEntries','maxArchiveBytes','maxHistoryBytes','maxTransitions','maxPageReads'] as const)('refuses aggregate %s exhaustion without modifying the accepted handle', async limit => {
  const { next } = await staged();
  await expect(verifyAdmissionPolicyArchive({ ...reopen(next.descriptor), limits: { ...limits, [limit]: 0 } })).rejects.toThrow();
  await expect(lookupAdmissionPolicyArchive({ handle: next.handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader, limits })).resolves.toEqual(entries[0]);
});

it('counts reads and rescans; timeout and cancellation stop hanging readers without publishing', async () => {
  const { first, next } = await staged();
  await expect(lookupAdmissionPolicyArchive({ handle: next.handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader,
    limits: { ...limits, maxPageReads: 1 } })).rejects.toThrow('maxPageReads');
  await expect(appendAdmissionPolicyArchive({ handle: first.handle, advance: secondAdvance, selectedHead: secondAdvance.commitment.next, reader,
    limits: { ...limits, maxPages: 1 } })).rejects.toThrow();
  const cancelled = new AbortController(); cancelled.abort();
  await expect(verifyAdmissionPolicyArchive({ ...reopen(next.descriptor), signal: cancelled.signal })).rejects.toThrow('cancelled');
  let observedSignal: AbortSignal | undefined;
  const hanging = async (_digest: string, signal: AbortSignal): Promise<Uint8Array> => { observedSignal = signal; return new Promise(() => {}); };
  await expect(lookupAdmissionPolicyArchive({ handle: next.handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), reader: hanging,
    limits: { ...limits, timeoutMs: 20 } })).rejects.toThrow('timed out');
  expect(observedSignal!.aborted).toBe(true);
  const controller = new AbortController();
  const pending = lookupAdmissionPolicyArchive({ handle: next.handle, issuerKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), signal: controller.signal, reader: hanging, limits });
  controller.abort(); await expect(pending).rejects.toThrow('cancelled');
});

it('supports a hashlinked chain beyond 64 entries only as unauthenticated page mechanics', async () => {
  let previous: string | null = null, offset = 0;
  for (let index = 0; index < 3; index++) {
    const input = { ...page(Array(index < 2 ? 64 : 1).fill(entries[0])), previous, index, firstEntry: offset };
    const bytes = await encodeAdmissionPolicyArchivePage(input), parsed = await decodeAdmissionPolicyArchivePage(bytes);
    expect(parsed.previous).toBe(previous); offset += parsed.entries.length; previous = admissionPolicyArchivePageDigest(bytes);
  }
  expect(offset).toBe(129);
  // This cannot pass policy authentication: unchanged v2 refuses a 65th archived entry.
  const { authority: _, signature: __, ...body } = second;
  await expect(signAdmissionPolicy({ ...body, archivedKeys: Array(65).fill(entries[0]) }, authority, key.secretKey)).rejects.toThrow();
});


it('keeps v1 reference bytes and limits exact while selecting a separate bounded startup execution', async () => {
  const reference = admissionPolicyProofReference(context, context.genesis, limits);
  const body = { version: 1, context, genesis: context.genesis, head: context.genesis, limits };
  expect(JSON.stringify(reference)).toBe(JSON.stringify({ ...body, reference: `sha256:${createHash('sha256').update('resonance:admission-policy-proof:v1\n').update(JSON.stringify(body)).digest('hex')}` }));
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    const bounded = new AdmissionPolicyArchiveBudget({ limits: { ...limits, timeoutMs: 3000 } });
    const execution = { version: 2 as const, purpose: 'offline-startup-reconstruction' as const, timeoutMs: 30000 };
    const startup = new AdmissionPolicyArchiveExecutionContext({ execution, timeoutMs: 3000 });
    clock.mockReturnValue(3200);
    expect(() => bounded.check()).toThrow('timed out');
    // Discovery of the first proof cannot restart the public-open clock.
    const budget = new AdmissionPolicyArchiveBudget({ limits: { ...limits, timeoutMs: 3000 }, execution, deadline: startup.executionDeadline });
    expect(budget.limits.timeoutMs).toBe(3000); expect(() => budget.check()).not.toThrow();
    clock.mockReturnValue(30100); expect(() => budget.check()).toThrow('timed out');
    clock.mockReturnValue(100);
    const short = new AdmissionPolicyArchiveBudget({ limits, execution, deadline: 200 });
    clock.mockReturnValue(200); expect(() => short.check()).toThrow('timed out');
  } finally { clock.mockRestore(); }
});

it('rejects malformed execution contracts and prevents offline budgets entering default live helpers', async () => {
  for (const execution of [null, {}, { version: 1, purpose: 'reference-bounded', timeoutMs: 3000 },
    { version: 2, purpose: 'reference-bounded', timeoutMs: 30000 },
    ...[0, -1, 1.5, 30001, Infinity, NaN, '30000'].map(timeoutMs => ({ version: 2, purpose: 'offline-startup-reconstruction', timeoutMs }))]) {
    expect(() => new AdmissionPolicyArchiveBudget({ limits, execution: execution as never })).toThrow('execution contract');
  }
  for (const deadline of [Infinity, NaN, -Infinity]) expect(() => new AdmissionPolicyArchiveExecutionContext({ timeoutMs: 3000, deadline })).toThrow('deadline');
  const execution = { version: 2 as const, purpose: 'offline-startup-reconstruction' as const, timeoutMs: 30000 };
  const budget = new AdmissionPolicyArchiveBudget({ limits, execution });
  const args = { context, genesis, advances: [], selectedHead: context.genesis, reader, limits, budget };
  await expect(resolveAdmissionPolicy(args)).rejects.toThrow('execution purpose');
  const policy = await resolveAdmissionPolicy({ ...args, execution });
  // Even a membership result available without archive I/O must enforce the purpose.
  await expect(resolveAdmissionPolicyHistoryMembership({ policy, issuerKeys: [], reader, limits, budget })).rejects.toThrow('execution purpose');
  for (const name of ['maxPages', 'maxEntries', 'maxArchiveBytes', 'maxHistoryBytes', 'maxTransitions', 'maxPageReads'] as const) {
    const shared = new AdmissionPolicyArchiveBudget({ limits, execution });
    shared.charge(name, limits[name] - 1); shared.charge(name, 1);
    expect(() => shared.charge(name, 1)).toThrow(name);
  }
});


it('publishes funded enrollment memberships only after complete validation and binds their original handle', async () => {
  const previous = await resolveAdmissionPolicy({ context, genesis, advances: [firstAdvance, secondAdvance], selectedHead: secondAdvance.commitment.next, reader, limits });
  const extra = structuredClone(entries[2]); extra.profile.scope.epoch = 'new-period'; extra.profile.issuerPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  extra.notBefore = 1030; extra.issueUntil = 1031; extra.spendUntil = 1032; extra.retryUntil = 1033;
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 4, issuedAt: 1030, expiresAt: 5000, activeKey: admissionKeyFingerprint(extra.profile.issuerPublicKey), keys: [extra] }, reader, limits });
  for (const page of plan.pages) store.set(page.digest, page.bytes);
  const policy = await signAdmissionPolicyV3(plan.body, authority, key.secretKey);
  const next = await createResolvedAdmissionPolicyAdvance({ previous, policy, key, reader, limits });
  const issuerKeys = [...entries, extra].map(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey));
  const memberships = await resolveAdmissionPolicyCatalogueMembership({ policy: next.resolved, issuerKeys, reader, limits }); expect(memberships.size).toBe(4);
  expect(inspectResolvedAdmissionPolicyKey(next.resolved, memberships.get(issuerKeys[0])!)).toEqual(entries[0]);
  expect(() => inspectResolvedAdmissionPolicyKey(previous, memberships.get(issuerKeys[0])!)).toThrow('original resolved membership');
  let reads = 0;
  await expect(resolveAdmissionPolicyCatalogueMembership({ policy: next.resolved, issuerKeys, limits, reader: async digest => { const bytes = await reader(digest); return ++reads === 2 ? new Uint8Array(bytes.length) : bytes; } })).rejects.toThrow('digest differs');
  const input = { policy: next.resolved, issuerKeys, limits, reader: async (digest: string) => { input.policy = previous; return reader(digest); } };
  const captured = await resolveAdmissionPolicyCatalogueMembership(input);
  expect(inspectResolvedAdmissionPolicyKey(next.resolved, captured.get(issuerKeys[0])!)).toEqual(entries[0]);
  expect(() => inspectResolvedAdmissionPolicyKey(previous, captured.get(issuerKeys[0])!)).toThrow('original resolved membership');
  const budget = new AdmissionPolicyArchiveBudget({ limits }); budget.charge('maxPageReads', limits.maxPageReads - 1);
  await expect(resolveAdmissionPolicyCatalogueMembership({ policy: next.resolved, issuerKeys, reader, limits, budget })).rejects.toThrow('maxPageReads');
  const controller = new AbortController(); reads = 0;
  await expect(resolveAdmissionPolicyCatalogueMembership({ policy: next.resolved, issuerKeys, limits, signal: controller.signal, reader: async digest => { const bytes = await reader(digest); if (++reads === 2) controller.abort(); return bytes; } })).rejects.toThrow('cancelled');
});
