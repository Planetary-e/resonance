import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { sign, verify, type SigningKeyPair } from '@resonance/core';
import type { RecoveryProofKind } from './sustainable-recovery-manifest.js';
import { SUSTAINABLE_RECOVERY_LIMITS } from './sustainable-recovery-manifest.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryView, withSustainableRecoveryWork } from './sustainable-recovery-work.js';

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const FRAME_OVERHEAD = 265;
const CHECKPOINT_HEADER = 216;
const CHECKPOINT_ENTRY = 101;
const ZERO_HEAD = `sha256:${'0'.repeat(64)}`;
const kinds: RecoveryProofKind[] = ['original', 'frame', 'policy', 'activation'];
const publicKey = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
export const rso5Digest = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const RSO5_ZERO_HEAD = ZERO_HEAD;

export interface Rso5OriginalBinding { genesis: string; configuration: string; context: string }
export interface Rso5FrameIdentity { scopeId: string; proofId: string; kind: RecoveryProofKind; frameDigest: string; frameBytes: number }
export interface Rso5FrameMetadata extends Rso5FrameIdentity { originalOwner: string; scopeKeyVersion: number }
export interface Rso5ScopeKeyEntry { scopeId: string; scopeKeyVersion: number; scopeKey: Uint8Array }
export interface Rso5RecipientKeyMaterial { privateKey: CryptoKey; publicKey: string; keyId: string }
export interface Rso5RecipientEnrollment { version: 5; kind: 'rso5-recipient-key'; owner: string; role: string; genesis: string; context: string; keyVersion: 1; publicKey: string; keyId: string; signature: string }
export interface Rso5Delegation { bytes: Buffer; digest: string; proposal: string; exporter: string; recipient: string; wrappingKeyId: string; entryCount: number }
export interface Rso5CheckpointEntry extends Rso5FrameIdentity {}
export interface Rso5Checkpoint { bytes: Buffer; head: string; sequence: number; previousHead: string; configuration: string; signer: string; entries: Rso5CheckpointEntry[] }

