/** Bounded transport of one signed immediate policy successor. Each chunk fits
 * the existing private payload cap; authentication precedes installation. */
import { parseArchivedAdmissionPolicyAdvance, type ArchivedAdmissionPolicyAdvance } from './admission-policy-archive.js';
import { createHash } from 'node:crypto';
import { exactWitnessFields } from './admission-witness.js';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers, type AdmissionPolicyHead, type AdmissionPolicyObservers } from './admission-policy-freshness.js';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES, parseAdmissionPolicyAdvance, sameAdmissionPolicyHead, type AdmissionPolicyAdvance } from './admission-policy-advance.js';

export const ADMISSION_POLICY_CHUNK_TYPE = 'admission_policy_chunk' as const;
export const ADMISSION_POLICY_CHUNK_REPLY_TYPE = 'admission_policy_chunk_reply' as const;
export const ADMISSION_POLICY_CHUNK_BYTES = 64 * 1024;
export const ADMISSION_POLICY_CHUNK_REQUEST_MAX_BYTES = 1024;
export const ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES = 90 * 1024;
export const ADMISSION_POLICY_MAX_CHUNKS = Math.ceil(ADMISSION_POLICY_ADVANCE_MAX_BYTES / ADMISSION_POLICY_CHUNK_BYTES);
export interface AdmissionPolicyChunkRequest {
  version: 1; type: typeof ADMISSION_POLICY_CHUNK_TYPE; contextId: string;
  previous: AdmissionPolicyHead; artifact: string | null; index: number;
}
export interface AdmissionPolicyChunkReply {
  version: 1; type: typeof ADMISSION_POLICY_CHUNK_REPLY_TYPE; contextId: string;
  previous: AdmissionPolicyHead; next: AdmissionPolicyHead; artifact: string;
  bytes: number; count: number; index: number; data: string;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function bounded(value: unknown, maximum: number): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maximum) throw new Error('Policy transfer frame exceeds its bound');
    try { return JSON.parse(value); } catch { throw new Error('Policy transfer frame must be JSON'); }
  }
  const raw = JSON.stringify(value);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) throw new Error('Policy transfer frame exceeds its bound');
  return value;
}
export function parseAdmissionPolicyChunkRequest(value: unknown, context: AdmissionPolicyObservers): AdmissionPolicyChunkRequest {
  const raw = bounded(value, ADMISSION_POLICY_CHUNK_REQUEST_MAX_BYTES), pins = parseAdmissionPolicyObservers(context);
  if (!exactWitnessFields(raw, ['version', 'type', 'contextId', 'previous', 'artifact', 'index']) || raw.version !== 1 || raw.type !== ADMISSION_POLICY_CHUNK_TYPE
    || raw.contextId !== admissionPolicyObserversId(pins) || (raw.artifact !== null && !hash(raw.artifact))
    || !Number.isSafeInteger(raw.index) || (raw.index as number) < 0 || (raw.index as number) >= ADMISSION_POLICY_MAX_CHUNKS
    || raw.artifact === null && raw.index !== 0) throw new Error('Invalid policy chunk request');
  const previous = parseAdmissionPolicyHead(raw.previous);
  if (previous.revision < pins.genesis.revision || previous.revision === pins.genesis.revision && !sameAdmissionPolicyHead(previous, pins.genesis)) throw new Error('Policy transfer predecessor conflicts with genesis');
  return { version: 1, type: ADMISSION_POLICY_CHUNK_TYPE, contextId: raw.contextId as string, previous, artifact: raw.artifact, index: raw.index as number };
}
export function createAdmissionPolicyChunkRequest(context: AdmissionPolicyObservers, previous: AdmissionPolicyHead, artifact: string | null = null, index = 0) {
  return parseAdmissionPolicyChunkRequest({ version: 1, type: ADMISSION_POLICY_CHUNK_TYPE, contextId: admissionPolicyObserversId(context), previous, artifact, index }, context);
}
/** A reply is a bounded untrusted fragment until the complete signed body and
 * commitment pass assembleAdmissionPolicyTransfer. */
