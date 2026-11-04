/** Fixed partitions in ONE encrypted arena per physical privacy scope. */
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import type { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { preflightSustainableRecoveryManifest, type RecoveryAllocationManifest, type RecoveryProofKind } from './sustainable-recovery-manifest.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryConcat, sustainableRecoveryParse, sustainableRecoveryView, withSustainableRecoveryWork, type RecoveryWorkCategory } from './sustainable-recovery-work.js';
import { assertValidatedRecoveryPairView, closeRecoveryPairValidationOperation, createOpaqueRecoveryCommitment, createRecoveryPairValidationOperation, decryptOpaqueRecoveryObject, parseOpaqueRecoveryObjectBytes, validateOpaqueRecoveryCommitment, validateRecoveryPair, verifyRecoveryCapsule, type OpaqueRecoveryCommitment, type RecoveryPairIdentity, type RecoveryPairValidationOperation, type RecoveryProofPair, type ValidatedRecoveryPairView } from './sustainable-recovery-opaque.js';

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const HEADER = 256;
function all(fd: number, data: Buffer, offset: number, category: RecoveryWorkCategory = 'V') { chargeSustainableRecoveryWork(data.length, category, 'disk-write'); for (let n = 0; n < data.length;) { const count = writeSync(fd, data, n, data.length - n, offset + n); if (count <= 0) throw new Error('Recovery arena write stopped'); n += count; } }
function read(fd: number, bytes: number, offset: number, category: RecoveryWorkCategory = 'V') { const data = Buffer.alloc(bytes); let n = 0; while (n < bytes) { const count = readSync(fd, data, n, bytes - n, offset + n); if (!count) break; n += count; } const result = data.subarray(0, n); chargeSustainableRecoveryWork(result.length, category, 'disk-read'); return result; }
type ArchiveType = 'original' | 'frame' | 'capsule' | 'key';
interface ArchiveEntry { offset: number; bytes: number; kind: RecoveryProofKind; type: ArchiveType; digest: string; proofId?: string; scopeDigest?: string; proposal?: string; exporter?: string; recipient?: string; frameDigest?: string }
export interface RecoveryPairPreflightMetadata { commitment: OpaqueRecoveryCommitment; identity: RecoveryPairIdentity; frameBytes: number; capsuleBytes: number; initialKey: boolean }

export function openSustainableRecoveryArena(options: {
  authority: ReturnType<typeof openStorageReservationAuthority>; manifest: RecoveryAllocationManifest;
  owner: string; copy: number; key: Uint8Array; mode: 'new' | 'existing';
}) {
  const compiled = preflightSustainableRecoveryManifest(options.authority, options.manifest, options.mode);
  const meter = <T>(work: () => T) => withSustainableRecoveryWork(compiled.maximumWork, work);
  const owner = compiled.manifest.owners.find(o => o.owner === options.owner);
  if (!owner || !Number.isSafeInteger(options.copy) || options.copy < 0 || options.copy > (owner.role === 'wallet' ? 0 : 5) || options.key.length !== 32) throw new Error('Wrong arena owner, scope or encryption key');
  const path = join(compiled.manifest.root, owner.owner, options.copy === 0 ? 'local' : `replica-${options.copy}`);
  const request = compiled.requests.find(r => r.path === path)!;
  const leases = options.authority.reserveReservations(compiled.requests), lease = leases[compiled.requests.indexOf(request)];
  lease.assertWritable();
  const existed = existsSync(path);
  if (options.mode === 'new' && existed || options.mode === 'existing' && !existed) throw new Error('Select an intact explicit arena mode');
  if (!existed) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Redirected recovery arena');
  const release = acquireLocalStateLock(join(path, 'owner'), lease), file = join(path, 'arena.bin');
  let fd: number;
  try { fd = openSync(file, (options.mode === 'new' ? constants.O_CREAT | constants.O_EXCL : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) { release(); throw error; }
  const key = Buffer.from(options.key), aad = Buffer.from(`${compiled.digest}\n${options.authority.status().authorityId}\n${owner.owner}\n${options.copy}`), participant = {};
  let closed = false;
  const regions = { state: [0, owner.L] as const, suffix: [2 * owner.L, owner.D] as const, pending: [2 * owner.L + 2 * owner.D, owner.P] as const };
  const archiveStart = 2 * owner.L + 2 * owner.D + 2 * owner.P, maximum = archiveStart + owner.C;
  const archive = new Map<string, ArchiveEntry>();
  const kinds: RecoveryProofKind[] = ['original', 'frame', 'policy', 'activation'];
  const consumed = Object.fromEntries(kinds.map(k => [k, { count: 0, bytes: 0 }])) as Record<RecoveryProofKind, { count: number; bytes: number }>;
  let archiveUsed = 0, uncertainArchive = false;
  function usable() {
    if (closed) throw new Error('Recovery arena closed'); if (uncertainArchive) throw new Error('Uncertain immutable append; preserve failed bytes for recovery'); lease.assertWritable();
    const st = fstatSync(fd), named = lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || named.isSymbolicLink() || st.ino !== named.ino || st.dev !== named.dev || st.size > request.maximumBytes - 8192) throw new Error('Recovery arena physical scope changed');
  }
  function workCategory(tag: string): RecoveryWorkCategory { return tag === 'owner-opaque-state' || tag.startsWith('state:') ? 'L' : tag.startsWith('suffix:') || tag.startsWith('pending:') ? 'D' : 'V'; }
  function authenticatedAssociatedData(tag: string, category: RecoveryWorkCategory) { const bytes = Buffer.from(tag); chargeSustainableRecoveryWork(bytes.length, category, 'copy'); return sustainableRecoveryConcat([aad, bytes], category); }
  function encrypt(data: Buffer, tag: string, deterministic?: string) {
    const category = workCategory(tag), nonce = deterministic ? createHmac('sha256', key).update(aad).update('object-nonce-v1').update(deterministic).digest().subarray(0, 12) : randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(authenticatedAssociatedData(tag, category)); return sustainableRecoveryConcat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()], category, 'encrypt');
  }
  function decrypt(data: Buffer, tag: string) {
    if (data.length < 28) throw new Error('Missing recovery frame');
    const category = workCategory(tag), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAAD(authenticatedAssociatedData(tag, category));
    decipher.setAuthTag(data.subarray(-16)); return sustainableRecoveryConcat([decipher.update(data.subarray(12, -16)), decipher.final()], category, 'decrypt');
  }
  const headerMac = (header: Buffer, tag: string) => createHmac('sha256', key).update(aad).update(tag).update(header.subarray(0, 48)).digest();
  const pairHeaderMac = (header: Buffer, tag: string) => createHmac('sha256', key).update(aad).update(tag).update(header.subarray(0, 224)).digest();
  function image(region: keyof typeof regions, slot: number) {
    const category = region === 'state' ? 'L' : 'D', [start, capacity] = regions[region], offset = start + slot * capacity, head = read(fd, HEADER, offset, category);
    if (head.length === 0 || head.every(b => b === 0)) return undefined;
    if (head.length !== HEADER || head.toString('ascii', 0, 4) !== 'RSC1' || !headerMac(head, region).equals(head.subarray(48, 80))) throw new Error('Interrupted arena image requires recovery');
    const bytes = head.readUInt32BE(4), generation = Number(head.readBigUInt64BE(8));
    if (!Number.isSafeInteger(generation) || bytes + HEADER > capacity || bytes < 28) throw new Error('Arena image exceeds partition');
    const encoded = read(fd, bytes, offset + HEADER, category), digest = head.subarray(16, 48);
    if (encoded.length !== bytes || !createHash('sha256').update(encoded).digest().equals(digest)) throw new Error('Interrupted arena image requires recovery');
    return { generation, bytes: decrypt(encoded, `${region}:${generation}`) };
  }
  function account(kind: RecoveryProofKind, bytes: number, counters = consumed) {
    const budget = owner!.closure[kind], next = counters[kind]; next.count++; next.bytes += bytes;
    if (next.count > budget.count || ('bytes' in budget ? next.bytes > budget.bytes : bytes > budget.maximumBytes)) throw new Error(`Recovery ${kind} prospective proof allowance exhausted`);
  }
  const originalKey = (id: string) => `O:${id}`;
  const frameKey = (scopeDigest: string, proofId: string, frameDigest: string) => `F:${scopeDigest}:${proofId}:${frameDigest}`;
  const capsuleKey = (identity: RecoveryPairIdentity) => `C:${identity.proofId}:${identity.frameDigest}:${identity.proposal}:${identity.exporter}:${identity.recipient}:${identity.wrappingKeyId.slice(0, 23)}`;
  const keyRecordKey = (frameDigest: string) => `K:${frameDigest}`;
  function frameIdentity(frame: ReturnType<typeof parseOpaqueRecoveryObjectBytes>) { return frameKey(hash(Buffer.from(frame.scope)), frame.proofId, frame.frameDigest); }
  function preflightPairMetadata(values: RecoveryPairPreflightMetadata[]) {
    usable(); const counters = structuredClone(consumed), seen = new Set(archive.keys()), proofs = new Map<string, string>(); let used = archiveUsed;
    for (const entry of archive.entries()) if (entry[1].type === 'frame') proofs.set(`${entry[1].scopeDigest}:${entry[1].proofId}`, entry[1].digest);
    for (const value of values) {
      const commitment = validateOpaqueRecoveryCommitment(value.commitment), identity = value.identity;
      if (value.frameBytes !== commitment.frameBytes || identity.frameDigest !== commitment.frameDigest || identity.scope !== commitment.scope
        || identity.proofId !== commitment.proofId || identity.kind !== commitment.proofKind || identity.capsuleDigest !== value.identity.capsuleDigest
        || !Number.isSafeInteger(value.capsuleBytes) || value.capsuleBytes < 1) throw new Error('Preflight pair metadata differs');
      const scopeDigest = hash(Buffer.from(commitment.scope)), fKey = frameKey(scopeDigest, commitment.proofId, commitment.frameDigest), cKey = capsuleKey(identity), proofKey = `${scopeDigest}:${commitment.proofId}`;
      const priorDigest = proofs.get(proofKey); if (priorDigest && priorDigest !== commitment.frameDigest) throw new Error('Conflicting frames for one original scope/proof ID');
      proofs.set(proofKey, commitment.frameDigest);
      if (!seen.has(fKey)) { seen.add(fKey); account(commitment.proofKind, commitment.logicalBytes, counters); used += HEADER + value.frameBytes; }
      if (!seen.has(cKey)) { seen.add(cKey); used += HEADER + value.capsuleBytes; }
      if (value.initialKey && !seen.has(keyRecordKey(commitment.frameDigest))) { seen.add(keyRecordKey(commitment.frameDigest)); used += HEADER + 60; }
    }
    if (used > owner!.C) throw new Error(`Recovery complete proof archive exhausted before effects: required=${used} limit=${owner!.C}`);
  }
  function preflightPairs(values: Array<{ pair: RecoveryProofPair; initialKey?: boolean }>) {
    preflightPairMetadata(values.map(value => ({ commitment: value.pair.commitment, identity: value.pair.identity,
      frameBytes: value.pair.frame.length, capsuleBytes: value.pair.capsuleBytes.length, initialKey: value.initialKey ?? false })));
  }
  function preflightView(view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation) {
    assertValidatedRecoveryPairView(view, operation);
    preflightPairMetadata([{ commitment: view.commitment, identity: view.identity, frameBytes: view.frameBytes,
      capsuleBytes: view.capsulePhysicalBytes, initialKey: view.initialKey }]);
  }
  function preflight(items: Array<{ bytes: Uint8Array; kind: RecoveryProofKind; logicalBytes?: number }>) {
    usable(); const counters = structuredClone(consumed), seen = new Set(archive.keys()); let used = archiveUsed;
    for (const item of items) {
      if (!kinds.includes(item.kind)) throw new Error('Unknown proof obligation'); const id = hash(item.bytes), key = originalKey(id); if (seen.has(key)) continue; seen.add(key);
      const charged = item.logicalBytes ?? item.bytes.length; if (!Number.isSafeInteger(charged) || charged !== item.bytes.length) throw new Error('Unbounded original encoding');
      account(item.kind, charged, counters); used += HEADER + 28 + item.bytes.length;
    }
    if (used > owner!.C) throw new Error(`Recovery complete proof archive exhausted before effects: required=${used} limit=${owner!.C}`);
  }
  function scanArchive() {
    const size = fstatSync(fd).size;
    while (archiveStart + archiveUsed < size && archiveUsed < owner!.C) {
      const offset = archiveStart + archiveUsed, header = read(fd, HEADER, offset);
      if (header.length === 0 || header.every(b => b === 0)) { if (read(fd, Math.min(size - offset, owner!.C - archiveUsed), offset).some(b => b !== 0)) throw new Error('Interrupted immutable archive tail; preserve failed bytes'); break; }
      if (header.length !== HEADER) throw new Error('Uncertain immutable recovery append; preserve arena');
      const magic = header.toString('ascii', 0, 4), bytes = header.readUInt32BE(4), digest = `sha256:${header.subarray(8, 40).toString('hex')}`;
      if (HEADER + bytes > owner!.C - archiveUsed) throw new Error('Invalid immutable recovery archive');
      const kind = kinds[header[40]]; if (!kind && magic !== 'RSK3') throw new Error('Unknown recovery archive obligation class');
      const charged = header.readUInt32BE(44); if (magic !== 'RSK3' && (charged > bytes || bytes > charged + 4096)) throw new Error('Unbounded retained recovery proof');
      if (magic === 'RSO3' || magic === 'RSC3') {
        if (!pairHeaderMac(header, magic).equals(header.subarray(224, 256))) throw new Error('Invalid pair archive authentication');
        const proofId = `sha256:${header.subarray(48, 80).toString('hex')}`;
        if (magic === 'RSO3') {
          const scopeDigest = `sha256:${header.subarray(80, 112).toString('hex')}`, key = frameKey(scopeDigest, proofId, digest);
          if (archive.has(key)) throw new Error('Conflicting exact frame archive'); account(kind, charged);
          archive.set(key, { offset: offset + HEADER, bytes, kind, type: 'frame', digest, proofId, scopeDigest });
        } else {
          const frameDigest = `sha256:${header.subarray(80, 112).toString('hex')}`, proposal = `sha256:${header.subarray(112, 144).toString('hex')}`;
          const exporter = header.subarray(144, 176).toString('base64url'), recipient = header.subarray(176, 208).toString('base64url');
          const identity: RecoveryPairIdentity = { scope: '', proofId, kind, frameDigest, proposal, exporter, recipient, wrappingKeyId: `sha256:${header.subarray(208, 224).toString('hex')}`, capsuleDigest: digest };
          const key = capsuleKey(identity); if (archive.has(key)) throw new Error('Conflicting exact capsule archive');
          archive.set(key, { offset: offset + HEADER, bytes, kind, type: 'capsule', digest, proofId, frameDigest, proposal, exporter, recipient });
        }
        archiveUsed += HEADER + bytes; continue;
      }
      if (magic === 'RSK3') {
        if (!pairHeaderMac(header, magic).equals(header.subarray(224, 256))) throw new Error('Invalid key archive authentication');
        const frameDigest = `sha256:${header.subarray(48, 80).toString('hex')}`, key = keyRecordKey(frameDigest);
        if (archive.has(key) || bytes !== 60) throw new Error('Invalid role-private key archive');
        archive.set(key, { offset: offset + HEADER, bytes, kind: 'original', type: 'key', digest, frameDigest }); archiveUsed += HEADER + bytes; continue;
      }
      if (magic !== 'RSO1' || !headerMac(header, 'archive').equals(header.subarray(48, 80)) || bytes < 28) throw new Error('Uncertain immutable recovery append; preserve arena');
      const key = originalKey(digest); if (archive.has(key)) throw new Error('Invalid immutable recovery archive');
      account(kind, charged); archive.set(key, { offset: offset + HEADER, bytes, kind, type: 'original', digest }); archiveUsed += HEADER + bytes;
    }
  }
  try { meter(() => { usable(); scanArchive(); }); } catch (error) { closeSync(fd); release(); key.fill(0); throw error; }
  function recoverImage(region: keyof typeof regions = 'state') {
    usable(); const slots = [0, 1].map(slot => { try { return { slot, value: image(region, slot) }; } catch (error) { return { slot, error }; } });
    const broken = slots.filter(s => 'error' in s), survivors = slots.filter(s => s.value); if (!broken.length) return;
    if (broken.length !== 1 || survivors.length !== 1) throw new Error('Ambiguous arena damage; authenticated recovery required');
    const category = region === 'state' ? 'L' : 'D', bad = broken[0], good = survivors[0].value!, [start, capacity] = regions[region], offset = start + bad.slot * capacity, raw = read(fd, capacity, offset, category);
    if (raw.length < HEADER || raw.toString('ascii', 0, 4) !== 'RSC1' || !headerMac(raw, region).equals(raw.subarray(48, 80)) || Number(raw.readBigUInt64BE(8)) !== good.generation - 1 || raw.readUInt32BE(4) + HEADER > capacity) throw new Error('Damaged arena may exceed surviving protected floor');
    const retained = raw, id = hash(retained), failedPath = join(path, 'failed.bin'), failedFd = openSync(failedPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const st = fstatSync(failedFd); if (!st.isFile() || st.nlink !== 1 || st.size > owner!.F) throw new Error('Failed-byte preservation scope differs');
      let used = 0, found = false;
      while (used < st.size) { const header = read(failedFd, HEADER, used); if (header.length !== HEADER || header.toString('ascii', 0, 4) !== 'RSF1') throw new Error('Interrupted failed-byte retention'); const length = header.readUInt32BE(4), bytes = read(failedFd, length, used + HEADER); if (bytes.length !== length || hash(bytes) !== `sha256:${header.subarray(8, 40).toString('hex')}`) throw new Error('Corrupt retained failed bytes'); if (hash(bytes) === id) found = true; used += HEADER + length; }
      if (!found) { if (used + HEADER + retained.length > owner!.F) throw new Error('Failed-byte F allowance exhausted; preserve both images'); const header = Buffer.alloc(HEADER); header.write('RSF1'); header.writeUInt32BE(retained.length, 4); Buffer.from(id.slice(7), 'hex').copy(header, 8); all(failedFd, sustainableRecoveryConcat([header, retained]), used); fsyncSync(failedFd); }
      all(fd, Buffer.alloc(HEADER), offset, category); fsyncSync(fd);
    } finally { closeSync(failedFd); }
  }
  function append(entry: ArchiveEntry & { key: string; data: Buffer; header: Buffer; logicalBytes?: number }) {
    const size = HEADER + entry.data.length; if (size > owner!.C - archiveUsed) throw new Error('Recovery complete proof archive exhausted');
    const offset = archiveStart + archiveUsed;
    try { all(fd, entry.data, offset + HEADER); fsyncSync(fd); all(fd, entry.header, offset); fsyncSync(fd); } catch (error) { uncertainArchive = true; throw error; }
    if (entry.type === 'original' || entry.type === 'frame') account(entry.kind, entry.logicalBytes ?? entry.data.length);
    const { key, data, header, logicalBytes, ...stored } = entry; archive.set(key, { ...stored, offset: offset + HEADER }); archiveUsed += size;
  }
  function pairHeader(magic: 'RSO3' | 'RSC3', bytes: number, kind: RecoveryProofKind, logicalBytes: number, digest: string, proofId: string) {
    const header = Buffer.alloc(HEADER); header.write(magic); header.writeUInt32BE(bytes, 4); Buffer.from(digest.slice(7), 'hex').copy(header, 8); header[40] = kinds.indexOf(kind); header.writeUInt32BE(logicalBytes, 44); Buffer.from(proofId.slice(7), 'hex').copy(header, 48); return header;
  }
  function validatePair(pair: RecoveryProofPair, initialKey: boolean) {
    const operation = createRecoveryPairValidationOperation(participant);
    try { return { view: validateRecoveryPair(operation, pair, initialKey), operation }; }
    catch (error) { closeRecoveryPairValidationOperation(operation); throw error; }
  }
  function putValidatedPair(view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation, dek?: Uint8Array) {
    if (operation.participant !== participant || view.initialKey !== !!dek) throw new Error('Cross-arena or wrong-key validated pair use');
    assertValidatedRecoveryPairView(view, operation); usable();
    const frame = view.frameMetadata, capsule = view.capsule, identity = view.identity, fKey = frameIdentity(frame), cKey = capsuleKey(identity);
    const oldFrame = archive.get(fKey), oldCapsule = archive.get(cKey);
    if (oldFrame && oldFrame.digest !== frame.frameDigest || oldCapsule && oldCapsule.digest !== identity.capsuleDigest) throw new Error('Conflicting exact recovery pair');
    for (const [otherKey, other] of archive) if (other.type === 'frame' && other.scopeDigest === hash(Buffer.from(frame.scope)) && other.proofId === frame.proofId && other.digest !== frame.frameDigest && otherKey !== fKey) throw new Error('Conflicting frames for one original scope/proof ID');
    preflightView(view, operation);
    if (!oldFrame) {
      const header = pairHeader('RSO3', view.frameBytes, frame.kind, view.logicalBytes, frame.frameDigest, frame.proofId); Buffer.from(hash(Buffer.from(frame.scope)).slice(7), 'hex').copy(header, 80); pairHeaderMac(header, 'RSO3').copy(header, 224);
      append({ key: fKey, data: view.frame, header, offset: 0, bytes: view.frameBytes, kind: frame.kind, type: 'frame', digest: frame.frameDigest, proofId: frame.proofId, scopeDigest: hash(Buffer.from(frame.scope)), logicalBytes: view.logicalBytes });
    }
    if (!oldCapsule) {
      const header = pairHeader('RSC3', view.capsulePhysicalBytes, frame.kind, 0, identity.capsuleDigest, frame.proofId); Buffer.from(frame.frameDigest.slice(7), 'hex').copy(header, 80); Buffer.from(capsule.proposal.slice(7), 'hex').copy(header, 112); Buffer.from(capsule.exporter, 'base64url').copy(header, 144); Buffer.from(capsule.recipient, 'base64url').copy(header, 176); Buffer.from(capsule.wrappingKeyId.slice(7, 23), 'hex').copy(header, 208); pairHeaderMac(header, 'RSC3').copy(header, 224);
      append({ key: cKey, data: view.capsuleBytes, header, offset: 0, bytes: view.capsulePhysicalBytes, kind: frame.kind, type: 'capsule', digest: identity.capsuleDigest, proofId: frame.proofId, frameDigest: frame.frameDigest, proposal: capsule.proposal, exporter: capsule.exporter, recipient: capsule.recipient });
    }
    if (dek) putDek(frame.frameDigest, dek);
    return identity;
  }
  function putPair(value: { pair: RecoveryProofPair; dek?: Uint8Array }) {
    return meter(() => {
      const { view, operation } = validatePair(value.pair, !!value.dek);
      try { return putValidatedPair(view, operation, value.dek); } finally { closeRecoveryPairValidationOperation(operation); }
    });
  }
  function putDek(frameDigest: string, dekValue: Uint8Array) {
    if (dekValue.length !== 32) throw new Error('Invalid local DEK record'); const kKey = keyRecordKey(frameDigest), existing = archive.get(kKey);
    if (existing) {
      if (existing.frameDigest !== frameDigest) throw new Error('Local DEK record frame binding differs');
      const prior = decrypt(read(fd, existing.bytes, existing.offset), `dek:${frameDigest}`);
      try { if (!prior.equals(dekValue)) throw new Error('Reused local DEK record differs'); return; } finally { prior.fill(0); }
    }
    const dek = sustainableRecoveryView(dekValue); try {
      const data = encrypt(dek, `dek:${frameDigest}`, frameDigest), digest = hash(data), header = Buffer.alloc(HEADER); header.write('RSK3'); header.writeUInt32BE(data.length, 4); Buffer.from(digest.slice(7), 'hex').copy(header, 8); Buffer.from(frameDigest.slice(7), 'hex').copy(header, 48); pairHeaderMac(header, 'RSK3').copy(header, 224);
      append({ key: kKey, data, header, offset: 0, bytes: data.length, kind: 'original', type: 'key', digest, frameDigest });
    } finally { dek.fill(0); }
  }
  function readPair(identity: RecoveryPairIdentity) {
    usable(); const frameBytes = getFrame(identity), parsed = parseOpaqueRecoveryObjectBytes(frameBytes), cKey = capsuleKey(identity);
    const capsuleEntry = archive.get(cKey); if (!capsuleEntry) throw new Error('Missing exact recovery capsule');
    const capsuleBytes = read(fd, capsuleEntry.bytes, capsuleEntry.offset), capsule = verifyRecoveryCapsule(sustainableRecoveryParse(capsuleBytes), frameBytes, { proposal: identity.proposal, exporter: identity.exporter, recipient: identity.recipient, wrappingKeyId: identity.wrappingKeyId });
    if (hash(capsuleBytes) !== identity.capsuleDigest || capsule.wrappingKeyId !== identity.wrappingKeyId) throw new Error('Changed exact recovery capsule');
    return { frame: frameBytes, commitment: createOpaqueRecoveryCommitment(frameBytes).commitment, capsule, capsuleBytes, capsuleDigest: identity.capsuleDigest, identity } satisfies RecoveryProofPair;
  }
  function getFrame(identity: RecoveryPairIdentity) {
    const entry = archive.get(frameKey(hash(Buffer.from(identity.scope)), identity.proofId, identity.frameDigest));
    if (!entry) throw new Error('Missing exact recovery frame');
    const data = read(fd, entry.bytes, entry.offset), frame = parseOpaqueRecoveryObjectBytes(data, identity.scope.split(':object:')[0]);
    if (frame.proofId !== identity.proofId || frame.kind !== identity.kind || frame.frameDigest !== identity.frameDigest) throw new Error('Changed exact recovery frame');
    return data;
  }
  return {
    path, layout: compiled.digest, maximumWork: compiled.maximumWork, authorityId: compiled.authorityId, ownerName: owner.owner, proofClosure: structuredClone(owner.closure),
    originalDeclarations: compiled.manifest.originals.filter(o => o.owner === owner.owner),
    seal(bytes: Uint8Array) { return meter(() => { usable(); return encrypt(sustainableRecoveryView(bytes), 'owner-opaque-state'); }); },
    unseal(bytes: Uint8Array) { return meter(() => { usable(); return decrypt(sustainableRecoveryView(bytes), 'owner-opaque-state'); }); },
    read(region: keyof typeof regions = 'state') { return meter(() => { usable(); const a = image(region, 0), b = image(region, 1); if (!a && !b) return undefined; if (a && b && a.generation === b.generation && !a.bytes.equals(b.bytes)) throw new Error('Equivocating arena generation'); return !a ? b : !b ? a : a.generation > b.generation ? a : b; }); },
    write(region: keyof typeof regions, bytes: Uint8Array) { return meter(() => {
      const category = region === 'state' ? 'L' : 'D'; usable(); const a = image(region, 0), b = image(region, 1), generation = Math.max(a?.generation ?? -1, b?.generation ?? -1) + 1;
      const encoded = encrypt(sustainableRecoveryView(bytes), `${region}:${generation}`), [start, capacity] = regions[region]; if (encoded.length + HEADER > capacity) throw new Error('Recovery aggregate child partition exhausted');
      const slot = generation % 2, offset = start + slot * capacity, header = Buffer.alloc(HEADER); header.write('RSC1'); header.writeUInt32BE(encoded.length, 4); header.writeBigUInt64BE(BigInt(generation), 8); createHash('sha256').update(encoded).digest().copy(header, 16); headerMac(header, region).copy(header, 48);
      all(fd, encoded, offset + HEADER, category); fsyncSync(fd); all(fd, header, offset, category); fsyncSync(fd); return generation;
    }); },
    preflight: (items: Parameters<typeof preflight>[0]) => meter(() => preflight(items)),
    preflightPairs: (items: Array<{ pair: RecoveryProofPair; initialKey?: boolean }>) => meter(() => preflightPairs(items)),
    preflightPairMetadata: (items: Parameters<typeof preflightPairMetadata>[0]) => meter(() => preflightPairMetadata(items)),
    recover: (region: keyof typeof regions = 'state') => meter(() => recoverImage(region)),
    proofKind(id: string) { usable(); const entries = [...archive.values()].filter(item => (item.type === 'original' || item.type === 'frame') && (item.digest === id || item.proofId === id)); if (!entries.length) throw new Error('Missing proof class'); if (entries.some(item => item.kind !== entries[0].kind)) throw new Error('Conflicting proof class'); return entries[0].kind; },
    assertImageSize(region: keyof typeof regions, bytes: number) { usable(); if (bytes + HEADER + 28 > regions[region][1]) throw new Error('Prospective recovery image closure exceeds partition'); },
    put(bytes: Uint8Array, kind: RecoveryProofKind = 'original', logicalBytes = bytes.length) { return meter(() => {
      usable(); const data = sustainableRecoveryView(bytes), id = hash(data), key = originalKey(id), old = archive.get(key); if (old) return id;
      preflight([{ bytes: data, kind, logicalBytes }]); const encoded = encrypt(data, id), header = Buffer.alloc(HEADER); header.write('RSO1'); header.writeUInt32BE(encoded.length, 4); Buffer.from(id.slice(7), 'hex').copy(header, 8); header[40] = kinds.indexOf(kind); header.writeUInt32BE(logicalBytes, 44); headerMac(header, 'archive').copy(header, 48);
      append({ key, data: encoded, header, offset: 0, bytes: encoded.length, kind, type: 'original', digest: id, logicalBytes }); return id;
    }); },
    putPair,
    validatePair: (pair: RecoveryProofPair, initialKey: boolean) => meter(() => validatePair(pair, initialKey)),
    putValidatedPair: (view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation, dek?: Uint8Array) => meter(() => putValidatedPair(view, operation, dek)),
    pairStatus(identity: RecoveryPairIdentity) { usable(); const frame = archive.get(frameKey(hash(Buffer.from(identity.scope)), identity.proofId, identity.frameDigest)), capsule = archive.get(capsuleKey(identity)); if (!frame || !capsule || capsule.digest !== identity.capsuleDigest) throw new Error('Missing exact recovery pair'); return { digest: frame.digest, bytes: frame.bytes, capsuleDigest: capsule.digest, capsuleBytes: capsule.bytes, id: identity.proofId, kind: frame.kind, proposal: identity.proposal, exporter: identity.exporter, recipient: identity.recipient }; },
    getPair: (identity: RecoveryPairIdentity) => meter(() => readPair(identity)),
    findProofPairs(id: string, kind?: RecoveryProofKind) { return meter(() => {
      usable(); const pairs: RecoveryProofPair[] = [];
      for (const item of archive.values()) {
        if (item.type !== 'capsule' || item.proofId !== id || kind && item.kind !== kind) continue;
        const frame = [...archive.values()].find(candidate => candidate.type === 'frame' && candidate.proofId === id && candidate.digest === item.frameDigest);
        if (!frame) throw new Error('Missing capsule frame');
        const frameBytes = read(fd, frame.bytes, frame.offset), parsed = parseOpaqueRecoveryObjectBytes(frameBytes);
        const capsuleBytes = read(fd, item.bytes, item.offset), capsule = verifyRecoveryCapsule(sustainableRecoveryParse(capsuleBytes), frameBytes);
        const identity: RecoveryPairIdentity = { scope: parsed.scope, proofId: id, kind: parsed.kind, frameDigest: parsed.frameDigest,
          proposal: capsule.proposal, exporter: capsule.exporter, recipient: capsule.recipient, wrappingKeyId: capsule.wrappingKeyId, capsuleDigest: item.digest };
        pairs.push({ frame: frameBytes, commitment: createOpaqueRecoveryCommitment(frameBytes).commitment, capsule, capsuleBytes, capsuleDigest: item.digest, identity });
      }
      return pairs;
    }); },
    ids() { return meter(() => { usable(); return [...new Set([...archive.values()].flatMap(item => item.type === 'original' ? [item.digest] : item.type === 'frame' ? [item.proofId!] : []))]; }); },
    get(id: string) { return meter(() => {
      usable(); const original = archive.get(originalKey(id)); if (original) { const bytes = decrypt(read(fd, original.bytes, original.offset), id); if (hash(bytes) !== id) throw new Error('Changed exact original recovery proof'); return bytes; }
      const frames = [...archive.values()].filter(item => item.type === 'frame' && item.proofId === id); if (!frames.length) throw new Error('Missing exact original recovery proof'); if (frames.length !== 1) throw new Error('Ambiguous local proof identity');
      const entry = frames[0], frame = read(fd, entry.bytes, entry.offset), keyEntry = archive.get(keyRecordKey(entry.digest)); if (!keyEntry) throw new Error('Missing role-private DEK record');
      const dek = decrypt(read(fd, keyEntry.bytes, keyEntry.offset), `dek:${entry.digest}`); try { return decryptOpaqueRecoveryObject(frame, dek); } finally { dek.fill(0); }
    }); },
    usage() { return meter(() => { usable(); return { proofCounts: structuredClone(consumed), archiveBytes: archiveUsed, archiveMaximum: owner.C, physicalBytes: fstatSync(fd).size, maximum, aggregateReserved: request.maximumBytes }; }); },
    close() { if (!closed) { closed = true; try { fsyncSync(fd); closeSync(fd); } finally { key.fill(0); release(); } } },
  };
}
export type SustainableRecoveryArena = ReturnType<typeof openSustainableRecoveryArena>;