function meter<T>(work: () => T): T { return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, work); }
function digestBytes(value: string): Buffer {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Invalid RSO5 digest');
  return sustainableRecoveryBytes(value.slice(7), 'hex', 'V');
}
function keyBytes(value: string, length = 32): Buffer {
  const bytes = sustainableRecoveryBytes(value, 'base64url', 'V');
  if (bytes.length !== length) throw new Error('Invalid RSO5 key length');
  return bytes;
}
function base64(value: Uint8Array): string {
  const text = Buffer.from(value).toString('base64url'); chargeSustainableRecoveryWork(Buffer.byteLength(text), 'V', 'base64'); return text;
}
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }
function validKey(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
function validSignature(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value); }
function validP256(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{87}$/.test(value); }
function exactKeys(value: object, expected: string): boolean { return Object.keys(value).sort().join(',') === expected; }
function scopeAad(kind: RecoveryProofKind, version: number, length: number, scopeId: string, proofId: string, owner: string): Buffer {
  return sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:frame:v1\n', 'utf8', 'V'),
    sustainableRecoveryBytes(Uint8Array.of(kind === 'original' ? 0 : kind === 'frame' ? 1 : kind === 'policy' ? 2 : 3)),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(version); return b; })(), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(length); return b; })(), digestBytes(scopeId), digestBytes(proofId), keyBytes(owner)], 'V');
}
export function rso5ScopeId(original: Rso5OriginalBinding, owner: string): string {
  return meter(() => rso5Digest(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:scope:v1\n', 'utf8', 'V'), digestBytes(original.genesis), digestBytes(original.configuration), digestBytes(original.context), keyBytes(owner)], 'V')));
}
export function rso5FrameIdentity(frame: Rso5FrameMetadata): Rso5FrameIdentity {
  return { scopeId: frame.scopeId, proofId: frame.proofId, kind: frame.kind, frameDigest: frame.frameDigest, frameBytes: frame.frameBytes };
}

export function createRso5Frame(options: { plaintext: Uint8Array; kind: RecoveryProofKind; original: Rso5OriginalBinding; scopeKeyVersion: number; scopeKey: Uint8Array; signingKey: SigningKeyPair }): { frame: Buffer; metadata: Rso5FrameMetadata; dek: Buffer } {
  return meter(() => {
    if (!kinds.includes(options.kind) || !Number.isSafeInteger(options.scopeKeyVersion) || options.scopeKeyVersion < 0 || options.scopeKeyVersion > 255 || options.scopeKey.length !== 32) throw new Error('Invalid RSO5 frame input');
    const owner = publicKey(options.signingKey), scopeId = rso5ScopeId(options.original, owner), plaintext = sustainableRecoveryView(options.plaintext), proofId = rso5Digest(plaintext);
    const dek = randomBytes(32); chargeSustainableRecoveryWork(dek.length, 'V', 'allocate');
    try {
      const wrappedNonce = randomBytes(12), wrap = createCipheriv('aes-256-gcm', options.scopeKey, wrappedNonce);
      wrap.setAAD(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:dek-wrap:v1\n', 'utf8', 'V'), digestBytes(scopeId), sustainableRecoveryBytes(Uint8Array.of(options.scopeKeyVersion))], 'V'));
      const wrappedDek = sustainableRecoveryConcat([wrap.update(dek), wrap.final()], 'V', 'encrypt'), wrappedTag = wrap.getAuthTag();
      const plaintextNonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', dek, plaintextNonce);
      cipher.setAAD(scopeAad(options.kind, options.scopeKeyVersion, plaintext.length + 28, scopeId, proofId, owner));
      const ciphertext = sustainableRecoveryConcat([cipher.update(plaintext), cipher.final()], 'V', 'encrypt'), tag = cipher.getAuthTag();
      const bodyParts = [sustainableRecoveryBytes('RSO5F001', 'ascii', 'V'), sustainableRecoveryBytes(Uint8Array.of(kinds.indexOf(options.kind))),
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(options.scopeKeyVersion); return b; })(), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ciphertext.length + 28); return b; })(),
        digestBytes(scopeId), digestBytes(proofId), keyBytes(owner), wrappedNonce, wrappedDek, wrappedTag, plaintextNonce, ciphertext, tag];
      const body = sustainableRecoveryConcat(bodyParts, 'V');
      if (body.length !== plaintext.length + FRAME_OVERHEAD - 64) throw new Error(`RSO5 frame length mismatch: actual=${body.length} expected=${plaintext.length + FRAME_OVERHEAD - 64} fields=${JSON.stringify(bodyParts.map(part => part.length))}`);
      const frame = sustainableRecoveryConcat([body, sign(body, options.signingKey.secretKey)], 'V');
      return { frame, dek, metadata: { scopeId, proofId, kind: options.kind, frameDigest: rso5Digest(frame), frameBytes: frame.length, originalOwner: owner, scopeKeyVersion: options.scopeKeyVersion } };
    } catch (error) { dek.fill(0); throw error; }
  });
}

export function parseRso5Frame(value: Uint8Array): Rso5FrameMetadata & { wrappedNonce: Buffer; wrappedDek: Buffer; wrappedTag: Buffer; plaintextNonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  return meter(() => {
    const data = sustainableRecoveryView(value);
    if (data.length < FRAME_OVERHEAD || data.toString('ascii', 0, 8) !== 'RSO5F001') throw new Error(`Invalid RSO5 frame version: length=${data.length} magic=${data.toString('ascii', 0, 8)}`);
    const kind = kinds[data[8]], scopeKeyVersion = data.readUInt32BE(9), ciphertextLength = data.readUInt32BE(13);
    if (!kind || data.length !== FRAME_OVERHEAD - 28 + ciphertextLength) throw new Error('Invalid RSO5 frame length/kind');
    const scopeId = `sha256:${data.subarray(17, 49).toString('hex')}`, proofId = `sha256:${data.subarray(49, 81).toString('hex')}`;
    const originalOwner = data.subarray(81, 113).toString('base64url'), signatureOffset = data.length - 64;
    if (!verify(data.subarray(0, signatureOffset), data.subarray(signatureOffset), data.subarray(81, 113))) throw new Error('Unauthenticated RSO5 frame');
    return { scopeId, proofId, kind, scopeKeyVersion, originalOwner, frameDigest: rso5Digest(data), frameBytes: data.length,
      wrappedNonce: data.subarray(113, 125), wrappedDek: data.subarray(125, 157), wrappedTag: data.subarray(157, 173), plaintextNonce: data.subarray(173, 185), ciphertext: data.subarray(185, signatureOffset - 16), tag: data.subarray(signatureOffset - 16, signatureOffset) };
  });
}

