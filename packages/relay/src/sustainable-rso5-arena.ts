import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import type { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { preflightSustainableRecoveryManifest, type RecoveryAllocationManifest, type RecoveryProofKind } from './sustainable-recovery-manifest.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryView, withSustainableRecoveryWork, type RecoveryWorkCategory } from './sustainable-recovery-work.js';
import { parseRso5Checkpoint, parseRso5Delegation, parseRso5Frame, rso5Digest, RSO5_ZERO_HEAD, type Rso5Checkpoint, type Rso5Delegation, type Rso5FrameIdentity, type Rso5FrameMetadata } from './sustainable-rso5-opaque.js';

const HEADER = 256;
const kinds: RecoveryProofKind[] = ['original', 'frame', 'policy', 'activation'];
interface ArchiveEntry { digest: string; offset: number; bytes: number; kind: RecoveryProofKind }
function all(fd: number, data: Buffer, offset = -1) { chargeSustainableRecoveryWork(data.length, 'V', 'disk-write'); writeSync(fd, data, 0, data.length, offset); }
function read(fd: number, length: number, offset: number, category: RecoveryWorkCategory = 'V') { const data = Buffer.alloc(length); let done = 0; while (done < length) { const count = readSync(fd, data, done, length - done, offset + done); if (!count) break; done += count; } const result = data.subarray(0, done); chargeSustainableRecoveryWork(result.length, category, 'disk-read'); return result; }

export function openSustainableRso5Arena(options: {
  authority: ReturnType<typeof openStorageReservationAuthority>; manifest: RecoveryAllocationManifest;
  owner: string; copy: number; key: Uint8Array; mode: 'new' | 'existing';
}) {
  const compiled = preflightSustainableRecoveryManifest(options.authority, options.manifest, options.mode);
  const meter = <T>(work: () => T) => withSustainableRecoveryWork(compiled.maximumWork, work);
  const owner = compiled.manifest.owners.find(row => row.owner === options.owner);
  if (!owner || !Number.isSafeInteger(options.copy) || options.copy < 0 || options.copy > (owner.role === 'wallet' ? 0 : 5) || options.key.length !== 32) throw new Error('Wrong RSO5 arena owner/copy/key');
  const path = join(compiled.manifest.root, owner.owner, options.copy === 0 ? 'local' : `replica-${options.copy}`);
  const request = compiled.requests.find(row => row.path === path)!, leases = options.authority.reserveReservations(compiled.requests), lease = leases[compiled.requests.indexOf(request)];
  lease.assertWritable();
  const existed = existsSync(path); if (options.mode === 'new' && existed || options.mode === 'existing' && !existed) throw new Error('Select an intact explicit RSO5 arena mode');
  if (!existed) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Redirected RSO5 arena');
  const release = acquireLocalStateLock(join(path, 'owner'), lease), archivePath = join(path, 'frames.bin'), checkpointPath = join(path, 'checkpoints.bin'), failedPath = join(path, 'failed.bin');
  const archiveFd = openSync(archivePath, (options.mode === 'new' ? constants.O_CREAT | constants.O_EXCL : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const checkpointFd = openSync(checkpointPath, (options.mode === 'new' ? constants.O_CREAT | constants.O_EXCL : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const key = Buffer.from(options.key), frames = new Map<string, ArchiveEntry & { metadata: Rso5FrameMetadata }>(), delegations = new Map<string, ArchiveEntry & { delegation: Rso5Delegation }>(), checkpoints = new Map<string, Rso5Checkpoint>();
  const archiveHeaderKey = createHmac('sha256', key).update(`${options.authority.status().authorityId}\n${compiled.digest}\n${owner.owner}\n${options.copy}\narchive-header-v1`).digest();
  const headerMac = (header: Buffer) => createHmac('sha256', archiveHeaderKey).update(header.subarray(0, HEADER - 32)).digest();
  const consumed = Object.fromEntries(kinds.map(kind => [kind, { count: 0, bytes: 0 }])) as Record<RecoveryProofKind, { count: number; bytes: number }>;
  let archiveUsed = 0, checkpointUsed = 0, currentHead = RSO5_ZERO_HEAD, currentSequence = -1, closed = false;
  const pending = new Map<number, Rso5Checkpoint>();
  function usable() { if (closed) throw new Error('RSO5 arena closed'); lease.assertWritable(); for (const [fd, file] of [[archiveFd, archivePath], [checkpointFd, checkpointPath]] as const) { const st = fstatSync(fd), named = lstatSync(file); if (!st.isFile() || st.nlink !== 1 || named.isSymbolicLink() || st.ino !== named.ino || st.dev !== named.dev) throw new Error('RSO5 physical scope changed'); } }
  function account(kind: RecoveryProofKind, bytes: number, counters = consumed) { const next = counters[kind], budget = owner!.closure[kind]; next.count++; next.bytes += bytes; if (next.count > budget.count || ('bytes' in budget ? next.bytes > budget.bytes : bytes > budget.maximumBytes)) throw new Error(`RSO5 ${kind} proof allowance exhausted`); }
  function failedSize() { if (!existsSync(failedPath)) return 0; const fd = openSync(failedPath, constants.O_RDWR | constants.O_NOFOLLOW); try { return fstatSync(fd).size; } finally { closeSync(fd); } }
  function failed(fd: number, offset: number) {
    const size = fstatSync(fd).size - offset; if (!size) return;
    const existing = failedSize(); if (existing + size > owner!.F) throw new Error('RSO5 failed-byte F allowance exhausted');
    const failedFd = openSync(failedPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600), bytes = read(fd, size, offset);
    try { all(failedFd, bytes, existing); fsyncSync(failedFd); ftruncateSync(fd, offset); fsyncSync(fd); } finally { closeSync(failedFd); }
  }
  function scan(fd: number, checkpoint: boolean) {
    const size = fstatSync(fd).size; let offset = 0;
    while (offset < size) {
      if (size - offset < HEADER) { failed(fd, offset); break; }
      const header = read(fd, HEADER, offset), magic = header.toString('ascii', 0, 4), bytes = header.readUInt32BE(4), digest = `sha256:${header.subarray(8, 40).toString('hex')}`;
      if (!['R5F1', 'R5D1', 'R5H1', 'R5C1'].includes(magic) || HEADER + bytes > size - offset || !timingSafeEqual(headerMac(header), header.subarray(HEADER - 32))) { failed(fd, offset); break; }
      const payload = read(fd, bytes, offset + HEADER); if (rso5Digest(payload) !== digest) throw new Error('RSO5 archive digest differs');
      if (magic === 'R5F1') {
        const metadata = parseRso5Frame(payload), id = `${metadata.scopeId}:${metadata.proofId}`, old = frames.get(id);
        if (old && old.digest !== metadata.frameDigest) throw new Error('Conflicting RSO5 frames for one original scope/proof ID');
        frames.set(id, { digest, offset: offset + HEADER, bytes, kind: metadata.kind, metadata }); account(metadata.kind, metadata.frameBytes - 265);
      } else if (magic === 'R5D1') {
        const delegation = parseRso5Delegation(payload), id = `${delegation.proposal}:${delegation.exporter}:${delegation.recipient}`, old = delegations.get(id);
        if (old && old.digest !== delegation.digest) throw new Error('Conflicting RSO5 delegation identity');
        delegations.set(id, { digest, offset: offset + HEADER, bytes, kind: 'frame', delegation });
      } else {
        const record = parseRso5Checkpoint(payload); checkpoints.set(record.head, record);
        if (magic === 'R5C1') { if (record.sequence <= currentSequence) throw new Error('RSO5 committed checkpoint regresses'); currentSequence = record.sequence; currentHead = record.head; pending.delete(record.sequence); }
        else { const old = pending.get(record.sequence); if (old && old.head !== record.head) throw new Error('RSO5 checkpoint fork'); pending.set(record.sequence, record); }
      }
      offset += HEADER + bytes;
    }
    if (checkpoint) checkpointUsed = offset; else archiveUsed = offset;
  }
  try { meter(() => { usable(); scan(archiveFd, false); scan(checkpointFd, true); }); } catch (error) { closeSync(archiveFd); closeSync(checkpointFd); release(); key.fill(0); throw error; }
  function appendRecord(fd: number, magic: string, payload: Buffer, offset: number) {
    chargeSustainableRecoveryWork(HEADER, 'V', 'allocate'); const header = Buffer.alloc(HEADER); header.write(magic); header.writeUInt32BE(payload.length, 4); Buffer.from(rso5Digest(payload).slice(7), 'hex').copy(header, 8);
    headerMac(header).copy(header, HEADER - 32); all(fd, payload, offset + HEADER); fsyncSync(fd); all(fd, header, offset); fsyncSync(fd);
  }
  function preflight(values: { frames?: Uint8Array[]; delegations?: Uint8Array[]; checkpoints?: Uint8Array[]; commitCheckpoints?: Uint8Array[] }) {
    return meter(() => {
      usable(); const counters = structuredClone(consumed), frameIds = new Set(frames.keys()), delegationIds = new Set(delegations.keys()), checkpointIds = new Set(checkpoints.keys());
      let requiredC = archiveUsed, requiredD = checkpointUsed;
      for (const value of values.frames ?? []) {
        const metadata = parseRso5Frame(value), id = `${metadata.scopeId}:${metadata.proofId}`, old = frames.get(id);
        if (old) { if (old.digest !== metadata.frameDigest) throw new Error('Conflicting RSO5 frames for one original scope/proof ID'); continue; }
        if (frameIds.has(id)) throw new Error('Conflicting RSO5 frames in preflight'); frameIds.add(id);
        account(metadata.kind, metadata.frameBytes - 265, counters); requiredC += HEADER + value.length;
      }
      for (const value of values.delegations ?? []) {
        const delegation = parseRso5Delegation(value), id = `${delegation.proposal}:${delegation.exporter}:${delegation.recipient}`, old = delegations.get(id);
        if (old) { if (old.digest !== delegation.digest) throw new Error('Conflicting RSO5 delegation identity'); continue; }
        if (delegationIds.has(id)) throw new Error('Conflicting RSO5 delegations in preflight'); delegationIds.add(id); requiredC += HEADER + value.length;
      }
      for (const value of values.checkpoints ?? []) { const checkpoint = parseRso5Checkpoint(value); if (checkpointIds.has(checkpoint.head)) continue; checkpointIds.add(checkpoint.head); requiredD += HEADER + value.length; }
      for (const value of values.commitCheckpoints ?? []) { const checkpoint = parseRso5Checkpoint(value); if (checkpoint.head === currentHead || checkpoint.sequence <= currentSequence) continue; requiredD += HEADER + value.length; }
      if (requiredC > owner!.C) throw new Error(`RSO5 complete archive exhausted before effects: required=${requiredC} limit=${owner!.C}`);
      if (requiredD > owner!.D) throw new Error('RSO5 complete checkpoint suffix exhausted before effects');
    });
  }
  function appendFrame(value: Uint8Array) {
    return meter(() => {
      usable(); const data = sustainableRecoveryBytes(value, undefined, 'V'), metadata = parseRso5Frame(data), id = `${metadata.scopeId}:${metadata.proofId}`, old = frames.get(id);
      if (old) { if (old.digest !== metadata.frameDigest) throw new Error('Conflicting RSO5 frames for one original scope/proof ID'); return metadata; }
      if (archiveUsed + HEADER + data.length > owner!.C) throw new Error('RSO5 complete proof archive exhausted before effects');
      account(metadata.kind, metadata.frameBytes - 265); appendRecord(archiveFd, 'R5F1', data, archiveUsed);
      frames.set(id, { digest: metadata.frameDigest, offset: archiveUsed + HEADER, bytes: data.length, kind: metadata.kind, metadata }); archiveUsed += HEADER + data.length; return metadata;
    });
  }
  function appendDelegation(value: Uint8Array) {
    return meter(() => {
      usable(); const data = sustainableRecoveryBytes(value, undefined, 'V'), delegation = parseRso5Delegation(data), id = `${delegation.proposal}:${delegation.exporter}:${delegation.recipient}`, old = delegations.get(id);
      if (old) { if (old.digest !== delegation.digest) throw new Error('Conflicting RSO5 delegation identity'); return delegation; }
      if (archiveUsed + HEADER + data.length > owner!.C) throw new Error('RSO5 delegation archive exhausted before effects');
      appendRecord(archiveFd, 'R5D1', data, archiveUsed); delegations.set(id, { digest: delegation.digest, offset: archiveUsed + HEADER, bytes: data.length, kind: 'frame', delegation }); archiveUsed += HEADER + data.length; return delegation;
    });
  }
  function appendCheckpoint(value: Uint8Array, commit: boolean) {
    return meter(() => {
      usable(); const data = sustainableRecoveryBytes(value, undefined, 'V'), checkpoint = parseRso5Checkpoint(data);
      if (checkpoint.sequence <= currentSequence) {
        if (!committedCheckpoints().some(item => item.head === checkpoint.head)) throw new Error('RSO5 checkpoint replay conflicts with committed floor'); return checkpoint;
      }
      if (checkpoint.sequence !== currentSequence + 1 || checkpoint.previousHead !== currentHead) throw new Error('RSO5 checkpoint previous head/floor differs');
      const prior = pending.get(checkpoint.sequence); if (prior && prior.head !== checkpoint.head) throw new Error('RSO5 checkpoint fork');
      for (const entry of checkpoint.entries) {
        const frame = frames.get(`${entry.scopeId}:${entry.proofId}`);
        if (!frame || frame.digest !== entry.frameDigest || frame.bytes !== entry.frameBytes || frame.metadata.kind !== entry.kind) throw new Error('RSO5 checkpoint references missing/different frame');
      }
      if (prior && !commit) return prior;
      if (checkpointUsed + HEADER + data.length > owner!.D) throw new Error('RSO5 checkpoint suffix exhausted');
      appendRecord(checkpointFd, commit ? 'R5C1' : 'R5H1', data, checkpointUsed); checkpointUsed += HEADER + data.length; checkpoints.set(checkpoint.head, checkpoint);
      if (commit) { currentHead = checkpoint.head; currentSequence = checkpoint.sequence; pending.delete(checkpoint.sequence); }
      else pending.set(checkpoint.sequence, checkpoint);
      return checkpoint;
    });
  }
  function committedCheckpoints() {
    const result: Rso5Checkpoint[] = []; let head = currentHead, sequence = currentSequence;
    while (head !== RSO5_ZERO_HEAD) {
      const checkpoint = checkpoints.get(head); if (!checkpoint || checkpoint.sequence !== sequence || sequence < 0) throw new Error('RSO5 committed checkpoint chain is incomplete');
      result.push(checkpoint); head = checkpoint.previousHead; sequence--;
    }
    if (sequence !== -1) throw new Error('RSO5 committed checkpoint sequence is incomplete'); return result.reverse();
  }
  const keyFor = (region: string, generation: number) => createHmac('sha256', key).update(`${options.authority.status().authorityId}\n${compiled.digest}\n${owner.owner}\n${options.copy}\n${region}\n${generation}`).digest();
  function write(region: 'state' | 'suffix' | 'pending', value: Uint8Array) {
    return meter(() => {
      usable(); const file = join(path, `${region}.bin`), capacity = region === 'state' ? owner!.L : region === 'suffix' ? owner!.D : owner!.P, data = sustainableRecoveryView(value);
      if (data.length + 28 > capacity) throw new Error('RSO5 image partition exhausted');
      const previous = existsSync(file) ? readFileSync(file) : Buffer.alloc(0); chargeSustainableRecoveryWork(previous.length, region === 'state' ? 'L' : 'D', 'disk-read');
      const generation = previous.length ? previous.readUInt32BE(0) + 1 : 0, nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(region, generation), nonce);
      const encoded = sustainableRecoveryConcat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()], region === 'state' ? 'L' : 'D', 'encrypt'), header = Buffer.alloc(4); header.writeUInt32BE(generation);
      const image = sustainableRecoveryConcat([header, encoded], region === 'state' ? 'L' : 'D'), temp = `${file}.tmp`, fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { all(fd, image, 0); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, file);
    });
  }
  function readImage(region: 'state' | 'suffix' | 'pending') {
    return meter(() => {
      usable(); const file = join(path, `${region}.bin`); if (!existsSync(file)) return undefined;
      const image = readFileSync(file); chargeSustainableRecoveryWork(image.length, region === 'state' ? 'L' : 'D', 'disk-read');
      if (image.length < 44) throw new Error('RSO5 interrupted image'); const generation = image.readUInt32BE(0), encoded = image.subarray(4), nonce = encoded.subarray(0, 12);
      const decipher = createDecipheriv('aes-256-gcm', keyFor(region, generation), nonce); decipher.setAuthTag(encoded.subarray(-16));
      return { generation, bytes: sustainableRecoveryConcat([decipher.update(encoded.subarray(12, -16)), decipher.final()], region === 'state' ? 'L' : 'D', 'decrypt') };
    });
  }
  return {
    path, layout: compiled.digest, maximumWork: compiled.maximumWork, ownerName: owner.owner, proofClosure: structuredClone(owner.closure), originalDeclarations: compiled.manifest.originals.filter(row => row.owner === owner.owner),
    seal(value: Uint8Array) { return meter(() => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor('owner-state', 0), nonce); return sustainableRecoveryConcat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()], 'L', 'encrypt'); }); },
    unseal(value: Uint8Array) { return meter(() => { const data = sustainableRecoveryView(value), decipher = createDecipheriv('aes-256-gcm', keyFor('owner-state', 0), data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return sustainableRecoveryConcat([decipher.update(data.subarray(12, -16)), decipher.final()], 'L', 'decrypt'); }); },
    appendFrame, appendDelegation, preflight,
    prepareCheckpoint: (value: Uint8Array) => appendCheckpoint(value, false),
    commitCheckpoint: (value: Uint8Array) => appendCheckpoint(value, true),
    currentHead: () => meter(() => ({ sequence: currentSequence, head: currentHead, pending: pending.size })),
    getFrame(identity: Rso5FrameIdentity) { return meter(() => { usable(); const frame = frames.get(`${identity.scopeId}:${identity.proofId}`); if (!frame || frame.digest !== identity.frameDigest || frame.bytes !== identity.frameBytes || frame.metadata.kind !== identity.kind) throw new Error('Missing exact RSO5 frame'); return read(archiveFd, frame.bytes, frame.offset); }); },
    getDelegation(proposal: string, exporter: string, recipient: string) { return meter(() => { usable(); const item = delegations.get(`${proposal}:${exporter}:${recipient}`); if (!item) throw new Error('Missing exact RSO5 delegation'); return read(archiveFd, item.bytes, item.offset); }); },
    getCheckpoint(head: string) { return meter(() => { usable(); const checkpoint = checkpoints.get(head); if (!checkpoint) throw new Error('Missing exact RSO5 checkpoint'); return checkpoint; }); },
    checkpointLog() { return meter(() => committedCheckpoints()); },
    listDelegations() { return meter(() => [...delegations.values()].map(item => item.delegation)); },
    frameStatus(identity: Rso5FrameIdentity) { usable(); const frame = frames.get(`${identity.scopeId}:${identity.proofId}`); if (!frame || frame.digest !== identity.frameDigest || frame.bytes !== identity.frameBytes || frame.metadata.kind !== identity.kind) throw new Error('Missing exact RSO5 frame'); return { digest: frame.digest, bytes: frame.bytes, kind: frame.metadata.kind }; },
    delegationStatus(proposal: string, exporter: string, recipient: string) { usable(); const item = delegations.get(`${proposal}:${exporter}:${recipient}`); if (!item) throw new Error('Missing exact RSO5 delegation'); return { digest: item.digest, bytes: item.bytes }; },
    checkpointStatus(head: string) { usable(); const item = checkpoints.get(head); if (!item) throw new Error('Missing exact RSO5 checkpoint'); return { digest: item.head, bytes: item.bytes.length, sequence: item.sequence }; },
    references(ids: string[]) { return meter(() => ids.map(id => { const matches = [...frames.values()].filter(frame => frame.metadata.proofId === id); if (matches.length !== 1) throw new Error('Ambiguous/missing RSO5 proof reference'); const frame = matches[0]; return { scopeId: frame.metadata.scopeId, proofId: id, kind: frame.metadata.kind, frameDigest: frame.digest, frameBytes: frame.bytes }; })); },
    proofKind(id: string) { const matches = [...frames.values()].filter(frame => frame.metadata.proofId === id); if (matches.length !== 1) throw new Error('Ambiguous/missing RSO5 proof kind'); return matches[0].metadata.kind; },
    ids() { return meter(() => [...new Set([...frames.values()].map(frame => frame.metadata.proofId))]); },
    read: readImage, write,
    assertImageSize(region: 'state' | 'suffix' | 'pending', bytes: number) { usable(); const capacity = region === 'state' ? owner!.L : region === 'suffix' ? owner!.D : owner!.P; if (bytes + 28 > capacity) throw new Error('RSO5 prospective image exceeds partition'); },
    usage() { return meter(() => ({ proofCounts: structuredClone(consumed), archiveBytes: archiveUsed, archiveMaximum: owner!.C, checkpointBytes: checkpointUsed, checkpointMaximum: owner!.D, currentHead, currentSequence, failedBytes: failedSize() })); },
    close() { if (!closed) { closed = true; try { fsyncSync(archiveFd); fsyncSync(checkpointFd); closeSync(archiveFd); closeSync(checkpointFd); } finally { key.fill(0); release(); } } },
  };
}
export type SustainableRso5Arena = ReturnType<typeof openSustainableRso5Arena>;
