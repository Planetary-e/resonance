/** Owner-authorized ciphertext transfer for a selected agreement proposal. Never a vote. */
import { sign, type SigningKeyPair } from './crypto.js';
import { verifyHistorySignature } from './history-signature.js';
import { exactWitnessFields, witnessBytes } from './admission-witness.js';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest,
  parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from './history-checkpoint.js';
import { HISTORY_AGREEMENT_MAX_FRAME_BYTES, parseHistoryAgreementFrame, type HistoryAgreementFrame } from './history-agreement.js';
import { HISTORY_COMPACTION_MAX_BYTES, parseHistoryCompactionCertificate, type HistoryCompactionCertificate } from './history-compaction.js';

export interface HistoryAgreementDataFrame {
  version: 2; kind: 'history-agreement-data'; action: 'head' | 'read' | 'stage';
  authorization: HistoryAgreementFrame; sequence: number; envelopeId: string;
  envelope: HistoryCheckpointEnvelope | null; signature: string;
  /** Only a staged checkpoint may carry proof; parsing requires independent genesis. */
  compaction?: HistoryCompactionCertificate;
}
export interface HistoryAgreementDataResponse {
  version: 2; kind: 'history-agreement-data-response'; requestId: string;
  head: { sequence: number; envelopeId: string };
  /** Next predecessor needed by a durable, uncommitted transfer; null when none is staged. */
  pending: { sequence: number; envelopeId: string } | null;
  envelope: HistoryCheckpointEnvelope | null; signature: string;
}
export const HISTORY_AGREEMENT_DATA_MAX_BYTES = HISTORY_ENVELOPE_MAX_BYTES + HISTORY_AGREEMENT_MAX_FRAME_BYTES + HISTORY_COMPACTION_MAX_BYTES + 4096;
const domain = 'resonance:history-agreement-data:v2';
const bytes = (purpose: string, body: unknown) => Buffer.from(`${domain}:${purpose}\n${JSON.stringify(body)}`);
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < Number.MAX_SAFE_INTEGER;
const body = (f: HistoryAgreementDataFrame) => [f.version, f.kind, f.action, f.authorization.request.signature, f.sequence, f.envelopeId,
  ...(f.compaction ? [historyDigest(JSON.stringify(f.compaction))] : [])];
