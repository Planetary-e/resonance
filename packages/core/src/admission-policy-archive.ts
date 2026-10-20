/** Isolated historical archive prerequisite. A verified handle is not traffic authorization.
 * Existing v1/v2 policy limits still apply; pages do not retire original history. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { MAX_ADMISSION_POLICY_BYTES } from './admission-policy-limits.js';
import { admissionAuthorityFingerprint, admissionPolicyDigest, admissionKeyFingerprint, admissionPolicyKeys, MAX_ADMISSION_KEYS, assertAdmissionPolicySuccessor, parseAdmissionPolicyBody, verifyAdmissionPolicy, type AdmissionPolicyBody, type AdmissionPolicyKey, type SignedAdmissionPolicy } from './admission-policy.js';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES, admissionPolicyHead, createAdmissionPolicyAdvanceCommitment, parseAdmissionPolicyAdvance, parseAdmissionPolicyAdvanceCommitment, sameAdmissionPolicyHead, type AdmissionPolicyAdvanceCommitment } from './admission-policy-advance.js';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers, type AdmissionPolicyHead, type AdmissionPolicyObservers } from './admission-policy-freshness.js';
import { parseAdmissionWalletProfile, createAdmissionProfileKeyImports, type AdmissionProfileKeyImports } from './admission-profile.js';
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
export type AdmissionPolicyArchiveExecution = { version: 1; purpose: 'reference-bounded' }
  | { version: 2; purpose: 'offline-startup-reconstruction'; timeoutMs: number };
function parseExecution(value: AdmissionPolicyArchiveExecution | undefined): AdmissionPolicyArchiveExecution {
  if (value === undefined) return Object.freeze({ version: 1, purpose: 'reference-bounded' });
  if (exactWitnessFields(value, ['version','purpose']) && value.version === 1 && value.purpose === 'reference-bounded') return Object.freeze({ version: 1, purpose: 'reference-bounded' });
  if (exactWitnessFields(value, ['version','purpose','timeoutMs']) && value.version === 2 && value.purpose === 'offline-startup-reconstruction'
    && integer(value.timeoutMs) && value.timeoutMs >= 1 && value.timeoutMs <= 30000) return Object.freeze({ version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: value.timeoutMs });
  throw new Error('Invalid archive execution contract');
}
interface ExecutionOptions { execution?: AdmissionPolicyArchiveExecution; signal?: AbortSignal; deadline?: number }
interface Operation extends ExecutionOptions { limits: AdmissionPolicyArchiveLimits; budget?: AdmissionPolicyArchiveBudget }
/** One absolute execution deadline, independent of the immutable proof resource envelope. */
export class AdmissionPolicyArchiveExecutionContext {
  readonly execution: AdmissionPolicyArchiveExecution;
  readonly controller = new AbortController();
  private deadline: number;
  private readonly signals = new Set<AbortSignal>();
  constructor(options: ExecutionOptions & { timeoutMs: number }) {
    if (!integer(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error('Invalid archive execution timeout');
    this.execution = parseExecution(options.execution);
    this.deadline = performance.now() + (this.execution.version === 2 ? this.execution.timeoutMs : options.timeoutMs);
    this.addSignal(options.signal); this.restrictDeadline(options.deadline); this.check();
  }
  get executionDeadline() { return this.deadline; }
  addSignal(signal?: AbortSignal) { if (signal) this.signals.add(signal); }
  /** Inherit a caller's original monotonic deadline without resetting counters or extending time. */
  restrictDeadline(deadline?: number) {
    if (deadline !== undefined) {
      if (!Number.isFinite(deadline)) throw new Error('Invalid archive deadline');
      this.deadline = Math.min(this.deadline, deadline);
    }
  }
  check() {
    if (this.controller.signal.aborted || [...this.signals].some(signal => signal.aborted) || performance.now() >= this.deadline) {
      this.controller.abort(); throw new Error('Archive operation cancelled or timed out');
    }
  }
  async wait<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const refusal = new Promise<never>((_, reject) => {
        abort = () => { this.controller.abort(); reject(new Error('Archive operation cancelled or timed out')); };
        for (const signal of this.signals) signal.addEventListener('abort', abort, { once: true });
        this.controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, Math.max(1, this.deadline - performance.now()));
      });
      const result = await Promise.race([work(), refusal]); this.check(); return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) {
        for (const signal of this.signals) signal.removeEventListener('abort', abort);
        this.controller.signal.removeEventListener('abort', abort);
      }
    }
  }
}
export class AdmissionPolicyArchiveBudget extends AdmissionPolicyArchiveExecutionContext {
  readonly limits: AdmissionPolicyArchiveLimits;
  readonly keyImports = createAdmissionProfileKeyImports();
  private counts = { maxPages: 0, maxEntries: 0, maxArchiveBytes: 0, maxHistoryBytes: 0, maxTransitions: 0, maxPageReads: 0 };
  constructor(operation: Operation) {
    const value = structuredClone(operation.limits);
    if (!exactWitnessFields(value, ['maxPages','maxEntries','maxArchiveBytes','maxHistoryBytes','maxTransitions','maxPageReads','timeoutMs'])
      || Object.values(value).some(n => !integer(n)) || value.timeoutMs < 1 || value.timeoutMs > 2_147_483_647) throw new Error('Invalid archive limits');
    super({ ...operation, timeoutMs: value.timeoutMs });
    this.limits = Object.freeze(value);
  }
  charge(name: keyof AdmissionPolicyArchiveBudget['counts'], amount: number) {
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
}
function operationBudget(options: Operation): AdmissionPolicyArchiveBudget {
  if (!options.budget) return new AdmissionPolicyArchiveBudget(options);
  if (JSON.stringify(options.budget.execution) !== JSON.stringify(parseExecution(options.execution))) throw new Error('Archive operation execution purpose differs');
  if (JSON.stringify(options.budget.limits) !== JSON.stringify(options.limits)) throw new Error('Archive operation resource envelope differs');
  options.budget.addSignal(options.signal); options.budget.restrictDeadline(options.deadline); options.budget.check(); return options.budget;
}
/** Bounded references are authorization-neutral until their retained original proof resolves. */
export interface AdmissionPolicyProofReference {
  version: 1; context: AdmissionPolicyObservers; genesis: AdmissionPolicyHead; head: AdmissionPolicyHead;
  reference: string; limits: AdmissionPolicyArchiveLimits;
}
export interface AdmissionPolicyProofPage { digest: string; data: string }
export type AdmissionPolicyProofAppend = { version: 1; kind: 'genesis'; policy: SignedAdmissionPolicy }
  | { version: 1; kind: 'advance'; advance: ArchivedAdmissionPolicyAdvance; pages: AdmissionPolicyProofPage[] };
export function admissionPolicyProofReference(contextValue: AdmissionPolicyObservers, headValue: AdmissionPolicyHead,
  limits: AdmissionPolicyArchiveLimits): AdmissionPolicyProofReference {
  const context = parseAdmissionPolicyObservers(structuredClone(contextValue)), head = parseAdmissionPolicyHead(structuredClone(headValue));
  const bounded = new AdmissionPolicyArchiveBudget({ limits }).limits;
  if (head.revision < context.genesis.revision || head.revision === context.genesis.revision && !sameAdmissionPolicyHead(head, context.genesis)) throw new Error('Proof head precedes original genesis');
  const body = { version: 1 as const, context, genesis: context.genesis, head, limits: bounded };
  return { ...body, reference: `sha256:${createHash('sha256').update('resonance:admission-policy-proof:v1\n').update(JSON.stringify(body)).digest('hex')}` };
}
export function parseAdmissionPolicyProofReference(value: unknown): AdmissionPolicyProofReference {
  if (!exactWitnessFields(value, ['version','context','genesis','head','reference','limits']) || value.version !== 1) throw new Error('Invalid policy proof reference');
  const parsed = admissionPolicyProofReference(value.context as AdmissionPolicyObservers, value.head as AdmissionPolicyHead, value.limits as AdmissionPolicyArchiveLimits);
  if (!sameAdmissionPolicyHead(parseAdmissionPolicyHead(value.genesis), parsed.genesis) || parsed.reference !== value.reference) throw new Error('Policy proof reference differs from original pins and limits');
  return parsed;
}
/** Structural boundary only. The streaming resolver authenticates every append before installation. */
export function parseAdmissionPolicyProofAppend(value: unknown): AdmissionPolicyProofAppend {
  if (exactWitnessFields(value, ['version','kind','policy']) && value.version === 1 && value.kind === 'genesis'
    && (value.policy as { version?: unknown })?.version !== 3 && Buffer.byteLength(JSON.stringify(value)) <= MAX_ADMISSION_POLICY_BYTES + 128) return structuredClone(value) as unknown as AdmissionPolicyProofAppend;
  if (!exactWitnessFields(value, ['version','kind','advance','pages']) || value.version !== 1 || value.kind !== 'advance'
    || !Array.isArray(value.pages) || value.pages.length > 2 || Buffer.byteLength(JSON.stringify(value.advance)) > ADMISSION_POLICY_ADVANCE_MAX_BYTES) throw new Error('Invalid bounded policy proof append');
  const pages = value.pages.map(page => {
    if (!exactWitnessFields(page, ['digest','data']) || !hashId(page.digest) || typeof page.data !== 'string'
      || page.data.length > Math.ceil(ADMISSION_POLICY_ARCHIVE_PAGE_MAX_BYTES * 4 / 3)) throw new Error('Invalid retained policy proof page');
    const bytes = Buffer.from(page.data, 'base64url');
    if (bytes.toString('base64url') !== page.data || admissionPolicyArchivePageDigest(bytes) !== page.digest) throw new Error('Policy proof page digest differs');
    return { digest: page.digest, data: page.data };
  });
  if (new Set(pages.map(page => page.digest)).size !== pages.length) throw new Error('Duplicate policy proof pages');
  return { version: 1, kind: 'advance', advance: structuredClone(value.advance) as ArchivedAdmissionPolicyAdvance, pages };
}
export async function verifyArchivedAdmissionPolicy(value: unknown, authority: string, imports?: AdmissionProfileKeyImports): Promise<ArchivedAdmissionPolicy> {
  return (value as { version?: unknown })?.version === 3 ? verifyAdmissionPolicyV3(value, authority, imports) : verifyAdmissionPolicy(value, authority, imports);
}
export function assertArchivedAdmissionPolicyCurrent(policy: ArchivedAdmissionPolicy, now: number): void {
  if (!integer(now) || now < policy.issuedAt || now >= policy.expiresAt) throw new Error('Community admission policy is not current; import a current signed revision');
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
function checkDescriptorBounds(value: AdmissionPolicyArchiveDescriptor, budget: AdmissionPolicyArchiveBudget) {
  budget.check();
  if (value.pageCount > budget.limits.maxPages || value.entryCount > budget.limits.maxEntries || value.archiveBytes > budget.limits.maxArchiveBytes) throw new Error('Archive descriptor exceeds limits');
}
async function scan(value: AdmissionPolicyArchiveDescriptor, expected: AdmissionPolicyKey[], reader: AdmissionPolicyArchiveReader, budget: AdmissionPolicyArchiveBudget) {
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
  const budget = operationBudget(options), context = parseAdmissionPolicyObservers(structuredClone(options.context)),
    selectedHead = parseAdmissionPolicyHead(structuredClone(options.selectedHead)), archive = descriptor(structuredClone(options.descriptor)), reader = options.reader;
  if (archive.contextId !== admissionPolicyObserversId(context)) throw new Error('Archive observer context differs');
  if (!Array.isArray(options.advances) || options.advances.length > budget.limits.maxTransitions) throw new Error('Archive transition limit exhausted');
  // Serialize and copy every caller-owned history value before the first await.
  const genesis = budget.snapshot(options.genesis), advances = options.advances.map(value => budget.snapshot(value));
  let policy = await budget.wait(() => verifyAdmissionPolicy(genesis, context.authority, budget.keyImports)), head = admissionPolicyHead(policy);
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
  const budget = operationBudget(options), retained = requireHandle(options.handle), reader = options.reader,
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
function stagePages(prefix: AdmissionPolicyArchiveDescriptor, additions: AdmissionPolicyKey[], budget: AdmissionPolicyArchiveBudget) {
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
  const budget = operationBudget(options), retained = requireHandle(options.handle), issuerKey = options.issuerKey, reader = options.reader;
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
export async function parseAdmissionPolicyBodyV3(value: unknown, imports?: AdmissionProfileKeyImports): Promise<AdmissionPolicyBodyV3> {
  if (!exactWitnessFields(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','archive'])
    || value.version !== 3 || Buffer.byteLength(JSON.stringify(value)) > MAX_ADMISSION_POLICY_BYTES) throw new Error('Invalid v3 admission policy');
  const input = structuredClone(value), archive = descriptor(input.archive);
  const { archive: _, ...fields } = input;
  const normalized = await parseAdmissionPolicyBody({ ...fields, version: 2, archivedKeys: [] }, imports);
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
export async function verifyAdmissionPolicyV3(value: unknown, authority: string, imports?: AdmissionProfileKeyImports): Promise<SignedAdmissionPolicyV3> {
  admissionAuthorityFingerprint(authority);
  if (!exactWitnessFields(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','archive','authority','signature'])
    || value.authority !== authority || !witnessBytes(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_ADMISSION_POLICY_BYTES) throw new Error('Invalid signed v3 admission policy');
  const input = structuredClone(value), { authority: _, signature, ...unsigned } = input;
  const body = await parseAdmissionPolicyBodyV3(unsigned, imports);
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
  /** Optional wallet catalogue, bounded independently of archive lifetime. */
  retainedKeys?: AdmissionPolicyKey[]; retainedOnlyIssuerKeys?: readonly string[];
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
async function walkPages(archive: AdmissionPolicyArchiveDescriptor, reader: AdmissionPolicyArchiveReader, budget: AdmissionPolicyArchiveBudget,
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
/** Exists only during one full original-chain replay, never in a resolved handle.
 * Identities come from exact validated page contents, bounded by charged entries/bytes. */
interface ReplayArchivePrefix {
  archive?: AdmissionPolicyArchiveDescriptor;
  issuers: Set<string>; epochs: Set<string>;
}
async function validateV3Successor(previous: ResolvedState, next: SignedAdmissionPolicyV3 | AdmissionPolicyBodyV3,
  reader: AdmissionPolicyArchiveReader, budget: AdmissionPolicyArchiveBudget, replay?: ReplayArchivePrefix) {
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
    if (replay) {
      if (JSON.stringify(replay.archive) !== JSON.stringify(old.archive)) throw new Error('Replay archive prefix differs from validated predecessor');
      for (const entry of next.keys) {
        budget.check();
        if (replay.issuers.has(admissionKeyFingerprint(entry.profile.issuerPublicKey))) throw new Error('V3 cannot reuse an archived issuer or period');
      }
      for (const entry of fresh) {
        budget.check();
        if (replay.epochs.has(entry.profile.scope.epoch)) throw new Error('V3 cannot reuse an archived issuer or period');
      }
    } else await walkPages(old.archive, reader, budget, comparePrior);
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
async function parseArchivedAdvance(value: unknown, context: AdmissionPolicyObservers, budget: AdmissionPolicyArchiveBudget): Promise<ArchivedAdmissionPolicyAdvance> {
  if (!exactWitnessFields(value, ['commitment','policy']) || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_ADVANCE_MAX_BYTES) throw new Error('Invalid archive policy advance');
  const commitment = parseAdmissionPolicyAdvanceCommitment(value.commitment, context);
  const policy = await budget.wait<ArchivedAdmissionPolicy>(() => (value.policy as { version?: unknown })?.version === 3
    ? verifyAdmissionPolicyV3(value.policy, context.authority, budget.keyImports) : verifyAdmissionPolicy(value.policy, context.authority, budget.keyImports));
  if (policy.revision !== commitment.next.revision || archivedAdmissionPolicyDigest(policy) !== commitment.next.digest) throw new Error('Policy differs from signed advance digest');
  return { commitment, policy };
}
/** Signature/schema authentication only; installation requires resolveAdmissionPolicySuccessor. */
export async function parseArchivedAdmissionPolicyAdvance(value: unknown, contextValue: AdmissionPolicyObservers, options: ExecutionOptions & { timeoutMs?: number; budget?: AdmissionPolicyArchiveBudget } = {}): Promise<ArchivedAdmissionPolicyAdvance> {
  const context = parseAdmissionPolicyObservers(contextValue);
  const budget = options.budget ?? new AdmissionPolicyArchiveBudget({ signal: options.signal, execution: options.execution, deadline: options.deadline, limits: { maxPages: 1, maxEntries: 1, maxArchiveBytes: 1, maxHistoryBytes: 1, maxTransitions: 1, maxPageReads: 1, timeoutMs: options.timeoutMs ?? 3000 } });
  if (JSON.stringify(budget.execution) !== JSON.stringify(parseExecution(options.execution))) throw new Error('Archive operation execution purpose differs');
  budget.addSignal(options.signal); budget.restrictDeadline(options.deadline);
  if (options.timeoutMs !== undefined) budget.restrictDeadline(performance.now() + options.timeoutMs);
  budget.check(); return parseArchivedAdvance(value, context, budget);
}
async function resolveStep(previous: ResolvedState, advance: ArchivedAdmissionPolicyAdvance, reader: AdmissionPolicyArchiveReader, budget: AdmissionPolicyArchiveBudget, replay?: ReplayArchivePrefix): Promise<ResolvedState> {
  if (!sameAdmissionPolicyHead(previous.head, advance.commitment.previous)) throw new Error('Resolved policy ancestry has a gap or fork');
  if (advance.policy.version === 3) {
    await validateV3Successor(previous, advance.policy, reader, budget, replay);
    if (replay) {
      // Publish only after the complete successor (including its exact suffix) succeeds.
      const additions = removedCurrent(previous.policy, advance.policy);
      const authenticated = previous.policy.version === 3 ? additions : [...previous.legacyArchive!, ...additions];
      for (const entry of authenticated) {
        budget.check();
        replay.issuers.add(admissionKeyFingerprint(entry.profile.issuerPublicKey)); replay.epochs.add(entry.profile.scope.epoch);
      }
      replay.archive = advance.policy.archive;
    }
    return { context: previous.context, head: advance.commitment.next, policy: advance.policy };
  }
  if (previous.policy.version === 3) throw new Error('Cannot downgrade resolved v3 policy');
  successor(previous.policy, advance.policy);
  return { context: previous.context, head: advance.commitment.next, policy: advance.policy,
    legacyArchive: extendArchive(previous.legacyArchive!, advance.policy) };
}
export interface ResolveAdmissionPolicyOptions extends Operation {
  context: AdmissionPolicyObservers; genesis: unknown; advances: readonly unknown[] | AsyncIterable<unknown>; selectedHead: AdmissionPolicyHead; reader: AdmissionPolicyArchiveReader;
  readGenesis?: (signal: AbortSignal) => Promise<unknown>;
  retainIssuerKeys?: readonly string[];
  /** Protected roles retain only referenced membership; wallet catalogue semantics remain unchanged. */
  retainOnlyRequestedIssuerKeys?: boolean;
}
/** Full original provenance; v3 cannot be a fresh genesis or bypass the signed transition chain. */
export async function resolveAdmissionPolicy(options: ResolveAdmissionPolicyOptions): Promise<ResolvedAdmissionPolicy> {
  const budget = operationBudget(options), context = parseAdmissionPolicyObservers(structuredClone(options.context)), reader = options.reader,
    selected = parseAdmissionPolicyHead(structuredClone(options.selectedHead));
  // Arrays retain the existing up-front snapshot guarantee. Streaming callers
  // retain one item at a time; their next()/return() share this same deadline.
  const source = options.advances;
  if (Array.isArray(source) && source.length > budget.limits.maxTransitions) throw new Error('Resolved policy transition limit exhausted');
  if (!Array.isArray(source) && (!source || typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function')) throw new Error('Invalid resolved policy history');
  const inputs = Array.isArray(source) ? source.map(v => budget.snapshot(v)) : undefined;
  const requested = options.retainIssuerKeys === undefined ? undefined : [...options.retainIssuerKeys];
  if (requested && (requested.length > 72 || requested.some(value => !hashId(value)))) throw new Error('Invalid bounded resolved issuer catalogue');
  const retained = requested ? new Map<string, AdmissionPolicyKey>() : undefined;
  function collect(policy: ArchivedAdmissionPolicy) {
    if (!retained) return;
    for (const entry of policy.keys) { const fingerprint = admissionKeyFingerprint(entry.profile.issuerPublicKey); if (!options.retainOnlyRequestedIssuerKeys || requested!.includes(fingerprint)) retained.set(fingerprint, entry); }
    if (policy.version !== 3) for (const entry of policy.archivedKeys ?? []) {
      const fingerprint = admissionKeyFingerprint(entry.profile.issuerPublicKey);
      if (requested!.includes(fingerprint)) retained.set(fingerprint, entry);
    }
    if (retained.size > 72) throw new Error('Resolved wallet profile history is full');
  }
  const genesis = budget.snapshot(options.readGenesis ? await budget.wait(() => options.readGenesis!(budget.controller.signal)) : options.genesis);
  const policy = await budget.wait(() => verifyAdmissionPolicy(genesis, context.authority, budget.keyImports)), head = admissionPolicyHead(policy);
  if (!sameAdmissionPolicyHead(head, context.genesis)) throw new Error('Resolved policy requires original signed genesis');
  let state: ResolvedState = { context, head, policy, legacyArchive: extendArchive([], policy) };
  collect(policy);
  const replay: ReplayArchivePrefix = { issuers: new Set(), epochs: new Set() };
  if (inputs) {
    for (const input of inputs) {
      budget.charge('maxTransitions', 1);
      state = await resolveStep(state, await parseArchivedAdvance(input, context, budget), reader, budget, replay);
      collect(state.policy);
    }
  } else {
    const iterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        const item = await budget.wait(() => iterator.next());
        if (item.done) { finished = true; break; }
        budget.charge('maxTransitions', 1);
        const input = budget.snapshot(item.value);
        state = await resolveStep(state, await parseArchivedAdvance(input, context, budget), reader, budget, replay);
        collect(state.policy);
      }
    } finally {
      if (!finished && iterator.return) {
        // Invoke cleanup even after cancellation, but never let an uncooperative
        // iterator retain the wallet operation beyond its absolute deadline.
        const cleanup = Promise.resolve().then(() => iterator.return!());
        cleanup.catch(() => {});
        await budget.wait(() => cleanup);
      }
    }
  }
  if (!sameAdmissionPolicyHead(state.head, selected)) throw new Error('Resolved policy selected head is stale or conflicting');
  // The call-local prefix authenticates ancestry, not continued reader availability.
  // Charge a complete final reread before publishing any resolved capability.
  if (state.policy.version === 3) await walkPages(state.policy.archive, reader, budget, () => {});
  if (retained) { state.retainedKeys = [...retained.values()]; if (options.retainOnlyRequestedIssuerKeys) state.retainedOnlyIssuerKeys = requested; }
  budget.check(); return resolvedHandle(state);
}
export async function resolveAdmissionPolicyAdvance(options: Operation & {
  previous: ResolvedAdmissionPolicy; advance: unknown; selectedHead: AdmissionPolicyHead; reader: AdmissionPolicyArchiveReader;
}): Promise<ResolvedAdmissionPolicy> {
  const budget = operationBudget(options), previous = resolvedState(options.previous), input = budget.snapshot(options.advance),
    selected = parseAdmissionPolicyHead(structuredClone(options.selectedHead)), reader = options.reader;
  budget.charge('maxTransitions', 1);
  const advance = await parseArchivedAdvance(input, previous.context, budget);
  if (!sameAdmissionPolicyHead(advance.commitment.next, selected)) throw new Error('Resolved successor differs from selected head');
  const state = await resolveStep(previous, advance, reader, budget);
  if (previous.retainedKeys) {
    const retained = new Map(previous.retainedKeys.map(entry => [admissionKeyFingerprint(entry.profile.issuerPublicKey), entry]));
    for (const entry of state.policy.keys) { const fingerprint = admissionKeyFingerprint(entry.profile.issuerPublicKey); if (!previous.retainedOnlyIssuerKeys || previous.retainedOnlyIssuerKeys.includes(fingerprint)) retained.set(fingerprint, entry); }
    if (retained.size > 72) throw new Error('Resolved wallet profile history is full');
    state.retainedKeys = [...retained.values()]; state.retainedOnlyIssuerKeys = previous.retainedOnlyIssuerKeys;
  }
  return resolvedHandle(state);
}
export interface PreparedAdmissionPolicyV3 {
  body: AdmissionPolicyBodyV3; pages: Array<{ digest: string; bytes: Uint8Array }>;
  previousHead: AdmissionPolicyHead; previousArchive: AdmissionPolicyArchiveDescriptor | null;
}
/** Stages only missing predecessor keys, preserving the exact signed root prefix. No publication. */
export async function prepareAdmissionPolicyV3Successor(options: Operation & {
  previous: ResolvedAdmissionPolicy; next: Omit<AdmissionPolicyBodyV3, 'version' | 'kind' | 'archive'>; reader: AdmissionPolicyArchiveReader;
}): Promise<PreparedAdmissionPolicyV3> {
  const budget = operationBudget(options), previous = resolvedState(options.previous), next = budget.snapshot(options.next), reader = options.reader;
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
  const budget = operationBudget(options), previous = resolvedState(options.previous), input = budget.snapshot(options.policy), reader = options.reader,
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
  const budget = operationBudget(options), state = resolvedState(options.policy), issuerKey = options.issuerKey, reader = options.reader;
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
  const budget = operationBudget(options), state = resolvedState(options.policy), reader = options.reader, visit = options.visit;
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

/** Opaque membership for a bounded retained wallet catalogue. Arbitrary entries
 * supplied next to a resolved policy cannot manufacture retirement authority. */
declare const resolvedKeyBrand: unique symbol;
export interface ResolvedAdmissionPolicyKey { readonly [resolvedKeyBrand]: true }
const resolvedKeys = new WeakMap<ResolvedAdmissionPolicyKey, { policy: ResolvedAdmissionPolicy; entry: AdmissionPolicyKey }>();
export function retainedResolvedAdmissionPolicyKey(policy: ResolvedAdmissionPolicy, issuerKey: string): ResolvedAdmissionPolicyKey {
  const state = resolvedState(policy);
  const entry = [...state.policy.keys, ...(state.retainedKeys ?? [])].find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
  if (!entry) throw new Error('Issuer is absent from the bounded resolved wallet catalogue');
  const handle = Object.freeze({}) as ResolvedAdmissionPolicyKey;
  resolvedKeys.set(handle, { policy, entry: structuredClone(entry) }); return handle;
}
export function inspectResolvedAdmissionPolicyKey(policy: ResolvedAdmissionPolicy, membership: ResolvedAdmissionPolicyKey): AdmissionPolicyKey {
  resolvedState(policy);
  const value = resolvedKeys.get(membership);
  if (!value || value.policy !== policy) throw new Error('Issuer requires its original resolved membership capability');
  return structuredClone(value.entry);
}

export async function resolveAdmissionPolicyKey(options: Operation & {
  policy: ResolvedAdmissionPolicy; issuerKey: string; reader: AdmissionPolicyArchiveReader;
}): Promise<ResolvedAdmissionPolicyKey | undefined> {
  const found = await lookupResolvedAdmissionPolicyKey(options);
  if (!found) return undefined;
  const handle = Object.freeze({}) as ResolvedAdmissionPolicyKey;
  resolvedKeys.set(handle, { policy: options.policy, entry: found.entry }); return handle;
}

/** Resolve caller-funded local enrollment membership in one shared operation.
 * No caller receives a membership until the complete archive has validated. */
export async function resolveAdmissionPolicyCatalogueMembership(options: Operation & {
  policy: ResolvedAdmissionPolicy; issuerKeys: readonly string[]; reader: AdmissionPolicyArchiveReader;
}): Promise<Map<string, ResolvedAdmissionPolicyKey>> {
  const policy = options.policy, budget = operationBudget(options), state = resolvedState(policy);
  if (options.issuerKeys.length > budget.limits.maxEntries + MAX_ADMISSION_KEYS || options.issuerKeys.some(key => !hashId(key))) throw new Error('Invalid funded enrollment membership request');
  const requested = new Set(options.issuerKeys), staged = new Map<string, AdmissionPolicyKey>();
  function collect(entry: AdmissionPolicyKey) {
    const fingerprint = admissionKeyFingerprint(entry.profile.issuerPublicKey);
    if (requested.has(fingerprint)) staged.set(fingerprint, structuredClone(entry));
  }
  for (const entry of state.policy.keys) collect(entry);
  await visitResolvedAdmissionPolicyArchive({ ...options, policy, budget, visit: collect });
  budget.check();
  const result = new Map<string, ResolvedAdmissionPolicyKey>();
  for (const [fingerprint, entry] of staged) {
    const membership = Object.freeze({}) as ResolvedAdmissionPolicyKey;
    resolvedKeys.set(membership, { policy, entry }); result.set(fingerprint, membership);
  }
  return result;
}

/** Authenticated membership for only the keys/participants referenced by one bounded business image. */
declare const historyMembershipBrand: unique symbol;
export interface AdmissionPolicyHistoryMembership { readonly [historyMembershipBrand]: true }
const historyMemberships = new WeakMap<AdmissionPolicyHistoryMembership, { digest: string; entries: Map<string, AdmissionPolicyKey>; participants: Set<string> }>();
export async function resolveAdmissionPolicyHistoryMembership(options: Operation & {
  policy: ResolvedAdmissionPolicy; reader: AdmissionPolicyArchiveReader; issuerKeys: readonly string[];
  participants?: readonly { role: 'witness' | 'coordinator'; publicKey: string }[];
}): Promise<AdmissionPolicyHistoryMembership> {
  const budget = operationBudget(options);
  if (options.issuerKeys.length > 10000 || options.issuerKeys.some(value => !hashId(value)) || (options.participants?.length ?? 0) > 2) throw new Error('Historical membership request exceeds bounded state');
  const requested = new Set(options.issuerKeys), participants = structuredClone(options.participants ?? []);
  const entries = new Map<string, AdmissionPolicyKey>(), present = new Set<string>(), state = resolvedState(options.policy);
  const collect = (entry: AdmissionPolicyKey) => {
    const id = admissionKeyFingerprint(entry.profile.issuerPublicKey);
    if (requested.has(id)) entries.set(id, structuredClone(entry));
    for (const participant of participants) if (participant.role === 'witness'
      ? entry.witnesses?.members.some(member => member.publicKey === participant.publicKey)
      : entry.witnesses?.coordinators.includes(participant.publicKey)) present.add(`${participant.role}:${participant.publicKey}`);
  };
  for (const entry of state.policy.keys) collect(entry);
  if (entries.size < requested.size || present.size < new Set(participants.map(participant => `${participant.role}:${participant.publicKey}`)).size) {
    // Collect into private staged maps. Publish the opaque membership only after the complete walk succeeds.
    if (state.policy.version === 3) await walkPages(state.policy.archive, options.reader, budget, values => { for (const entry of values) collect(entry); });
    else for (const entry of state.legacyArchive ?? []) { budget.charge('maxEntries', 1); collect(entry); }
    budget.check();
  }
  budget.check();
  const handle = Object.freeze({}) as AdmissionPolicyHistoryMembership;
  historyMemberships.set(handle, { digest: archivedAdmissionPolicyDigest(state.policy), entries, participants: present }); return handle;
}
export function admissionPolicyHistoryEntry(policy: ArchivedAdmissionPolicy, membership: AdmissionPolicyHistoryMembership | undefined, issuerKey: string): AdmissionPolicyKey | undefined {
  if (policy.version !== 3) return admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
  const known = membership && historyMemberships.get(membership);
  if (!known || known.digest !== archivedAdmissionPolicyDigest(policy)) throw new Error('Historical policy requires its original authenticated membership capability');
  return structuredClone(known.entries.get(issuerKey) ?? policy.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey));
}
export function admissionPolicyHistoryParticipant(policy: ArchivedAdmissionPolicy, membership: AdmissionPolicyHistoryMembership | undefined, role: 'witness' | 'coordinator', publicKey: string): boolean {
  if (policy.version !== 3) return admissionPolicyKeys(policy).some(entry => role === 'witness'
    ? entry.witnesses?.members.some(member => member.publicKey === publicKey) : entry.witnesses?.coordinators.includes(publicKey));
  const known = membership && historyMemberships.get(membership);
  if (!known || known.digest !== archivedAdmissionPolicyDigest(policy)) throw new Error('Historical participant requires authenticated original membership');
  return known.participants.has(`${role}:${publicKey}`);
}
