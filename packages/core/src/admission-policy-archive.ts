/** Isolated historical archive prerequisite. A verified handle is not traffic authorization.
 * Existing v1/v2 policy limits still apply; pages do not retire original history. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { admissionKeyFingerprint, admissionPolicyKeys, assertAdmissionPolicySuccessor, verifyAdmissionPolicy,
  type AdmissionPolicyKey, type SignedAdmissionPolicy } from './admission-policy.js';
import { admissionPolicyHead, parseAdmissionPolicyAdvance, sameAdmissionPolicyHead } from './admission-policy-advance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers,
  type AdmissionPolicyHead, type AdmissionPolicyObservers } from './admission-policy-freshness.js';
import { parseAdmissionWalletProfile } from './admission-profile.js';
import { exactWitnessFields, parseAdmissionWitnessSet } from './admission-witness.js';

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
  const archive = structuredClone(retained.descriptor), pages: StagedAdmissionPolicyArchive['pages'] = [];
  let entries: AdmissionPolicyKey[] = [];
  const page = (): AdmissionPolicyArchivePage => ({ version: 1, kind: 'admission-policy-archive-page', contextId: archive.contextId,
    previous: archive.root, index: archive.pageCount, firstEntry: archive.entryCount, entries });
  const flush = () => {
    budget.check(); const bytes = Uint8Array.from(Buffer.from(JSON.stringify(page()))), digest = admissionPolicyArchivePageDigest(bytes);
    budget.charge('maxPages', 1); budget.charge('maxEntries', entries.length); budget.charge('maxArchiveBytes', bytes.byteLength);
    pages.push({ digest, bytes }); archive.root = digest; archive.pageCount++; archive.entryCount += entries.length; archive.archiveBytes += bytes.byteLength; entries = [];
  };
  for (const entry of expected.slice(retained.expected.length)) {
    budget.check(); entries.push(entry);
    if (entries.length > 64 || Buffer.byteLength(JSON.stringify(page())) > ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES) {
      entries.pop(); if (!entries.length) throw new Error('Archive entry exceeds page ceiling'); flush(); entries.push(entry);
    }
  }
  if (entries.length) flush();
  checkDescriptorBounds(archive, budget); budget.check();
  return { descriptor: structuredClone(archive), pages,
    handle: retain({ context: retained.context, head: selectedHead, policy: advance.policy, descriptor: archive, expected }) };
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