export function parseAdmissionPolicyChunkReply(value: unknown, request: AdmissionPolicyChunkRequest, context: AdmissionPolicyObservers): AdmissionPolicyChunkReply {
  const original = parseAdmissionPolicyChunkRequest(request, context), raw = bounded(value, ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES);
  if (!exactWitnessFields(raw, ['version', 'type', 'contextId', 'previous', 'next', 'artifact', 'bytes', 'count', 'index', 'data'])
    || raw.version !== 1 || raw.type !== ADMISSION_POLICY_CHUNK_REPLY_TYPE || raw.contextId !== original.contextId || !hash(raw.artifact)
    || original.artifact !== null && raw.artifact !== original.artifact || raw.index !== original.index
    || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1 || (raw.bytes as number) > ADMISSION_POLICY_ADVANCE_MAX_BYTES
    || raw.count !== Math.ceil((raw.bytes as number) / ADMISSION_POLICY_CHUNK_BYTES) || original.index >= (raw.count as number)
    || typeof raw.data !== 'string') throw new Error('Invalid policy chunk reply');
  const previous = parseAdmissionPolicyHead(raw.previous), next = parseAdmissionPolicyHead(raw.next);
  if (!sameAdmissionPolicyHead(previous, original.previous) || next.revision !== previous.revision + 1) throw new Error('Policy chunk does not extend the requested predecessor');
  const data = Buffer.from(raw.data, 'base64url'), expected = Math.min(ADMISSION_POLICY_CHUNK_BYTES, (raw.bytes as number) - original.index * ADMISSION_POLICY_CHUNK_BYTES);
  if (data.length !== expected || data.toString('base64url') !== raw.data) throw new Error('Policy chunk data has an invalid length or encoding');
  return { version: 1, type: ADMISSION_POLICY_CHUNK_REPLY_TYPE, contextId: original.contextId, previous, next, artifact: raw.artifact,
    bytes: raw.bytes as number, count: raw.count as number, index: original.index, data: raw.data };
}
export async function createAdmissionPolicyTransfer(value: unknown, contextValue: AdmissionPolicyObservers) {
  return createTransfer(value, contextValue, parseAdmissionPolicyAdvance);
}
/** Transfers authenticated signed metadata only; this never grants a resolved install capability. */
export async function createArchivedAdmissionPolicyTransfer(value: unknown, contextValue: AdmissionPolicyObservers) {
  return createTransfer(value, contextValue, parseArchivedAdmissionPolicyAdvance);
}
async function createTransfer(value: unknown, contextValue: AdmissionPolicyObservers,
  parse: (value: unknown, context: AdmissionPolicyObservers) => Promise<ArchivedAdmissionPolicyAdvance>) {
  const context = parseAdmissionPolicyObservers(contextValue), advance = await parse(value, context);
  const encoded = Buffer.from(JSON.stringify(advance)), artifact = digest(encoded), bytes = encoded.length;
  if (bytes > ADMISSION_POLICY_ADVANCE_MAX_BYTES) throw new Error('Policy artifact exceeds its bound');
  return { artifact, bytes, previous: advance.commitment.previous,
    chunk(value: unknown): AdmissionPolicyChunkReply {
      const request = parseAdmissionPolicyChunkRequest(value, context);
      if (!sameAdmissionPolicyHead(request.previous, advance.commitment.previous) || request.artifact !== null && request.artifact !== artifact) throw new Error('Policy artifact differs from request');
      return parseAdmissionPolicyChunkReply({ version: 1, type: ADMISSION_POLICY_CHUNK_REPLY_TYPE, contextId: request.contextId,
        previous: advance.commitment.previous, next: advance.commitment.next, artifact, bytes, count: Math.ceil(bytes / ADMISSION_POLICY_CHUNK_BYTES), index: request.index,
        data: encoded.subarray(request.index * ADMISSION_POLICY_CHUNK_BYTES, (request.index + 1) * ADMISSION_POLICY_CHUNK_BYTES).toString('base64url') }, request, context);
    } };
}
export async function assembleAdmissionPolicyTransfer(values: readonly unknown[], contextValue: AdmissionPolicyObservers, previousValue: AdmissionPolicyHead): Promise<AdmissionPolicyAdvance> {
  return assembleTransfer(values, contextValue, previousValue, parseAdmissionPolicyAdvance);
}
/** Returned metadata must still pass resolved semantic ancestry installation. */
export async function assembleArchivedAdmissionPolicyTransfer(values: readonly unknown[], contextValue: AdmissionPolicyObservers, previousValue: AdmissionPolicyHead): Promise<ArchivedAdmissionPolicyAdvance> {
  return assembleTransfer(values, contextValue, previousValue, parseArchivedAdmissionPolicyAdvance);
}
async function assembleTransfer<T extends ArchivedAdmissionPolicyAdvance>(values: readonly unknown[], contextValue: AdmissionPolicyObservers, previousValue: AdmissionPolicyHead,
  parse: (value: unknown, context: AdmissionPolicyObservers) => Promise<T>): Promise<T> {
  const context = parseAdmissionPolicyObservers(contextValue), previous = parseAdmissionPolicyHead(previousValue);
  if (!Array.isArray(values) || values.length < 1 || values.length > ADMISSION_POLICY_MAX_CHUNKS) throw new Error('Invalid policy transfer chunk count');
  const first = parseAdmissionPolicyChunkReply(values[0], createAdmissionPolicyChunkRequest(context, previous), context);
  if (values.length !== first.count) throw new Error('Policy transfer is incomplete');
  const parts = values.map((value, index) => {
    const part = parseAdmissionPolicyChunkReply(value, createAdmissionPolicyChunkRequest(context, previous, first.artifact, index), context);
    if (part.bytes !== first.bytes || part.count !== first.count || !sameAdmissionPolicyHead(part.next, first.next)) throw new Error('Policy chunks disagree');
    return Buffer.from(part.data, 'base64url');
  });
  const bytes = Buffer.concat(parts, first.bytes);
  if (digest(bytes) !== first.artifact) throw new Error('Policy transfer digest mismatch');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { throw new Error('Policy artifact must be valid UTF-8 JSON'); }
  const advance = await parse(raw, context);
  if (!sameAdmissionPolicyHead(advance.commitment.previous, previous) || !sameAdmissionPolicyHead(advance.commitment.next, first.next)) throw new Error('Signed policy artifact differs from its manifest');
  return advance;
}