export function openRso5Frame(options: { frame: Uint8Array; scopeId: string; scopeKeyVersion: number; scopeKey: Uint8Array }): Buffer {
  return meter(() => {
    const frame = parseRso5Frame(options.frame);
    if (frame.scopeId !== options.scopeId || frame.scopeKeyVersion !== options.scopeKeyVersion || options.scopeKey.length !== 32) throw new Error('RSO5 scope/key version differs');
    let dek: Buffer | undefined;
    try {
      const unwrap = createDecipheriv('aes-256-gcm', options.scopeKey, frame.wrappedNonce);
      unwrap.setAAD(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:dek-wrap:v1\n', 'utf8', 'V'), digestBytes(frame.scopeId), sustainableRecoveryBytes(Uint8Array.of(frame.scopeKeyVersion))], 'V'));
      unwrap.setAuthTag(frame.wrappedTag); dek = sustainableRecoveryConcat([unwrap.update(frame.wrappedDek), unwrap.final()], 'V', 'decrypt');
      if (dek.length !== 32) throw new Error('Invalid RSO5 DEK');
      const decipher = createDecipheriv('aes-256-gcm', dek, frame.plaintextNonce);
      decipher.setAAD(scopeAad(frame.kind, frame.scopeKeyVersion, frame.ciphertext.length + 28, frame.scopeId, frame.proofId, frame.originalOwner));
      decipher.setAuthTag(frame.tag);
      const plaintext = sustainableRecoveryConcat([decipher.update(frame.ciphertext), decipher.final()], 'V', 'decrypt');
      if (rso5Digest(plaintext) !== frame.proofId) throw new Error('RSO5 plaintext identity differs');
      return plaintext;
    } finally { dek?.fill(0); }
  });
}

export async function generateRso5RecipientKey(): Promise<Rso5RecipientKeyMaterial> {
  return meter(async () => {
    const keys = await suite.kem.generateKeyPair(), bytes = new Uint8Array(await suite.kem.serializePublicKey(keys.publicKey));
    chargeSustainableRecoveryWork(bytes.length, 'V', 'serialize'); return { privateKey: keys.privateKey, publicKey: base64(bytes), keyId: rso5Digest(bytes) };
  });
}
export function createRso5RecipientEnrollment(options: { material: Rso5RecipientKeyMaterial; signingKey: SigningKeyPair; role: string; genesis: string; context: string }): Rso5RecipientEnrollment {
  return meter(() => {
    if (!options.role || options.role.length > 64 || !validDigest(options.genesis) || !validDigest(options.context)) throw new Error('Invalid RSO5 enrollment input');
    const body = { version: 5 as const, kind: 'rso5-recipient-key' as const, owner: publicKey(options.signingKey), role: options.role,
      genesis: options.genesis, context: options.context, keyVersion: 1 as const, publicKey: options.material.publicKey, keyId: options.material.keyId };
    return { ...body, signature: base64(sign(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:enrollment:v1\n', 'utf8', 'V'), sustainableRecoveryBytes(JSON.stringify(body), 'utf8', 'V')], 'V'), options.signingKey.secretKey)) };
  });
}
export function verifyRso5RecipientEnrollment(value: unknown, expected?: { owner?: string; role?: string; genesis?: string; context?: string }): Rso5RecipientEnrollment {
  return meter(() => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RSO5 enrollment');
    const enrollment = value as Rso5RecipientEnrollment;
    if (!exactKeys(enrollment, 'context,genesis,keyId,keyVersion,kind,owner,publicKey,role,signature,version') || enrollment.version !== 5 || enrollment.kind !== 'rso5-recipient-key'
      || enrollment.keyVersion !== 1 || !validKey(enrollment.owner) || !validP256(enrollment.publicKey) || !validSignature(enrollment.signature)
      || typeof enrollment.role !== 'string' || !enrollment.role || enrollment.role.length > 64 || !validDigest(enrollment.genesis) || !validDigest(enrollment.context) || !validDigest(enrollment.keyId)
      || (expected?.owner !== undefined && enrollment.owner !== expected.owner) || (expected?.role !== undefined && enrollment.role !== expected.role)
      || (expected?.genesis !== undefined && enrollment.genesis !== expected.genesis) || (expected?.context !== undefined && enrollment.context !== expected.context)) throw new Error('Invalid RSO5 enrollment');
    const publicBytes = keyBytes(enrollment.publicKey, 65); if (publicBytes[0] !== 4 || rso5Digest(publicBytes) !== enrollment.keyId) throw new Error('Invalid RSO5 wrapping key ID');
    const { signature, ...body } = enrollment;
    if (!verify(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:enrollment:v1\n', 'utf8', 'V'), sustainableRecoveryBytes(JSON.stringify(body), 'utf8', 'V')], 'V'), keyBytes(signature, 64), keyBytes(enrollment.owner))) throw new Error('Unauthenticated RSO5 enrollment');
    return enrollment;
  });
}

function delegationInfo(proposal: string, exporter: string, recipient: string, wrappingKeyId: string): Buffer {
  return sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:delegation-hpke:v1\n', 'utf8', 'V'), digestBytes(proposal), keyBytes(exporter), keyBytes(recipient), digestBytes(wrappingKeyId)], 'V');
}
export async function createRso5Delegation(options: { proposal: string; exporter: SigningKeyPair; enrollment: Rso5RecipientEnrollment; entries: Rso5ScopeKeyEntry[] }): Promise<Rso5Delegation> {
  return meter(async () => {
    const exporter = publicKey(options.exporter), enrollment = verifyRso5RecipientEnrollment(options.enrollment);
    if (!validDigest(options.proposal) || options.entries.length < 1 || options.entries.length > 20) throw new Error('Invalid RSO5 delegation input');
    const plaintextParts: Uint8Array[] = [], seen = new Set<string>();
    for (const entry of options.entries) {
      if (!validDigest(entry.scopeId) || !Number.isSafeInteger(entry.scopeKeyVersion) || entry.scopeKeyVersion < 0 || entry.scopeKeyVersion > 255 || entry.scopeKey.length !== 32) throw new Error('Invalid RSO5 scope key entry');
      const identity = `${entry.scopeId}:${entry.scopeKeyVersion}`; if (seen.has(identity)) throw new Error('Duplicate RSO5 scope key version'); seen.add(identity);
      plaintextParts.push(digestBytes(entry.scopeId), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(entry.scopeKeyVersion); return b; })(), sustainableRecoveryBytes(entry.scopeKey, undefined, 'V'));
    }
    const plaintext = sustainableRecoveryConcat(plaintextParts, 'V'), recipientPublicKey = await suite.kem.deserializePublicKey(keyBytes(enrollment.publicKey, 65));
    const sender = await suite.createSenderContext({ recipientPublicKey, info: delegationInfo(options.proposal, exporter, enrollment.owner, enrollment.keyId) });
    const ciphertext = new Uint8Array(await sender.seal(plaintext, delegationInfo(options.proposal, exporter, enrollment.owner, enrollment.keyId)));
    chargeSustainableRecoveryWork(ciphertext.length, 'V', 'encrypt'); plaintext.fill(0);
    const body = sustainableRecoveryConcat([sustainableRecoveryBytes('RSO5D001', 'ascii', 'V'), digestBytes(options.proposal), keyBytes(exporter), keyBytes(enrollment.owner), digestBytes(enrollment.keyId),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(options.entries.length); return b; })(), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ciphertext.length); return b; })(), Buffer.alloc(8), new Uint8Array(sender.enc), ciphertext], 'V');
    const bytes = sustainableRecoveryConcat([body, sign(body, options.exporter.secretKey)], 'V');
    return { bytes, digest: rso5Digest(bytes), proposal: options.proposal, exporter, recipient: enrollment.owner, wrappingKeyId: enrollment.keyId, entryCount: options.entries.length };
  });
}