export const historyAgreementDataId = (f: HistoryAgreementDataFrame) => historyDigest(bytes('request-id', [...body(f), f.signature]));
function check(purpose: string, value: unknown, signature: unknown, key: string) {
  if (!witnessBytes(signature, 64) || !verifyHistorySignature(bytes(purpose, value), Buffer.from(signature, 'base64url'), Buffer.from(key, 'base64url'))) {
    throw new Error('Invalid agreement data signature');
  }
}
function signed(purpose: string, value: unknown, key: SigningKeyPair, expected: string) {
  if (Buffer.from(key.publicKey).toString('base64url') !== expected) throw new Error('Wrong agreement data signer');
  return Buffer.from(sign(bytes(purpose, value), key.secretKey)).toString('base64url');
}
export function parseHistoryAgreementDataFrame(raw: unknown, context: HistoryCheckpointContext, now?: number, genesisId?: string): HistoryAgreementDataFrame {
  const compacted = !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'compaction');
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > HISTORY_AGREEMENT_DATA_MAX_BYTES
    || !exactWitnessFields(raw, ['version', 'kind', 'action', 'authorization', 'sequence', 'envelopeId', 'envelope', 'signature', ...(compacted ? ['compaction'] : [])])
    || raw.version !== 2 || raw.kind !== 'history-agreement-data' || !['head', 'read', 'stage'].includes(raw.action as string)
    || !integer(raw.sequence) || !isHistoryDigest(raw.envelopeId)) throw new Error('Invalid agreement data request');
  const authorization = parseHistoryAgreementFrame(raw.authorization, context, now);
  if (authorization.request.action !== 'prepare' || raw.sequence > authorization.proposal!.sequence) throw new Error('Data transfer requires a selected proposal');
  const envelope = raw.envelope === null ? null : parseHistoryCheckpointEnvelope(raw.envelope, context);
  if (raw.action === 'stage' ? !envelope || envelope.sequence !== raw.sequence || envelope.generation !== authorization.request.generation
    || historyCheckpointEnvelopeId(envelope) !== raw.envelopeId : envelope !== null) throw new Error('Data payload mismatch');
  if (raw.action === 'head' && (raw.sequence !== authorization.proposal!.sequence || raw.envelopeId !== authorization.proposal!.envelopeId)) {
    throw new Error('Head query must bind the selected head');
  }
  const compaction = compacted ? parseHistoryCompactionCertificate(raw.compaction, context, genesisId!, envelope) : undefined;
  if (compaction && (raw.action !== 'stage' || compaction.proposal.rootId !== authorization.request.rootId
    || compaction.proposal.generation !== authorization.request.generation)) throw new Error('Compacted transfer binds another generation');
  const frame: HistoryAgreementDataFrame = { version: 2, kind: 'history-agreement-data', action: raw.action as HistoryAgreementDataFrame['action'],
    authorization, sequence: raw.sequence, envelopeId: raw.envelopeId, envelope, signature: raw.signature as string, ...(compaction ? { compaction } : {}) };
  check('request', body(frame), frame.signature, context.owner); return frame;
}
export function createHistoryAgreementDataFrame(input: Omit<HistoryAgreementDataFrame, 'version' | 'kind' | 'signature'>,
  context: HistoryCheckpointContext, key: SigningKeyPair, genesisId?: string): HistoryAgreementDataFrame {
  const compaction = Object.hasOwn(input, 'compaction')
    ? parseHistoryCompactionCertificate(input.compaction, context, genesisId!, input.envelope) : undefined;
  const frame: HistoryAgreementDataFrame = { ...input, ...(compaction ? { compaction } : {}), version: 2, kind: 'history-agreement-data', signature: '' };
  frame.signature = signed('request', body(frame), key, context.owner);
  return parseHistoryAgreementDataFrame(frame, context, undefined, genesisId);
}
const responseBody = (r: HistoryAgreementDataResponse) => [r.version, r.kind, r.requestId, r.head, r.pending,
  r.envelope && historyCheckpointEnvelopeId(r.envelope)];
export function createHistoryAgreementDataResponse(frame: HistoryAgreementDataFrame,
  value: Pick<HistoryAgreementDataResponse, 'head' | 'pending' | 'envelope'>, key: SigningKeyPair): HistoryAgreementDataResponse {
  const r: HistoryAgreementDataResponse = { version: 2, kind: 'history-agreement-data-response', requestId: historyAgreementDataId(frame), ...value, signature: '' };
  return structuredClone({ ...r, signature: signed('response', responseBody(r), key, frame.authorization.request.replica) });
}
export function parseHistoryAgreementDataResponse(raw: unknown, frame: HistoryAgreementDataFrame,
  context: HistoryCheckpointContext): HistoryAgreementDataResponse {
  const position = (v: unknown) => exactWitnessFields(v, ['sequence', 'envelopeId']) && integer(v.sequence) && isHistoryDigest(v.envelopeId);
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > (frame.action === 'read' ? HISTORY_ENVELOPE_MAX_BYTES + 4096 : 4096)
    || !exactWitnessFields(raw, ['version', 'kind', 'requestId', 'head', 'pending', 'envelope', 'signature'])
    || raw.version !== 2 || raw.kind !== 'history-agreement-data-response' || raw.requestId !== historyAgreementDataId(frame)
    || !position(raw.head) || (raw.pending !== null && !position(raw.pending))) throw new Error('Invalid agreement data response');
  const envelope = raw.envelope === null ? null : parseHistoryCheckpointEnvelope(raw.envelope, context);
  if (frame.action === 'read' ? !envelope || envelope.sequence !== frame.sequence || envelope.generation !== frame.authorization.request.generation
    || historyCheckpointEnvelopeId(envelope) !== frame.envelopeId : envelope !== null) throw new Error('Wrong agreement data response payload');
  const r = { ...raw, envelope } as unknown as HistoryAgreementDataResponse;
  check('response', responseBody(r), r.signature, frame.authorization.request.replica); return structuredClone(r);
}
