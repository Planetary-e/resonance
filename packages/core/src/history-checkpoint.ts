/** Experimental admission-history storage format. Signatures do not establish freshness. */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { sign, type SigningKeyPair } from './crypto.js';
import { verifyHistorySignature } from './history-signature.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from './history-continuation.js';

export interface HistoryCheckpointContext {
  version: 1;
  role: 'relay-admission-spends' | 'policy-observer' | 'admission-issuer';
  historyId: string;
  owner: string;
  authority: string;
  policyDigest: string;
  /** Independently pinned infrastructure keys, in lexical order. No discovery hints. */
  members: string[];
  quorum: 4;
}
export interface HistoryCheckpointHeader {
  version: 1;
  kind: 'checkpoint' | 'delta';
  contextId: string;
  generation: number;
  sequence: number;
  previous: string | null;
  /** Owner-signed space for one next complete checkpoint on an unfrozen replica.
   * Absent on historical envelopes and the complete checkpoint consuming it. */
  checkpointReserveBytes?: number;
}
export interface HistoryEncryptedEnvelope extends HistoryCheckpointHeader {
  nonce: string;
  ciphertext: string;
  tag: string;
  signature: string;
}
export type HistoryCheckpointEnvelope = HistoryEncryptedEnvelope | HistoryContinuationRoot;
export interface HistoryFreeze {
  version: 1;
  kind: 'history-freeze';
  contextId: string;
  generation: number;
  nextGeneration: number;
  challenge: string;
  signature: string;
}
export const HISTORY_CHECKPOINT_MAX_PAYLOAD = 8 * 1024 * 1024;
export const HISTORY_DELTA_MAX_PAYLOAD = 64 * 1024;
export const HISTORY_ENVELOPE_MAX_BYTES = Math.ceil(HISTORY_CHECKPOINT_MAX_PAYLOAD * 4 / 3) + 2048;
const DOMAIN = 'resonance:admission-history-checkpoint:v1';
const contextFields = ['version', 'role', 'historyId', 'owner', 'authority', 'policyDigest', 'members', 'quorum'];
const headerFields = ['version', 'kind', 'contextId', 'generation', 'sequence', 'previous'];
export const historyDigest = (bytes: Uint8Array | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const isHistoryDigest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function parseHistoryCheckpointContext(value: unknown): HistoryCheckpointContext {
  if (!exactWitnessFields(value, contextFields) || value.version !== 1 || !['relay-admission-spends', 'policy-observer', 'admission-issuer'].includes(value.role as string)
    || !witnessBytes(value.historyId, 32) || !witnessBytes(value.owner, 32) || !witnessBytes(value.authority, 32)
    || !isHistoryDigest(value.policyDigest) || value.quorum !== 4 || !Array.isArray(value.members)
    || value.members.length !== 5 || !value.members.every(v => witnessBytes(v, 32))
    || new Set(value.members).size !== 5 || value.members.some((v, i, a) => i > 0 && a[i - 1] >= v)) {
    throw new Error('Invalid pinned history context');
  }
  return { version: 1, role: value.role as HistoryCheckpointContext['role'], historyId: value.historyId, owner: value.owner,
    authority: value.authority, policyDigest: value.policyDigest, members: [...value.members], quorum: 4 };
}
export function historyCheckpointContextId(context: HistoryCheckpointContext): string {
  return historyDigest(`${DOMAIN}:context\n${JSON.stringify(parseHistoryCheckpointContext(context))}`);
}
function header(h: HistoryCheckpointHeader): HistoryCheckpointHeader {
  const reserved = Object.hasOwn(h, 'checkpointReserveBytes');
  if (h.version !== 1 || !['checkpoint', 'delta'].includes(h.kind) || !isHistoryDigest(h.contextId)
    || !integer(h.generation) || !integer(h.sequence)
    || (reserved && (!integer(h.checkpointReserveBytes) || h.checkpointReserveBytes < 1
      || h.checkpointReserveBytes > HISTORY_ENVELOPE_MAX_BYTES || h.sequence === 0))
    || (h.sequence === 0 ? h.kind !== 'checkpoint' || h.generation !== 0 || h.previous !== null : !isHistoryDigest(h.previous))) {
    throw new Error('Invalid history envelope header');
  }
  return { version: 1, kind: h.kind, contextId: h.contextId, generation: h.generation,
    sequence: h.sequence, previous: h.previous, ...(reserved ? { checkpointReserveBytes: h.checkpointReserveBytes } : {}) };
}
const aad = (h: HistoryCheckpointHeader) => Buffer.from(`${DOMAIN}:payload\n${JSON.stringify(header(h))}`);
const signedBytes = (h: HistoryEncryptedEnvelope) => Buffer.from(`${DOMAIN}:envelope\n${JSON.stringify([
  header(h), h.nonce, h.ciphertext, h.tag,
])}`);
function encryptionKey(key: Uint8Array, contextId: string): Buffer {
  if (key.length !== 32) throw new Error('History encryption requires a 32-byte owner key');
  return Buffer.from(hkdfSync('sha256', key, Buffer.from(contextId), `${DOMAIN}:encryption`, 32));
}

/** Exact JSON wire size without allocating/encrypting a payload. AES-GCM keeps
 * plaintext length; base64url has no padding and these fields are fixed width. */
export function historyCheckpointEnvelopeByteLength(options: {
  context: HistoryCheckpointContext; header: Omit<HistoryCheckpointHeader, 'version' | 'contextId'>; plaintextBytes: number;
}): number {
  const h = header({ ...options.header, version: 1, contextId: historyCheckpointContextId(options.context) });
  const limit = h.kind === 'checkpoint' ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD;
  if (!Number.isSafeInteger(options.plaintextBytes) || options.plaintextBytes < 1 || options.plaintextBytes > limit) {
    throw new Error('History payload capacity exceeded');
  }
  return Buffer.byteLength(JSON.stringify({ ...h, nonce: '', ciphertext: '', tag: '', signature: '' }))
    + 16 + Math.ceil(options.plaintextBytes * 4 / 3) + 22 + 86;
}

/** Coarse public resource ceiling, avoiding an exact plaintext-state-size field. */
export function historyCheckpointReserveBucket(envelopeBytes: number): number {
  if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes < 1 || envelopeBytes > HISTORY_ENVELOPE_MAX_BYTES) {
    throw new Error('Invalid checkpoint reservation size');
  }
  return Math.min(HISTORY_ENVELOPE_MAX_BYTES, 2 ** Math.ceil(Math.log2(Math.max(4096, envelopeBytes))));
}