export function parseRso5Delegation(value: Uint8Array): Rso5Delegation & { ciphertext: Buffer; enc: Buffer } {
  return meter(() => {
    const data = sustainableRecoveryView(value);
    if (data.length < 297 || data.toString('ascii', 0, 8) !== 'RSO5D001') throw new Error('Invalid RSO5 delegation version');
    const proposal = `sha256:${data.subarray(8, 40).toString('hex')}`, exporter = data.subarray(40, 72).toString('base64url'), recipient = data.subarray(72, 104).toString('base64url');
    const wrappingKeyId = `sha256:${data.subarray(104, 136).toString('hex')}`, entryCount = data.readUInt32BE(136), ciphertextLength = data.readUInt32BE(140);
    if (data.subarray(144, 152).some(byte => byte !== 0) || entryCount < 1 || entryCount > 20 || data.length !== 281 + ciphertextLength) throw new Error('Invalid RSO5 delegation length');
    const signatureOffset = data.length - 64; if (!verify(data.subarray(0, signatureOffset), data.subarray(signatureOffset), data.subarray(40, 72))) throw new Error('Unauthenticated RSO5 delegation');
    return { bytes: data, digest: rso5Digest(data), proposal, exporter, recipient, wrappingKeyId, entryCount, enc: data.subarray(152, 217), ciphertext: data.subarray(217, signatureOffset) };
  });
}

