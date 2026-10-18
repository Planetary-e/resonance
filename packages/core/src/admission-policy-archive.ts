/** Isolated historical archive prerequisite. A verified handle is not traffic authorization.
 * Existing v1/v2 policy limits still apply; pages do not retire original history. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { MAX_ADMISSION_POLICY_BYTES } from './admission-policy-limits.js';
import { admissionAuthorityFingerprint, admissionPolicyDigest, admissionKeyFingerprint, admissionPolicyKeys, assertAdmissionPolicySuccessor, parseAdmissionPolicyBody, verifyAdmissionPolicy,
  type AdmissionPolicyBody, type AdmissionPolicyKey, type SignedAdmissionPolicy } from './admission-policy.js';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES, admissionPolicyHead, createAdmissionPolicyAdvanceCommitment, parseAdmissionPolicyAdvance, parseAdmissionPolicyAdvanceCommitment, sameAdmissionPolicyHead, type AdmissionPolicyAdvanceCommitment } from './admission-policy-advance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers,
  type AdmissionPolicyHead, type AdmissionPolicyObservers } from './admission-policy-freshness.js';
import { parseAdmissionWalletProfile } from './admission-profile.js';
import { copyAdmissionSigningKey, exactWitnessFields, parseAdmissionWitnessSet, witnessBytes } from './admission-witness.js';

export const ADMISSION_POLICY_ARCHIVE_PAGE_MAX_ENTRIES = 64;
export const ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES = 512 * 1024;
const PAGE_DOMAIN = 'resonance:admission-policy-archive-page:v1\n';
const hashId = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export interface AdmissionPolicyArchivePage {
  version: 1; kind: 'admission-policy-archive-page'; contextId: string; previous: string | null;
  index: number; firstEntry: number; entries: AdmissionPolicyKey[];
}
export interface AdmissionPolicyArchiveDescriptor {
  version: 1; kind: 'admission-policy-archive'; contextId: string; root: string | null;
  pageCount: number; entryCount: number; archiveBytes: number;
}
/** All ceilings are cumulative per operation, including rescans. No defaults. */
export interface AdmissionPolicyArchiveLimits {
  maxPages: number; maxEntries: number; maxArchiveBytes: number; maxHistoryBytes: number;
  maxTransitions: number; maxPageReads: number; timeoutMs: number;
}
export type AdmissionPolicyArchiveReader = (digest: string, signal: AbortSignal) => Promise<Uint8Array>;
interface Operation { limits: AdmissionPolicyArchiveLimits; signal?: AbortSignal }
class Budget {
  readonly limits: AdmissionPolicyArchiveLimits;
  readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly signal?: AbortSignal;
  private counts = { maxPages: 0, maxEntries: 0, maxArchiveBytes: 0, maxHistoryBytes: 0, maxTransitions: 0, maxPageReads: 0 };
  constructor(operation: Operation) {
    this.signal = operation.signal;
    const value = structuredClone(operation.limits);
    if (!exactWitnessFields(value, ['maxPages','maxEntries','maxArchiveBytes','maxHistoryBytes','maxTransitions','maxPageReads','timeoutMs'])
      || Object.values(value).some(n => !integer(n)) || value.timeoutMs < 1 || value.timeoutMs > 2_147_483_647) throw new Error('Invalid archive limits');
    this.limits = value; this.deadline = performance.now() + value.timeoutMs; this.check();
  }
  check() {
    if (this.signal?.aborted || performance.now() >= this.deadline) {
      this.controller.abort(); throw new Error('Archive operation cancelled or timed out');
    }
  }
  charge(name: keyof Budget['counts'], amount: number) {
    this.check(); const count = this.counts[name] + amount;
    if (!integer(count) || count > this.limits[name]) throw new Error(`Archive limit exhausted: ${name}`);
    this.counts[name] = count;
  }
  snapshot(value: unknown) {
    this.check(); const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('Invalid archive input');
    this.charge('maxHistoryBytes', Buffer.byteLength(encoded));
    return JSON.parse(encoded) as unknown;
  }
  async wait<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const refusal = new Promise<never>((_, reject) => {
        abort = () => { this.controller.abort(); reject(new Error('Archive operation cancelled or timed out')); };
        this.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, Math.max(1, this.deadline - performance.now()));
      });
      const result = await Promise.race([work(), refusal]); this.check(); return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) this.signal?.removeEventListener('abort', abort);
    }
  }
}
function descriptor(value: unknown): AdmissionPolicyArchiveDescriptor {
  if (!exactWitnessFields(value, ['version','kind','contextId','root','pageCount','entryCount','archiveBytes'])
    || value.version !== 1 || value.kind !== 'admission-policy-archive' || !hashId(value.contextId)
    || !(value.root === null || hashId(value.root)) || !integer(value.pageCount) || !integer(value.entryCount) || !integer(value.archiveBytes)
    || (value.pageCount === 0 ? value.root !== null || value.entryCount !== 0 || value.archiveBytes !== 0
      : value.root === null || value.entryCount < value.pageCount || value.entryCount / value.pageCount > 64 || value.archiveBytes < value.pageCount)) {
    throw new Error('Invalid archive descriptor');
  }
  return { version: 1, kind: 'admission-policy-archive', contextId: value.contextId, root: value.root,
    pageCount: value.pageCount, entryCount: value.entryCount, archiveBytes: value.archiveBytes };
}
export function emptyAdmissionPolicyArchive(contextId: string): AdmissionPolicyArchiveDescriptor {
  return descriptor({ version: 1, kind: 'admission-policy-archive', contextId, root: null, pageCount: 0, entryCount: 0, archiveBytes: 0 });
}
async function normalizedEntry(value: unknown): Promise<AdmissionPolicyKey> {
  if (!exactWitnessFields(value, ['profile','notBefore','issueUntil','spendUntil','retryUntil',
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'witnesses') ? ['witnesses'] : [])])
    || !integer(value.notBefore) || !integer(value.issueUntil) || !integer(value.spendUntil) || !integer(value.retryUntil)
    || value.notBefore >= value.issueUntil || value.issueUntil > value.spendUntil || value.spendUntil > value.retryUntil) throw new Error('Invalid archive entry');
  const input = structuredClone(value), { profile } = await parseAdmissionWalletProfile(input.profile);
  return { profile, notBefore: input.notBefore as number, issueUntil: input.issueUntil as number,
    spendUntil: input.spendUntil as number, retryUntil: input.retryUntil as number,
    ...(Object.hasOwn(input, 'witnesses') ? { witnesses: parseAdmissionWitnessSet(input.witnesses) } : {}) };
}
async function normalizedPage(value: unknown): Promise<AdmissionPolicyArchivePage> {
  if (!exactWitnessFields(value, ['version','kind','contextId','previous','index','firstEntry','entries'])
    || value.version !== 1 || value.kind !== 'admission-policy-archive-page' || !hashId(value.contextId)
    || !(value.previous === null || hashId(value.previous)) || !integer(value.index) || !integer(value.firstEntry)
    || (value.index === 0 ? value.previous !== null || value.firstEntry !== 0 : value.previous === null || value.firstEntry < value.index)
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 64
    || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) throw new Error('Invalid or oversized archive page');
  const input = structuredClone(value), entries: AdmissionPolicyKey[] = [];
  for (const entry of input.entries as unknown[]) entries.push(await normalizedEntry(entry));
  return { version: 1, kind: 'admission-policy-archive-page', contextId: input.contextId as string, previous: input.previous as string | null,
    index: input.index as number, firstEntry: input.firstEntry as number, entries };
}
/** Structural/canonical mechanics only: neither encoding nor hashing authenticates history. */
export async function encodeAdmissionPolicyArchivePage(value: unknown): Promise<Uint8Array> {
  const page = await normalizedPage(value), bytes = Buffer.from(JSON.stringify(page));
  if (bytes.length > ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) throw new Error('Oversized archive page');
  return Uint8Array.from(bytes);
}
export async function decodeAdmissionPolicyArchivePage(value: Uint8Array): Promise<AdmissionPolicyArchivePage> {
  const bytes = pageBytes(value), raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const page = await normalizedPage(JSON.parse(raw));
  if (JSON.stringify(page) !== raw) throw new Error('Archive page is not canonical');
  return page;
}
function pageBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) throw new Error('Invalid or oversized archive page bytes');
  return Uint8Array.from(value);
}
export function admissionPolicyArchivePageDigest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(PAGE_DOMAIN).update(pageBytes(value)).digest('hex')}`;
}
function successor(previous: SignedAdmissionPolicy, next: SignedAdmissionPolicy) {
  assertAdmissionPolicySuccessor(previous, next);
  const prior = admissionPolicyKeys(previous), active = previous.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === previous.activeKey)!;
  const fresh = admissionPolicyKeys(next).filter(entry => !prior.some(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey)));
  if (fresh.length && (fresh.length !== 1 || admissionKeyFingerprint(fresh[0].profile.issuerPublicKey) !== next.activeKey || !fresh[0].witnesses)) {
    throw new Error('Rotation requires exactly one fresh witnessed active issuer');
  }
  for (const entry of fresh) {
    if (entry.profile.scope.issuer !== active.profile.scope.issuer || entry.profile.scope.community !== active.profile.scope.community
      || prior.some(e => e.profile.scope.epoch === entry.profile.scope.epoch)) throw new Error('New archive provenance requires a fresh shared period');
  }
}
function extendArchive(expected: AdmissionPolicyKey[], policy: SignedAdmissionPolicy) {
  // Existing policy bounds cap this retained metadata at 64 entries, not an unbounded index.
  const extra = (policy.archivedKeys ?? []).filter(entry => !expected.some(old => admissionKeyFingerprint(old.profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey)));
  return [...expected, ...extra];
}
function checkDescriptorBounds(value: AdmissionPolicyArchiveDescriptor, budget: Budget) {
  budget.check();
  if (value.pageCount > budget.limits.maxPages || value.entryCount > budget.limits.maxEntries || value.archiveBytes > budget.limits.maxArchiveBytes) throw new Error('Archive descriptor exceeds limits');
}
async function scan(value: AdmissionPolicyArchiveDescriptor, expected: AdmissionPolicyKey[], reader: AdmissionPolicyArchiveReader, budget: Budget) {
  checkDescriptorBounds(value, budget);
  if (value.entryCount !== expected.length) throw new Error('Archive entry count differs from authenticated history');
  let digest = value.root, index = value.pageCount, remaining = value.entryCount, totalBytes = 0;
  while (digest !== null) {
    budget.charge('maxPageReads', 1); budget.charge('maxPages', 1);
    const bytes = await budget.wait(async () => pageBytes(await reader(digest!, budget.controller.signal)));
    budget.charge('maxArchiveBytes', bytes.byteLength); totalBytes += bytes.byteLength;
    if (admissionPolicyArchivePageDigest(bytes) !== digest) throw new Error('Archive page digest differs');
    const page = await budget.wait(() => decodeAdmissionPolicyArchivePage(bytes));
    budget.charge('maxEntries', page.entries.length);
    index--; remaining -= page.entries.length;
    if (index < 0 || remaining < 0 || page.contextId !== value.contextId || page.index !== index || page.firstEntry !== remaining
      || JSON.stringify(page.entries) !== JSON.stringify(expected.slice(remaining, remaining + page.entries.length))) throw new Error('Archive page differs from complete authenticated history');
    digest = page.previous;
  }
  if (index !== 0 || remaining !== 0 || totalBytes !== value.archiveBytes) throw new Error('Incomplete archive chain or byte count');
  budget.check();
}
declare const authenticated: unique symbol;
export interface VerifiedAdmissionPolicyArchive { readonly [authenticated]: true }
interface Retained {
  context: AdmissionPolicyObservers; head: AdmissionPolicyHead; policy: SignedAdmissionPolicy;
  descriptor: AdmissionPolicyArchiveDescriptor; expected: AdmissionPolicyKey[];
}
const handles = new WeakMap<VerifiedAdmissionPolicyArchive, Retained>();
function retain(value: Retained): VerifiedAdmissionPolicyArchive {
  const handle = Object.freeze({}) as VerifiedAdmissionPolicyArchive;
  handles.set(handle, structuredClone(value)); return handle;
}
function requireHandle(handle: VerifiedAdmissionPolicyArchive): Retained {
  const value = handles.get(handle);
  if (!value) throw new Error('Archive requires its original authenticated runtime handle');
  return value;
}
export interface VerifyAdmissionPolicyArchiveOptions extends Operation {
  context: AdmissionPolicyObservers; genesis: unknown; advances: readonly unknown[];
  selectedHead: AdmissionPolicyHead; descriptor: AdmissionPolicyArchiveDescriptor; reader: AdmissionPolicyArchiveReader;
}
export async function verifyAdmissionPolicyArchive(options: VerifyAdmissionPolicyArchiveOptions): Promise<VerifiedAdmissionPolicyArchive> {
  const budget = new Budget(options), context = parseAdmissionPolicyObservers(structuredClone(options.context)),
    selectedHead = parseAdmissionPolicyHead(structuredClone(options.selectedHead)), archive = descriptor(structuredClone(options.descriptor)), reader = options.reader;
  if (archive.contextId !== admissionPolicyObserversId(context)) throw new Error('Archive observer context differs');
  if (!Array.isArray(options.advances) || options.advances.length > budget.limits.maxTransitions) throw new Error('Archive transition limit exhausted');
  // Serialize and copy every caller-owned history value before the first await.
  const genesis = budget.snapshot(options.genesis), advances = options.advances.map(value => budget.snapshot(value));
  let policy = await budget.wait(() => verifyAdmissionPolicy(genesis, context.authority)), head = admissionPolicyHead(policy);
  if (!sameAdmissionPolicyHead(head, context.genesis)) throw new Error('Archive requires the original pinned signed genesis');
  let expected = extendArchive([], policy);
  for (const value of advances) {
    budget.charge('maxTransitions', 1);
    const advance = await budget.wait(() => parseAdmissionPolicyAdvance(value, context));
    if (!sameAdmissionPolicyHead(head, advance.commitment.previous)) throw new Error('Archive provenance has a gap or fork');
    successor(policy, advance.policy); policy = advance.policy; head = advance.commitment.next; expected = extendArchive(expected, policy);
  }
  if (!sameAdmissionPolicyHead(head, selectedHead)) throw new Error('Archive selected terminal head is stale or conflicting');
  await scan(archive, expected, reader, budget);
  return retain({ context, head, policy, descriptor: archive, expected });
}
export interface StagedAdmissionPolicyArchive {
  descriptor: AdmissionPolicyArchiveDescriptor; handle: VerifiedAdmissionPolicyArchive;
  /** Caller owns these bytes. No pages or descriptors have been published. */
  pages: Array<{ digest: string; bytes: Uint8Array }>;
}
export async function appendAdmissionPolicyArchive(options: Operation & {
  handle: VerifiedAdmissionPolicyArchive; advance: unknown; selectedHead: AdmissionPolicyHead; reader: AdmissionPolicyArchiveReader;
}): Promise<StagedAdmissionPolicyArchive> {
  const budget = new Budget(options), retained = requireHandle(options.handle), reader = options.reader,
    input = budget.snapshot(options.advance), selectedHead = parseAdmissionPolicyHead(structuredClone(options.selectedHead));
  budget.charge('maxTransitions', 1);
  const advance = await budget.wait(() => parseAdmissionPolicyAdvance(input, retained.context));
  if (!sameAdmissionPolicyHead(advance.commitment.previous, retained.head) || !sameAdmissionPolicyHead(advance.commitment.next, selectedHead)) throw new Error('Archive append requires the selected immediate successor');
  successor(retained.policy, advance.policy);
  const expected = extendArchive(retained.expected, advance.policy);
  await scan(retained.descriptor, retained.expected, reader, budget);
  const { descriptor: archive, pages } = stagePages(retained.descriptor, expected.slice(retained.expected.length), budget);
  return { descriptor: structuredClone(archive), pages,
    handle: retain({ context: retained.context, head: selectedHead, policy: advance.policy, descriptor: archive, expected }) };
}
function stagePages(prefix: AdmissionPolicyArchiveDescriptor, additions: AdmissionPolicyKey[], budget: Budget) {
  const archive = structuredClone(prefix), pages: StagedAdmissionPolicyArchive['pages'] = [];
  let entries: AdmissionPolicyKey[] = [];
  const page = (): AdmissionPolicyArchivePage => ({ version: 1, kind: 'admission-policy-archive-page', contextId: archive.contextId,
    previous: archive.root, index: archive.pageCount, firstEntry: archive.entryCount, entries });
  const flush = () => {
    budget.check(); const bytes = Uint8Array.from(Buffer.from(JSON.stringify(page()))), digest = admissionPolicyArchivePageDigest(bytes);
    budget.charge('maxPages', 1); budget.charge('maxEntries', entries.length); budget.charge('maxArchiveBytes', bytes.byteLength);
    pages.push({ digest, bytes }); archive.root = digest; archive.pageCount++; archive.entryCount += entries.length; archive.archiveBytes += bytes.byteLength; entries = [];
  };
  for (const entry of additions) {
    budget.check(); entries.push(entry);
    if (entries.length > 64 || Buffer.byteLength(JSON.stringify(page())) > ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) {
      entries.pop(); if (!entries.length) throw new Error('Archive entry exceeds page ceiling'); flush(); entries.push(entry);
    }
  }
  if (entries.length) flush();
  checkDescriptorBounds(archive, budget); budget.check();
  return { descriptor: archive, pages };
}

/** Revalidates the entire reader chain before returning a match or absence. */
export async function lookupAdmissionPolicyArchive(options: Operation & {
  handle: VerifiedAdmissionPolicyArchive; issuerKey: string; reader: AdmissionPolicyArchiveReader;
}): Promise<AdmissionPolicyKey | undefined> {
  const budget = new Budget(options), retained = requireHandle(options.handle), issuerKey = options.issuerKey, reader = options.reader;
  if (!hashId(issuerKey)) throw new Error('Invalid archived issuer fingerprint');
  await scan(retained.descriptor, retained.expected, reader, budget);
  const entry = retained.expected.find(value => admissionKeyFingerprint(value.profile.issuerPublicKey) === issuerKey);
  return entry ? structuredClone(entry) : undefined;
}

/** V3 signature/schema validation is deliberately separate from resolved provenance. */
export interface AdmissionPolicyBodyV3 extends Omit<AdmissionPolicyBody, 'version' | 'archivedKeys'> {
  version: 3; archive: AdmissionPolicyArchiveDescriptor;
}
export interface SignedAdmissionPolicyV3 extends AdmissionPolicyBodyV3 { authority: string; signature: string }
export type ArchivedAdmissionPolicy = SignedAdmissionPolicy | SignedAdmissionPolicyV3;
export interface ArchivedAdmissionPolicyAdvance { commitment: AdmissionPolicyAdvanceCommitment; policy: ArchivedAdmissionPolicy }
function v3Payload(body: AdmissionPolicyBodyV3) {
  return Buffer.from('resonance:admission-policy:v3\n' + JSON.stringify([body.version, body.kind, body.revision, body.issuedAt,
    body.expiresAt, body.activeKey, body.keys.map(e => [e.profile, e.notBefore, e.issueUntil, e.spendUntil, e.retryUntil, ...(e.witnesses ? [e.witnesses] : [])]), body.archive]));
}
export async function parseAdmissionPolicyBodyV3(value: unknown): Promise<AdmissionPolicyBodyV3> {
  if (!exactWitnessFields(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','archive'])
    || value.version !== 3 || Buffer.byteLength(JSON.stringify(value)) > MAX_ADMISSION_POLICY_BYTES) throw new Error('Invalid v3 admission policy');
  const input = structuredClone(value), archive = descriptor(input.archive);
  const { archive: _, ...fields } = input;
  const normalized = await parseAdmissionPolicyBody({ ...fields, version: 2, archivedKeys: [] });
  const { archivedKeys: __, ...body } = normalized;
  return { ...body, version: 3, archive };
}
/** Produces an offline signature only. It does not establish ancestry or activation. */
export async function signAdmissionPolicyV3(value: unknown, authority: string, secretKey: Uint8Array): Promise<SignedAdmissionPolicyV3> {
  admissionAuthorityFingerprint(authority); const secret = Uint8Array.from(secretKey);
  try {
    const body = await parseAdmissionPolicyBodyV3(value), signature = sign(v3Payload(body), secret);
    if (!verify(v3Payload(body), signature, Buffer.from(authority, 'base64url'))) throw new Error('V3 authority private key differs');
    const policy = { ...body, authority, signature: Buffer.from(signature).toString('base64url') };
    if (Buffer.byteLength(JSON.stringify(policy) + '\n') > MAX_ADMISSION_POLICY_BYTES) throw new Error('Oversized signed v3 policy');
    return policy;
  } finally { secret.fill(0); }
}
export async function verifyAdmissionPolicyV3(value: unknown, authority: string): Promise<SignedAdmissionPolicyV3> {
  admissionAuthorityFingerprint(authority);
  if (!exactWitnessFields(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','archive','authority','signature'])
    || value.authority !== authority || !witnessBytes(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_ADMISSION_POLICY_BYTES) throw new Error('Invalid signed v3 admission policy');
  const input = structuredClone(value), { authority: _, signature, ...unsigned } = input;
  const body = await parseAdmissionPolicyBodyV3(unsigned);
  if (!verify(v3Payload(body), Buffer.from(signature as string, 'base64url'), Buffer.from(authority, 'base64url'))) throw new Error('Invalid v3 community policy signature');
  return { ...body, authority, signature: signature as string };
}
export function admissionPolicyV3Digest(policy: AdmissionPolicyBodyV3): string {
  if (policy.version !== 3) throw new Error('V3 digest requires a v3 policy');
  return createHash('sha256').update(v3Payload(policy)).digest('hex');
}
export const archivedAdmissionPolicyDigest = (policy: ArchivedAdmissionPolicy): string => policy.version === 3 ? admissionPolicyV3Digest(policy) : admissionPolicyDigest(policy);

/** No full-archive array is retained after migration. The reader is always revalidated. */
interface ResolvedState {
  context: AdmissionPolicyObservers; head: AdmissionPolicyHead; policy: ArchivedAdmissionPolicy;
  /** Legacy-only, capped by the unchanged v2 wire limit. */
  legacyArchive?: AdmissionPolicyKey[];
}
declare const resolvedBrand: unique symbol;
export interface ResolvedAdmissionPolicy { readonly [resolvedBrand]: true }
const resolvedPolicies = new WeakMap<ResolvedAdmissionPolicy, ResolvedState>();
function resolvedState(handle: ResolvedAdmissionPolicy): ResolvedState {
  const state = resolvedPolicies.get(handle);
  if (!state) throw new Error('Policy requires its original resolved runtime capability');
  return state;
}
function resolvedHandle(state: ResolvedState): ResolvedAdmissionPolicy {
  const handle = Object.freeze({}) as ResolvedAdmissionPolicy;
  resolvedPolicies.set(handle, structuredClone(state)); return handle;
}
/** Snapshot has at most eight current keys. It is metadata, not a serializable capability. */
export function inspectResolvedAdmissionPolicy(handle: ResolvedAdmissionPolicy) {
  const state = resolvedState(handle);
  return structuredClone({ context: state.context, head: state.head, policy: state.policy, currentKeys: state.policy.keys,
    archive: state.policy.version === 3 ? state.policy.archive : null });
}
async function walkPages(archive: AdmissionPolicyArchiveDescriptor, reader: AdmissionPolicyArchiveReader, budget: Budget,
  visit: (entries: AdmissionPolicyKey[], firstEntry: number) => void | Promise<void>,
  prefix = emptyAdmissionPolicyArchive(archive.contextId)) {
  checkDescriptorBounds(archive, budget);
  if (archive.contextId !== prefix.contextId || archive.pageCount < prefix.pageCount || archive.entryCount < prefix.entryCount
    || archive.archiveBytes < prefix.archiveBytes) throw new Error('Archive prefix regressed');
  let digest = archive.root, index = archive.pageCount, count = archive.entryCount, bytesRead = 0;
  while (digest !== prefix.root) {
    if (digest === null || index <= prefix.pageCount) throw new Error('Archive lost its exact root prefix');
    budget.charge('maxPageReads', 1); budget.charge('maxPages', 1);
    const bytes = await budget.wait(async () => pageBytes(await reader(digest!, budget.controller.signal)));
    budget.charge('maxArchiveBytes', bytes.byteLength); bytesRead += bytes.byteLength;
    if (admissionPolicyArchivePageDigest(bytes) !== digest) throw new Error('Archive page digest differs');
    const page = await budget.wait(() => decodeAdmissionPolicyArchivePage(bytes));
    budget.charge('maxEntries', page.entries.length); index--; count -= page.entries.length;
    if (page.contextId !== archive.contextId || page.index !== index || page.firstEntry !== count || count < prefix.entryCount) throw new Error('Archive page index or offset differs');
    await budget.wait(async () => { await visit(page.entries, page.firstEntry); });
    digest = page.previous;
  }
  if (index !== prefix.pageCount || count !== prefix.entryCount || bytesRead !== archive.archiveBytes - prefix.archiveBytes) throw new Error('Archive prefix counts or bytes differ');
  budget.check();
}
function retainedCurrent(previous: AdmissionPolicyKey, next: AdmissionPolicyKey) {
  return JSON.stringify(previous.profile) === JSON.stringify(next.profile) && JSON.stringify(previous.witnesses) === JSON.stringify(next.witnesses)
    && previous.notBefore === next.notBefore && next.issueUntil <= previous.issueUntil && next.spendUntil <= previous.spendUntil && next.retryUntil <= previous.retryUntil;
}
function removedCurrent(previous: ArchivedAdmissionPolicy, next: AdmissionPolicyBodyV3) {
  return previous.keys.filter(old => !next.keys.some(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey)));
}
async function validateV3Successor(previous: ResolvedState, next: SignedAdmissionPolicyV3 | AdmissionPolicyBodyV3,
  reader: AdmissionPolicyArchiveReader, budget: Budget) {
  const old = previous.policy;
  if (old.version === 1 || next.revision !== old.revision + 1 || next.issuedAt < old.issuedAt
    || next.archive.contextId !== admissionPolicyObserversId(previous.context)) throw new Error('V3 requires v2/v3 immediate ancestry and original context');
  const additions = removedCurrent(old, next);
  for (const entry of old.keys) {
    const retained = next.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey));
    if (retained ? !retainedCurrent(entry, retained) : entry.retryUntil > next.issuedAt) throw new Error('V3 changed retained pins/cutoffs or archived before final retry');
  }
  const fresh = next.keys.filter(e => !old.keys.some(prior => admissionKeyFingerprint(e.profile.issuerPublicKey) === admissionKeyFingerprint(prior.profile.issuerPublicKey)));
  const active = old.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === old.activeKey)!;
  if (fresh.length && (fresh.length !== 1 || admissionKeyFingerprint(fresh[0].profile.issuerPublicKey) !== next.activeKey || !fresh[0].witnesses
    || fresh[0].profile.scope.issuer !== active.profile.scope.issuer || fresh[0].profile.scope.community !== active.profile.scope.community
    || old.keys.some(e => e.profile.scope.epoch === fresh[0].profile.scope.epoch))) throw new Error('V3 rotation requires one fresh witnessed active issuer and period');
  const comparePrior = (entries: AdmissionPolicyKey[]) => {
    for (const archived of entries) {
      if (next.keys.some(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === admissionKeyFingerprint(archived.profile.issuerPublicKey))
        || fresh.some(e => e.profile.scope.epoch === archived.profile.scope.epoch)) throw new Error('V3 cannot reuse an archived issuer or period');
    }
  };
  if (old.version === 3) {
    if (next.archive.entryCount !== old.archive.entryCount + additions.length) throw new Error('V3 appended archive count differs');
    await walkPages(old.archive, reader, budget, comparePrior);
    await walkPages(next.archive, reader, budget, (entries, offset) => {
      if (JSON.stringify(entries) !== JSON.stringify(additions.slice(offset - old.archive.entryCount, offset - old.archive.entryCount + entries.length))) throw new Error('V3 appended archive differs from eligible predecessor keys');
    }, old.archive);
  } else {
    const legacy = previous.legacyArchive!; comparePrior(legacy);
    const migration = [...legacy, ...additions]; // At most 64 + 8, independent of v3 lifetime.
    if (next.archive.entryCount !== migration.length) throw new Error('V3 migration archive count differs');
    await walkPages(next.archive, reader, budget, (entries, offset) => {
      if (JSON.stringify(entries) !== JSON.stringify(migration.slice(offset, offset + entries.length))) throw new Error('V3 migration differs from exact chronological legacy archive');
    });
  }
}
async function parseArchivedAdvance(value: unknown, context: AdmissionPolicyObservers, budget: Budget): Promise<ArchivedAdmissionPolicyAdvance> {
  if (!exactWitnessFields(value, ['commitment','policy']) || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_ADVANCE_MAX_BYTES) throw new Error('Invalid archive policy advance');
  const commitment = parseAdmissionPolicyAdvanceCommitment(value.commitment, context);
  const policy = await budget.wait<ArchivedAdmissionPolicy>(() => (value.policy as { version?: unknown })?.version === 3
    ? verifyAdmissionPolicyV3(value.policy, context.authority) : verifyAdmissionPolicy(value.policy, context.authority));
  if (policy.revision !== commitment.next.revision || archivedAdmissionPolicyDigest(policy) !== commitment.next.digest) throw new Error('Policy differs from signed advance digest');
  return { commitment, policy };
}
/** Signature/schema authentication only; installation requires resolveAdmissionPolicySuccessor. */
export async function parseArchivedAdmissionPolicyAdvance(value: unknown, contextValue: AdmissionPolicyObservers, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ArchivedAdmissionPolicyAdvance> {
  const context = parseAdmissionPolicyObservers(contextValue);
  return parseArchivedAdvance(value, context, new Budget({ signal: options.signal, limits: { maxPages: 1, maxEntries: 1, maxArchiveBytes: 1, maxHistoryBytes: 1, maxTransitions: 1, maxPageReads: 1, timeoutMs: options.timeoutMs ?? 3000 } }));
}
async function resolveStep(previous: ResolvedState, advance: ArchivedAdmissionPolicyAdvance, reader: AdmissionPolicyArchiveReader, budget: Budget): Promise<ResolvedState> {
  if (!sameAdmissionPolicyHead(previous.head, advance.commitment.previous)) throw new Error('Resolved policy ancestry has a gap or fork');
  if (advance.policy.version === 3) {
    await validateV3Successor(previous, advance.policy, reader, budget);
    return { context: previous.context, head: advance.commitment.next, policy: advance.policy };
  }
  if (previous.policy.version === 3) throw new Error('Cannot downgrade resolved v3 policy');
  successor(previous.policy, advance.policy);
  return { context: previous.context, head: advance.commitment.next, policy: advance.policy,
    legacyArchive: extendArchive(previous.legacyArchive!, advance.policy) };
}
export interface ResolveAdmissionPolicyOptions extends Operation {
  context: AdmissionPolicyObservers; genesis: unknown; advances: readonly unknown[]; selectedHead: AdmissionPolicyHead; reader: AdmissionPolicyArchiveReader;
}
/** Full original provenance; v3 cannot be a fresh genesis or bypass the signed transition chain. */
export async function resolveAdmissionPolicy(options: ResolveAdmissionPolicyOptions): Promise<ResolvedAdmissionPolicy> {
  const budget = new Budget(options), context = parseAdmissionPolicyObservers(structuredClone(options.context)), reader = options.reader,
    selected = parseAdmissionPolicyHead(structuredClone(options.selectedHead));
  if (!Array.isArray(options.advances) || options.advances.length > budget.limits.maxTransitions) throw new Error('Resolved policy transition limit exhausted');
  const genesis = budget.snapshot(options.genesis), inputs = options.advances.map(v => budget.snapshot(v));
  const policy = await budget.wait(() => verifyAdmissionPolicy(genesis, context.authority)), head = admissionPolicyHead(policy);
  if (!sameAdmissionPolicyHead(head, context.genesis)) throw new Error('Resolved policy requires original signed genesis');
  let state: ResolvedState = { context, head, policy, legacyArchive: extendArchive([], policy) };
  for (const input of inputs) {
    budget.charge('maxTransitions', 1);
    state = await resolveStep(state, await parseArchivedAdvance(input, context, budget), reader, budget);
  }
  if (!sameAdmissionPolicyHead(state.head, selected)) throw new Error('Resolved policy selected head is stale or conflicting');
  budget.check(); return resolvedHandle(state);
}
export async function resolveAdmissionPolicyAdvance(options: Operation & {
  previous: ResolvedAdmissionPolicy; advance: unknown; selectedHead: AdmissionPolicyHead; reader: AdmissionPolicyArchiveReader;
}): Promise<ResolvedAdmissionPolicy> {
  const budget = new Budget(options), previous = resolvedState(options.previous), input = budget.snapshot(options.advance),
    selected = parseAdmissionPolicyHead(structuredClone(options.selectedHead)), reader = options.reader;
  budget.charge('maxTransitions', 1);
  const advance = await parseArchivedAdvance(input, previous.context, budget);
  if (!sameAdmissionPolicyHead(advance.commitment.next, selected)) throw new Error('Resolved successor differs from selected head');
  return resolvedHandle(await resolveStep(previous, advance, reader, budget));
}
export interface PreparedAdmissionPolicyV3 {
  body: AdmissionPolicyBodyV3; pages: Array<{ digest: string; bytes: Uint8Array }>;
  previousHead: AdmissionPolicyHead; previousArchive: AdmissionPolicyArchiveDescriptor | null;
}
/** Stages only missing predecessor keys, preserving the exact signed root prefix. No publication. */
export async function prepareAdmissionPolicyV3Successor(options: Operation & {
  previous: ResolvedAdmissionPolicy; next: Omit<AdmissionPolicyBodyV3, 'version' | 'kind' | 'archive'>; reader: AdmissionPolicyArchiveReader;
}): Promise<PreparedAdmissionPolicyV3> {
  const budget = new Budget(options), previous = resolvedState(options.previous), next = budget.snapshot(options.next), reader = options.reader;
  if (!exactWitnessFields(next, ['revision','issuedAt','expiresAt','activeKey','keys'])) throw new Error('Invalid v3 successor fields');
  const contextId = admissionPolicyObserversId(previous.context), initial = emptyAdmissionPolicyArchive(contextId);
  const body = await budget.wait(() => parseAdmissionPolicyBodyV3({ ...next, version: 3, kind: 'admission-policy', archive: initial }));
  const old = previous.policy, removed = removedCurrent(old, body), prefix = old.version === 3 ? old.archive : initial;
  if (old.version === 1) throw new Error('V3 migration requires a resolved v2 predecessor');
  const additions = old.version === 3 ? removed : [...previous.legacyArchive!, ...removed];
  const staged = stagePages(prefix, additions, budget); body.archive = staged.descriptor;
  const combined: AdmissionPolicyArchiveReader = async (digest, signal) => {
    const page = staged.pages.find(p => p.digest === digest); return page ? page.bytes : reader(digest, signal);
  };
  await validateV3Successor(previous, body, combined, budget);
  return { body: structuredClone(body), pages: staged.pages, previousHead: structuredClone(previous.head), previousArchive: old.version === 3 ? structuredClone(old.archive) : null };
}
/** Creates a signed commitment only after resolving the signed v3 successor and its archive. */
export async function createResolvedAdmissionPolicyAdvance(options: Operation & {
  previous: ResolvedAdmissionPolicy; policy: unknown; key: SigningKeyPair; reader: AdmissionPolicyArchiveReader;
}): Promise<{ advance: ArchivedAdmissionPolicyAdvance; resolved: ResolvedAdmissionPolicy }> {
  const budget = new Budget(options), previous = resolvedState(options.previous), input = budget.snapshot(options.policy), reader = options.reader,
    key = copyAdmissionSigningKey(options.key);
  try {
    budget.charge('maxTransitions', 1);
    const policy = await budget.wait(() => verifyAdmissionPolicyV3(input, previous.context.authority));
    await validateV3Successor(previous, policy, reader, budget);
    const commitment = createAdmissionPolicyAdvanceCommitment(previous.head, { revision: policy.revision, digest: admissionPolicyV3Digest(policy) }, previous.context, key);
    const advance = { commitment, policy };
    return { advance, resolved: resolvedHandle({ context: previous.context, head: commitment.next, policy }) };
  } finally { key.secretKey.fill(0); }
}
export async function lookupResolvedAdmissionPolicyKey(options: Operation & {
  policy: ResolvedAdmissionPolicy; issuerKey: string; reader: AdmissionPolicyArchiveReader;
}): Promise<{ entry: AdmissionPolicyKey; archived: boolean } | undefined> {
  const budget = new Budget(options), state = resolvedState(options.policy), issuerKey = options.issuerKey, reader = options.reader;
  if (!hashId(issuerKey)) throw new Error('Invalid issuer key');
  let found = state.policy.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === issuerKey), archived = false;
  if (state.policy.version === 3) {
    await walkPages(state.policy.archive, reader, budget, entries => {
      for (const entry of entries) if (admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey) { found = entry; archived = true; }
    });
  } else {
    const entry = state.legacyArchive!.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === issuerKey);
    if (entry) { found = entry; archived = true; }
  }
  return found ? { entry: structuredClone(found), archived } : undefined;
}
/** Callbacks run only after one complete validation pass. Stage their effects until this operation succeeds. */
export async function visitResolvedAdmissionPolicyArchive(options: Operation & {
  policy: ResolvedAdmissionPolicy; reader: AdmissionPolicyArchiveReader;
  visit: (entry: AdmissionPolicyKey, offset: number) => void | Promise<void>;
}): Promise<void> {
  const budget = new Budget(options), state = resolvedState(options.policy), reader = options.reader, visit = options.visit;
  if (state.policy.version === 3) {
    await walkPages(state.policy.archive, reader, budget, () => {});
    await walkPages(state.policy.archive, reader, budget, async (entries, offset) => {
      for (let i = 0; i < entries.length; i++) await budget.wait(async () => { await visit(structuredClone(entries[i]), offset + i); });
    });
  } else {
    for (let i = 0; i < state.legacyArchive!.length; i++) {
      budget.charge('maxEntries', 1); await budget.wait(async () => { await visit(structuredClone(state.legacyArchive![i]), i); });
    }
  }
}