/** Caller retains the exact returned envelope for retries; re-encryption creates a different chain entry. */
export function sealHistoryCheckpoint(options: {
  context: HistoryCheckpointContext; header: Omit<HistoryCheckpointHeader, 'version' | 'contextId'>;
  plaintext: Uint8Array; encryptionKey: Uint8Array; signingKey: SigningKeyPair;
}): HistoryEncryptedEnvelope {
  const context = parseHistoryCheckpointContext(options.context);
  const h = header({ ...options.header, version: 1, contextId: historyCheckpointContextId(context) });
  const limit = h.kind === 'checkpoint' ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD;
  if (!options.plaintext.length || options.plaintext.length > limit) throw new Error('History payload capacity exceeded');
  const signer = copyAdmissionSigningKey(options.signingKey);
  let key: Buffer | undefined;
  try {
    if (Buffer.from(signer.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history owner');
    key = encryptionKey(options.encryptionKey, h.contextId);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(h));
    const unsigned = { ...h, nonce: nonce.toString('base64url'),
      ciphertext: Buffer.concat([cipher.update(options.plaintext), cipher.final()]).toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'), signature: '' };
    return { ...unsigned, signature: Buffer.from(sign(signedBytes(unsigned), signer.secretKey)).toString('base64url') };
  } finally { key?.fill(0); signer.secretKey.fill(0); }
}

/** Replicas authenticate ciphertext without receiving the owner's decryption key. */
export function parseHistoryCheckpointEnvelope(value: unknown, context: HistoryCheckpointContext): HistoryCheckpointEnvelope {
  if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'continuation') {
    return parseHistoryContinuationRoot(value, context);
  }
  const reserved = value !== null && typeof value === 'object' && Object.hasOwn(value, 'checkpointReserveBytes');
  if (!exactWitnessFields(value, [...headerFields, 'nonce', 'ciphertext', 'tag', 'signature', ...(reserved ? ['checkpointReserveBytes'] : [])])) throw new Error('Invalid history envelope');
  const h = header(value as unknown as HistoryCheckpointHeader);
  const c = parseHistoryCheckpointContext(context);
  const limit = h.kind === 'checkpoint' ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD;
  if (h.contextId !== historyCheckpointContextId(c) || !witnessBytes(value.nonce, 12)
    || !witnessBytes(value.tag, 16) || !witnessBytes(value.signature, 64)
    || typeof value.ciphertext !== 'string' || !value.ciphertext.length
    || value.ciphertext.length > Math.ceil(limit * 4 / 3)) throw new Error('Invalid history envelope binding or size');
  const ciphertext = Buffer.from(value.ciphertext, 'base64url');
  if (ciphertext.length > limit || ciphertext.toString('base64url') !== value.ciphertext) throw new Error('Invalid history ciphertext');
  const envelope = { ...h, nonce: value.nonce, ciphertext: value.ciphertext, tag: value.tag, signature: value.signature };
  if (!verifyHistorySignature(signedBytes(envelope), Buffer.from(envelope.signature, 'base64url'), Buffer.from(c.owner, 'base64url'))) {
    throw new Error('Invalid history owner signature');
  }
  return envelope;
}
export function historyCheckpointEnvelopeId(envelope: HistoryCheckpointEnvelope): string {
  if (envelope.kind === 'continuation') return historyContinuationRootId(envelope);
  return historyDigest(Buffer.concat([signedBytes(envelope), Buffer.from(`\n${envelope.signature}`)]));
}
/** Application-specific snapshot/delta validation is still required before restoring a live role. */
export function openHistoryCheckpoint(value: unknown, context: HistoryCheckpointContext, ownerKey: Uint8Array): Buffer {
  const envelope = parseHistoryCheckpointEnvelope(value, context);
  if (envelope.kind === 'continuation') throw new Error('A continuation has no standalone snapshot; retain and traverse its predecessor history');
  const key = encryptionKey(ownerKey, envelope.contextId);
  let partial: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
    decipher.setAAD(aad(envelope)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    partial = decipher.update(Buffer.from(envelope.ciphertext, 'base64url'));
    return Buffer.concat([partial, decipher.final()]);
  } finally { partial?.fill(0); key.fill(0); }
}
const freezeFields = ['version', 'kind', 'contextId', 'generation', 'nextGeneration', 'challenge'];
const freezeBytes = (f: Omit<HistoryFreeze, 'signature'>) => Buffer.from(`${DOMAIN}:freeze\n${JSON.stringify([
  f.version, f.kind, f.contextId, f.generation, f.nextGeneration, f.challenge,
])}`);
export function createHistoryFreeze(context: HistoryCheckpointContext, generation: number, nextGeneration: number,
  challenge: string, signingKey: SigningKeyPair): HistoryFreeze {
  const signer = copyAdmissionSigningKey(signingKey);
  try {
    if (Buffer.from(signer.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history owner');
    const body = { version: 1 as const, kind: 'history-freeze' as const,
      contextId: historyCheckpointContextId(context), generation, nextGeneration, challenge };
    return parseHistoryFreeze({ ...body, signature: Buffer.from(sign(freezeBytes(body), signer.secretKey)).toString('base64url') }, context);
  } finally { signer.secretKey.fill(0); }
}
export function parseHistoryFreeze(value: unknown, context: HistoryCheckpointContext): HistoryFreeze {
  if (!exactWitnessFields(value, [...freezeFields, 'signature']) || value.version !== 1 || value.kind !== 'history-freeze'
    || value.contextId !== historyCheckpointContextId(context) || !integer(value.generation)
    || !integer(value.nextGeneration) || value.nextGeneration <= value.generation
    || !witnessBytes(value.challenge, 32) || !witnessBytes(value.signature, 64)) throw new Error('Invalid history freeze');
  const f: HistoryFreeze = { version: 1, kind: value.kind, contextId: value.contextId as string,
    generation: value.generation, nextGeneration: value.nextGeneration, challenge: value.challenge, signature: value.signature };
  if (!verifyHistorySignature(freezeBytes(f), Buffer.from(f.signature, 'base64url'), Buffer.from(context.owner, 'base64url'))) {
    throw new Error('Invalid history freeze signature');
  }
  return f;
}