export async function openRso5Delegation(options: { delegation: Uint8Array; material: Rso5RecipientKeyMaterial; enrollment: Rso5RecipientEnrollment }): Promise<Rso5ScopeKeyEntry[]> {
  return meter(async () => {
    const delegation = parseRso5Delegation(options.delegation), enrollment = verifyRso5RecipientEnrollment(options.enrollment, { owner: delegation.recipient });
    if (delegation.wrappingKeyId !== enrollment.keyId || enrollment.publicKey !== options.material.publicKey || enrollment.keyId !== options.material.keyId) throw new Error('RSO5 recipient key differs');
    const recipient = await suite.createRecipientContext({ recipientKey: options.material.privateKey, enc: delegation.enc, info: delegationInfo(delegation.proposal, delegation.exporter, delegation.recipient, delegation.wrappingKeyId) });
    const plaintext = sustainableRecoveryBytes(new Uint8Array(await recipient.open(delegation.ciphertext, delegationInfo(delegation.proposal, delegation.exporter, delegation.recipient, delegation.wrappingKeyId))), undefined, 'V', 'decrypt');
    try {
      if (plaintext.length !== delegation.entryCount * 68) throw new Error('RSO5 delegation plaintext length differs');
      const entries: Rso5ScopeKeyEntry[] = [], seen = new Set<string>();
      for (let index = 0; index < delegation.entryCount; index++) {
        const offset = index * 68, scopeId = `sha256:${plaintext.subarray(offset, offset + 32).toString('hex')}`, scopeKeyVersion = plaintext.readUInt32BE(offset + 32);
        const identity = `${scopeId}:${scopeKeyVersion}`; if (seen.has(identity)) throw new Error(`Duplicate RSO5 scope key: ${identity}`); seen.add(identity);
        entries.push({ scopeId, scopeKeyVersion, scopeKey: sustainableRecoveryBytes(plaintext.subarray(offset + 36, offset + 68), undefined, 'V') });
      }
      return entries;
    } finally { plaintext.fill(0); }
  });
}

export function createRso5Checkpoint(options: { sequence: number; previousHead: string; configuration: string; entries: Rso5CheckpointEntry[]; signingKey: SigningKeyPair }): Rso5Checkpoint {
  return meter(() => {
    if (!Number.isSafeInteger(options.sequence) || options.sequence < 0 || !validDigest(options.previousHead) || !validDigest(options.configuration) || options.entries.length > 72) throw new Error('Invalid RSO5 checkpoint input');
    const signer = publicKey(options.signingKey), parts: Uint8Array[] = [], seen = new Set<string>();
    for (const entry of options.entries) {
      if (!validDigest(entry.scopeId) || !validDigest(entry.proofId) || !validDigest(entry.frameDigest) || !kinds.includes(entry.kind)
        || !Number.isSafeInteger(entry.frameBytes) || entry.frameBytes < FRAME_OVERHEAD) throw new Error('Invalid RSO5 checkpoint entry');
      if (seen.has(entry.frameDigest)) throw new Error('Duplicate RSO5 checkpoint frame'); seen.add(entry.frameDigest);
      parts.push(digestBytes(entry.scopeId), digestBytes(entry.proofId), digestBytes(entry.frameDigest), sustainableRecoveryBytes(Uint8Array.of(kinds.indexOf(entry.kind))), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(entry.frameBytes); return b; })());
    }
    const entryBytes = sustainableRecoveryConcat(parts, 'V'), head = rso5Digest(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:checkpoint-head:v1\n', 'utf8', 'V'),
      (() => { const b = Buffer.alloc(12); b.writeUInt32BE(1, 0); b.writeBigUInt64BE(BigInt(options.sequence), 4); return b; })(), digestBytes(options.previousHead), digestBytes(options.configuration), entryBytes], 'V'));
    const body = sustainableRecoveryConcat([sustainableRecoveryBytes('RSO5H001', 'ascii', 'V'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1); return b; })(),
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(options.sequence)); return b; })(), digestBytes(options.previousHead),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(options.entries.length); return b; })(), digestBytes(head), keyBytes(signer), digestBytes(options.configuration), entryBytes], 'V');
    if (body.length !== CHECKPOINT_HEADER - 64 + entryBytes.length) throw new Error('RSO5 checkpoint length mismatch');
    const bytes = sustainableRecoveryConcat([body, sign(body, options.signingKey.secretKey)], 'V');
    return { bytes, head, sequence: options.sequence, previousHead: options.previousHead, configuration: options.configuration, signer, entries: options.entries.map(entry => ({ ...entry })) };
  });
}

