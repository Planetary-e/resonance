/** Funded immutable encrypted provenance. The profile snapshot alone activates it. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { withStorageReservationAuthority, type StorageReservationAuthority } from '@resonance/core/storage-reservations';
import { admissionPolicyArchivePageDigest, resolveAdmissionPolicy, AdmissionPolicyArchiveBudget, resolveAdmissionPolicyCatalogueMembership, inspectResolvedAdmissionPolicyKey,
  type AdmissionPolicyArchiveLimits, type ResolvedAdmissionPolicy, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES } from '@resonance/core/admission-policy-advance';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers, type AdmissionPolicyHead, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { admissionKeyFingerprint, type AdmissionPolicyKey, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';

export interface WalletPolicyProofStorage {
  authority: StorageReservationAuthority & { status(): { authorityId: string } };
  authorityId: string; directory: string; maxCiphertextBytes: number; maxRecords: number; limits: AdmissionPolicyArchiveLimits;
}
export interface WalletPolicyProofReference {
  version: 1; authorityId: string; contextId: string; count: number; tip: string; head: AdmissionPolicyHead;
  funding: { maxCiphertextBytes: number; maxRecords: number; limits: AdmissionPolicyArchiveLimits };
}
interface Manifest { version: 1; context: AdmissionPolicyObservers | null; progress: WalletPolicyProofReference | null }
interface RecordValue { version: 1; previous: string | null; kind: 'genesis' | 'advance'; value: unknown }
const MANIFEST_BYTES = 32 * 1024;
const hash = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function parseWalletPolicyProofReference(value: unknown): WalletPolicyProofReference {
  const ref = value as WalletPolicyProofReference;
  if (!ref || Object.keys(ref).sort().join(',') !== 'authorityId,contextId,count,funding,head,tip,version' || ref.version !== 1
    || !ref.funding || Object.keys(ref.funding).sort().join(',') !== 'limits,maxCiphertextBytes,maxRecords'
    || !Number.isSafeInteger(ref.funding.maxCiphertextBytes) || ref.funding.maxCiphertextBytes < 1 || !Number.isSafeInteger(ref.funding.maxRecords) || ref.funding.maxRecords < 1
    || !/^[a-f0-9]{32}$/.test(ref.authorityId) || !id(ref.contextId) || !id(ref.tip) || !Number.isSafeInteger(ref.count) || ref.count < 1) throw new Error('Invalid wallet policy proof reference');
  return structuredClone({ ...ref, head: parseAdmissionPolicyHead(ref.head) });
}
export function openWalletPolicyProofStore(raw: WalletPolicyProofStorage, encryptionKey: Uint8Array) {
  const options = { ...raw, directory: resolve(raw.directory), limits: structuredClone(raw.limits) };
  const authority = options.authority;
  if (authority.status().authorityId !== options.authorityId || !Number.isSafeInteger(options.maxCiphertextBytes)
    || options.maxCiphertextBytes < 2 * MANIFEST_BYTES + 8192 || !Number.isSafeInteger(options.maxRecords) || options.maxRecords < 3) throw new Error('Wallet proof storage requires its pinned authority and finite allowance');
  const lease = authority.reserve({ path: options.directory, scope: 'directory', component: 'wallet-policy-proofs', maximumBytes: options.maxCiphertextBytes });
  lease.assertWritable();
  const key = Buffer.from(encryptionKey);
  let closed = false, poisoned = false;
  function ready() {
    if (closed || poisoned) throw new Error('Wallet proof store is closed or its write failed; reopen before reuse');
    if (authority.status().authorityId !== options.authorityId) throw new Error('Wallet proof storage authority changed');
    lease.assertWritable();
  }
  // Includes interrupted/staged/unknown files and ownership controls. Never clean
  // orphan ciphertext to manufacture capacity. The traversal itself is bounded.
  function inventory(extraBytes = 0, extraRecords = 0) {
    ready(); let bytes = extraBytes + 2 * MANIFEST_BYTES + 8192, records = extraRecords + 3;
    function scan(directory: string, depth: number) {
      if (!existsSync(directory)) return;
      const handle = opendirSync(directory);
      try {
        for (;;) {
          const entry = handle.readSync(); if (!entry) break;
          const path = join(directory, entry.name), stat = lstatSync(path);
          if (stat.isSymbolicLink()) throw new Error('Wallet proof storage contains a symbolic link');
          if (stat.isDirectory()) {
            if (depth >= 2 || ++records > options.maxRecords) throw new Error('Wallet proof record capacity exhausted');
            scan(path, depth + 1);
          } else {
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('Wallet proof storage contains an aliased or invalid file');
            records++; bytes += stat.size;
          }
          if (records > options.maxRecords || bytes > options.maxCiphertextBytes) throw new Error('Wallet proof storage capacity exhausted');
        }
      } finally { handle.closeSync(); }
    }
    scan(options.directory, 0);
    if (records > options.maxRecords || bytes > options.maxCiphertextBytes) throw new Error('Wallet proof storage capacity exhausted');
    return { bytes, records };
  }
  inventory();
  const manifest = withStorageReservationAuthority(authority, () => openEncryptedLocalState<Manifest>({
    path: join(options.directory, 'progress.json'), key, domain: 'resonance:wallet-policy-proof-progress:v1', maxBytes: MANIFEST_BYTES,
    initial: { version: 1, context: null, progress: null }, validate(value): value is Manifest {
      try {
        const item = value as Manifest;
        if (!item || Object.keys(item).sort().join(',') !== 'context,progress,version' || item.version !== 1) return false;
        if (item.context !== null) parseAdmissionPolicyObservers(item.context);
        if (item.progress !== null) {
          const ref = parseWalletPolicyProofReference(item.progress);
          if (!item.context || ref.contextId !== admissionPolicyObserversId(item.context) || ref.authorityId !== options.authorityId) return false;
        }
        return true;
      } catch { return false; }
    },
  }));
  function seal(value: unknown, domain: string) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(domain));
    const plaintext = Buffer.from(JSON.stringify(value));
    try { return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]); }
    finally { plaintext.fill(0); }
  }
  function read(path: string, domain: string, maximumBytes = ADMISSION_POLICY_ADVANCE_MAX_BYTES + 8192) {
    ready(); inventory(); const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 29 || before.size > maximumBytes) throw new Error('Invalid wallet proof ciphertext');
    const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('Wallet proof file changed');
      bytes = Buffer.alloc(Math.min(before.size + 1, maximumBytes + 1)); let used = 0;
      while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
      bytes = bytes.subarray(0, used);
      const after = fstatSync(fd);
      if (bytes.length !== before.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Wallet proof file changed');
    } finally { closeSync(fd); }
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(domain)); decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    try { return { value: JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext)) as unknown, digest: hash(bytes) }; }
    finally { plaintext.fill(0); }
  }
  function publish(path: string, value: unknown, domain: string) {
    ready();
    const maximumBytes = domain.startsWith('resonance:wallet-policy-proof-page:') ? Math.ceil(512 * 1024 * 4 / 3) + 8192 : ADMISSION_POLICY_ADVANCE_MAX_BYTES + 8192;
    if (existsSync(path)) {
      const saved = read(path, domain, maximumBytes);
      if (JSON.stringify(saved.value) !== JSON.stringify(value)) throw new Error('Wallet proof publication differs from retained staged evidence');
      return saved.digest;
    }
    const bytes = seal(value, domain);
    if (bytes.length > maximumBytes) throw new Error('Wallet proof record exceeds its per-record ceiling');
    inventory(bytes.length, 1);
    const temp = join(options.directory, `.staged-${randomBytes(16).toString('hex')}`);
    lease.assertWritable({ path: temp, maximumBytes: bytes.length });
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); let offset = 0;
      while (offset < bytes.length) { const count = writeSync(fd, bytes, offset); if (count < 1) throw new Error('Wallet proof write failed'); offset += count; }
      fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
      if (process.platform !== 'win32') { const directory = openSync(options.directory, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
      return hash(bytes);
    } catch (error) { poisoned = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const recordPath = (index: number) => join(options.directory, `record-${index}.bin`);
  const recordDomain = (index: number) => `resonance:wallet-policy-proof-record:v1:${options.authorityId}:${index}`;
  function record(index: number) {
    const saved = read(recordPath(index), recordDomain(index)), item = saved.value as RecordValue;
    if (!item || Object.keys(item).sort().join(',') !== 'kind,previous,value,version' || item.version !== 1
      || (index === 0 ? item.kind !== 'genesis' || item.previous !== null : item.kind !== 'advance' || !id(item.previous))) throw new Error('Invalid wallet policy proof record');
    return { ...saved, value: item };
  }
  function reference(ref: WalletPolicyProofReference, context: AdmissionPolicyObservers) {
    const parsed = parseWalletPolicyProofReference(ref);
    if (JSON.stringify(parsed.funding) !== JSON.stringify({ maxCiphertextBytes: options.maxCiphertextBytes, maxRecords: options.maxRecords, limits: options.limits })
      || parsed.authorityId !== options.authorityId || parsed.contextId !== admissionPolicyObserversId(context)
      || parsed.count > options.limits.maxTransitions + 1) throw new Error('Wallet policy proof differs from its storage selection or limits');
    return parsed;
  }
  const reader = async (digest: string, signal: AbortSignal) => {
    signal.throwIfAborted(); if (!id(digest)) throw new Error('Invalid wallet archive page digest');
    const value = read(join(options.directory, `page-${digest.slice(7)}.bin`), `resonance:wallet-policy-proof-page:v1:${digest}`, Math.ceil(512 * 1024 * 4 / 3) + 8192).value;
    if (typeof value !== 'string') throw new Error('Invalid wallet archive page');
    const bytes = Uint8Array.from(Buffer.from(value, 'base64url'));
    if (Buffer.from(bytes).toString('base64url') !== value || admissionPolicyArchivePageDigest(bytes) !== digest) throw new Error('Wallet archive page digest differs');
    return bytes;
  };
  return {
    limits: options.limits, reader,
    catalogueRead(digest: string) {
      if (!id(digest)) throw new Error('Invalid wallet catalogue root');
      const saved = read(join(options.directory, `catalogue-${digest.slice(7)}.bin`), `resonance:wallet-enrollment:v1:${options.authorityId}`, 2 * 1024 * 1024);
      if (hash(Buffer.from(JSON.stringify(saved.value))) !== digest) throw new Error('Wallet catalogue digest differs');
      return saved.value;
    },
    cataloguePublish(value: unknown) {
      const digest = hash(Buffer.from(JSON.stringify(value)));
      publish(join(options.directory, `catalogue-${digest.slice(7)}.bin`), value, `resonance:wallet-enrollment:v1:${options.authorityId}`);
      return digest;
    },
    progress() { ready(); return structuredClone(manifest.read()); },
    async resolve(refValue: WalletPolicyProofReference, context: AdmissionPolicyObservers, signal?: AbortSignal, issuerKeys: readonly string[] = [], budget = new AdmissionPolicyArchiveBudget({ limits: options.limits, signal })) {
      ready(); const ref = reference(refValue, context);
      let first: ReturnType<typeof record>;

      async function* advances() {
        let tip = first!.digest;
        for (let index = 1; index < ref.count; index++) {
          signal?.throwIfAborted(); const next = record(index);
          if (next.value.previous !== tip) throw new Error('Wallet policy proof hash chain differs');
          tip = next.digest; yield next.value.value;
        }
        if (tip !== ref.tip) throw new Error('Wallet policy proof terminal digest differs');
      }
      const resolved = await resolveAdmissionPolicy({ context, genesis: undefined,
        readGenesis: async readSignal => { readSignal.throwIfAborted(); first = record(0); return first.value.value; },
        advances: advances(), selectedHead: ref.head, reader, limits: options.limits, signal, budget });
      const memberships = await resolveAdmissionPolicyCatalogueMembership({ policy: resolved, issuerKeys, reader, limits: options.limits, signal, budget });
      const entries = new Map([...memberships].map(([id, membership]) => [id, inspectResolvedAdmissionPolicyKey(resolved, membership)]));
      return { resolved, entries, memberships };
    },
    publishGenesis(genesis: SignedAdmissionPolicy, context: AdmissionPolicyObservers): WalletPolicyProofReference {
      ready(); const tip = publish(recordPath(0), { version: 1, previous: null, kind: 'genesis', value: genesis }, recordDomain(0));
      return { version: 1, authorityId: options.authorityId, contextId: admissionPolicyObserversId(context), count: 1, tip, head: structuredClone(context.genesis), funding: { maxCiphertextBytes: options.maxCiphertextBytes, maxRecords: options.maxRecords, limits: structuredClone(options.limits) } };
    },
    publishAdvance(previous: WalletPolicyProofReference, context: AdmissionPolicyObservers, advance: ArchivedAdmissionPolicyAdvance, pages: readonly { digest: string; bytes: Uint8Array }[]) {
      const ref = reference(previous, context);
      if (!sameAdmissionPolicyHead(ref.head, advance.commitment.previous) || ref.count >= options.limits.maxTransitions + 1) throw new Error('Wallet proof requires its exact immediate successor');
      for (const page of pages) {
        if (admissionPolicyArchivePageDigest(page.bytes) !== page.digest) throw new Error('Wallet archive page digest differs');
        publish(join(options.directory, `page-${page.digest.slice(7)}.bin`), Buffer.from(page.bytes).toString('base64url'), `resonance:wallet-policy-proof-page:v1:${page.digest}`);
      }
      const tip = publish(recordPath(ref.count), { version: 1, previous: ref.tip, kind: 'advance', value: advance }, recordDomain(ref.count));
      return { ...ref, count: ref.count + 1, tip, head: structuredClone(advance.commitment.next) };
    },
    saveProgress(context: AdmissionPolicyObservers, ref: WalletPolicyProofReference) {
      reference(ref, context); inventory();
      try { manifest.write({ version: 1, context: structuredClone(context), progress: structuredClone(ref) }); }
      catch (error) { poisoned = true; throw error; }
    },
    assertWritable() { ready(); inventory(); },
    close() { if (!closed) { closed = true; manifest.close(); key.fill(0); } },
  };
}