/** Transport evidence only. The consumer must resolve original signed ancestry. */
export interface AdmissionPolicyProofCursor { head: AdmissionPolicyHead; policy: import('./admission-policy-archive.js').ArchivedAdmissionPolicy }
export interface AdmissionPolicyProofStep { advance: ArchivedAdmissionPolicyAdvance; pages: readonly { digest: string; bytes: Uint8Array }[] }
export const ADMISSION_POLICY_EVIDENCE_TYPE = 'admission_policy_evidence' as const;
export const ADMISSION_POLICY_EVIDENCE_REPLY_TYPE = 'admission_policy_evidence_reply' as const;
export interface AdmissionPolicyEvidenceRequest {
  version: 1; type: typeof ADMISSION_POLICY_EVIDENCE_TYPE; contextId: string;
  kind: 'genesis' | 'page'; head: AdmissionPolicyHead; digest: string | null; index: number;
}
export interface AdmissionPolicyEvidenceReply {
  version: 1; type: typeof ADMISSION_POLICY_EVIDENCE_REPLY_TYPE; request: AdmissionPolicyEvidenceRequest;
  artifact: string; bytes: number; count: number; data: string;
}
export function parseAdmissionPolicyEvidenceRequest(value: unknown, contextValue: AdmissionPolicyObservers): AdmissionPolicyEvidenceRequest {
  const context = parseAdmissionPolicyObservers(contextValue), raw = bounded(value, ADMISSION_POLICY_CHUNK_REQUEST_MAX_BYTES);
  if (!exactWitnessFields(raw, ['version','type','contextId','kind','head','digest','index']) || raw.version !== 1 || raw.type !== ADMISSION_POLICY_EVIDENCE_TYPE
    || raw.contextId !== admissionPolicyObserversId(context) || !['genesis','page'].includes(raw.kind as string)
    || !Number.isSafeInteger(raw.index) || (raw.index as number) < 0 || (raw.index as number) >= 8
    || (raw.kind === 'genesis' ? raw.digest !== null : typeof raw.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.digest))) throw new Error('Invalid policy evidence request');
  const head = parseAdmissionPolicyHead(raw.head);
  if (head.revision < context.genesis.revision || (raw.kind === 'genesis' || head.revision === context.genesis.revision) && !sameAdmissionPolicyHead(head, context.genesis)) throw new Error('Policy evidence differs from pinned genesis');
  return { version: 1, type: ADMISSION_POLICY_EVIDENCE_TYPE, contextId: raw.contextId as string, kind: raw.kind as 'genesis' | 'page', head, digest: raw.digest as string | null, index: raw.index as number };
}
export function createAdmissionPolicyEvidenceRequest(context: AdmissionPolicyObservers, kind: 'genesis' | 'page', head: AdmissionPolicyHead, digest: string | null = null, index = 0) {
  return parseAdmissionPolicyEvidenceRequest({ version: 1, type: ADMISSION_POLICY_EVIDENCE_TYPE, contextId: admissionPolicyObserversId(context), kind, head, digest, index }, context);
}
export function parseAdmissionPolicyEvidenceReply(value: unknown, request: AdmissionPolicyEvidenceRequest, context: AdmissionPolicyObservers): AdmissionPolicyEvidenceReply {
  const selected = parseAdmissionPolicyEvidenceRequest(request, context), raw = bounded(value, ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES);
  if (!exactWitnessFields(raw, ['version','type','request','artifact','bytes','count','data']) || raw.version !== 1 || raw.type !== ADMISSION_POLICY_EVIDENCE_REPLY_TYPE
    || JSON.stringify(parseAdmissionPolicyEvidenceRequest(raw.request, context)) !== JSON.stringify(selected) || !hash(raw.artifact)
    || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1 || (raw.bytes as number) > 512 * 1024
    || raw.count !== Math.ceil((raw.bytes as number) / ADMISSION_POLICY_CHUNK_BYTES) || selected.index >= (raw.count as number) || typeof raw.data !== 'string') throw new Error('Invalid policy evidence reply');
  const bytes = Buffer.from(raw.data, 'base64url');
  if (bytes.toString('base64url') !== raw.data || bytes.length !== Math.min(ADMISSION_POLICY_CHUNK_BYTES, (raw.bytes as number) - selected.index * ADMISSION_POLICY_CHUNK_BYTES)) throw new Error('Invalid policy evidence encoding');
  return { version: 1, type: ADMISSION_POLICY_EVIDENCE_REPLY_TYPE, request: selected, artifact: raw.artifact, bytes: raw.bytes as number, count: raw.count as number, data: raw.data };
}
export function createAdmissionPolicyEvidenceReply(bytes: Uint8Array, request: AdmissionPolicyEvidenceRequest, context: AdmissionPolicyObservers): AdmissionPolicyEvidenceReply {
  return parseAdmissionPolicyEvidenceReply({ version: 1, type: ADMISSION_POLICY_EVIDENCE_REPLY_TYPE, request, artifact: digest(bytes), bytes: bytes.byteLength,
    count: Math.ceil(bytes.byteLength / ADMISSION_POLICY_CHUNK_BYTES), data: Buffer.from(bytes.subarray(request.index * ADMISSION_POLICY_CHUNK_BYTES, (request.index + 1) * ADMISSION_POLICY_CHUNK_BYTES)).toString('base64url') }, request, context);
}
export function assembleAdmissionPolicyEvidence(values: readonly unknown[], request: AdmissionPolicyEvidenceRequest, context: AdmissionPolicyObservers): Uint8Array {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8 || request.index !== 0) throw new Error('Invalid policy evidence fragments');
  const first = parseAdmissionPolicyEvidenceReply(values[0], request, context);
  if (values.length !== first.count) throw new Error('Incomplete policy evidence');
  const parts = values.map((value, index) => {
    const part = parseAdmissionPolicyEvidenceReply(value, { ...request, index }, context);
    if (part.artifact !== first.artifact || part.bytes !== first.bytes || part.count !== first.count) throw new Error('Policy evidence fragments disagree');
    return Buffer.from(part.data, 'base64url');
  });
  const bytes = Buffer.concat(parts, first.bytes);
  if (digest(bytes) !== first.artifact) throw new Error('Policy evidence digest mismatch');
  return Uint8Array.from(bytes);
}