export function parseRso5Checkpoint(value: Uint8Array): Rso5Checkpoint {
  return meter(() => {
    const data = sustainableRecoveryView(value);
    if (data.length < CHECKPOINT_HEADER || data.toString('ascii', 0, 8) !== 'RSO5H001' || data.readUInt32BE(8) !== 1) throw new Error('Invalid RSO5 checkpoint version');
    const sequence = Number(data.readBigUInt64BE(12)), previousHead = `sha256:${data.subarray(20, 52).toString('hex')}`, entryCount = data.readUInt32BE(52), expectedHead = `sha256:${data.subarray(56, 88).toString('hex')}`;
    const signer = data.subarray(88, 120).toString('base64url'), configuration = `sha256:${data.subarray(120, 152).toString('hex')}`;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || entryCount > 72 || data.length !== CHECKPOINT_HEADER + entryCount * CHECKPOINT_ENTRY) throw new Error('Invalid RSO5 checkpoint length');
    const entries: Rso5CheckpointEntry[] = [], seen = new Set<string>();
    for (let index = 0; index < entryCount; index++) {
      const offset = CHECKPOINT_HEADER - 64 + index * CHECKPOINT_ENTRY, scopeId = `sha256:${data.subarray(offset, offset + 32).toString('hex')}`, proofId = `sha256:${data.subarray(offset + 32, offset + 64).toString('hex')}`;
      const frameDigest = `sha256:${data.subarray(offset + 64, offset + 96).toString('hex')}`, kind = kinds[data[offset + 96]], frameBytes = data.readUInt32BE(offset + 97);
      if (!kind || frameBytes < FRAME_OVERHEAD || seen.has(frameDigest)) throw new Error('Invalid RSO5 checkpoint entry'); seen.add(frameDigest);
      entries.push({ scopeId, proofId, kind, frameDigest, frameBytes });
    }
    const entryBytes = data.subarray(CHECKPOINT_HEADER - 64, data.length - 64), head = rso5Digest(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:checkpoint-head:v1\n', 'utf8', 'V'),
      (() => { const b = Buffer.alloc(12); b.writeUInt32BE(1, 0); b.writeBigUInt64BE(BigInt(sequence), 4); return b; })(), digestBytes(previousHead), digestBytes(configuration), entryBytes], 'V'));
    if (head !== expectedHead) throw new Error(`RSO5 checkpoint head digest differs: actual=${head} expected=${expectedHead}`);
    if (!verify(data.subarray(0, data.length - 64), data.subarray(data.length - 64), data.subarray(88, 120))) throw new Error('Unauthenticated RSO5 checkpoint signature');
    return { bytes: data, head, sequence, previousHead, configuration, signer, entries };
  });
}

export function assertRso5CurrentDelegation(delegation: Rso5Delegation, expected: { proposal: string; exporter: string; recipient: string; wrappingKeyId: string; scopeKeyVersions: Map<string, number> }): void {
  if (delegation.proposal !== expected.proposal || delegation.exporter !== expected.exporter || delegation.recipient !== expected.recipient || delegation.wrappingKeyId !== expected.wrappingKeyId
    || delegation.entryCount !== expected.scopeKeyVersions.size) throw new Error('Stale or wrong RSO5 delegation');
  const parsed = parseRso5Delegation(delegation.bytes);
  if (parsed.entryCount !== delegation.entryCount) throw new Error('RSO5 delegation entry count differs');
}
