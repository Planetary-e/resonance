/** Owner-authorized checkpoint exchange. Stored receipts attest to one write, not current global freshness. */
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import {
  historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest, parseHistoryCheckpointEnvelope,
  parseHistoryFreeze, type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryFreeze,
} from './history-checkpoint.js';

export interface HistoryExchangeRequest {
  version: 1; kind: 'history-request'; action: 'append' | 'head' | 'read';
  contextId: string; rootId: string; generation: number; replica: string;
  challenge: string; issuedAt: number; expiresAt: number;
  sequence: number; envelopeId: string | null; signature: string;
}
export interface HistoryReplicaHead {
  generation: number; rootId: string; sequence: number; envelopeId: string; freeze: HistoryFreeze | null;
}
export interface HistoryExchangeResponse {
  version: 1; kind: 'history-response'; request: HistoryExchangeRequest;
  status: 'stored' | 'head' | 'block' | 'missing'; head: HistoryReplicaHead;
  envelope: HistoryCheckpointEnvelope | null; signature: string;
}
export interface HistoryWriteCertificate { version: 1; receipts: HistoryExchangeResponse[] }
export const HISTORY_REQUEST_MAX_LIFETIME_MS = 30_000;
const DOMAIN = 'resonance:history-exchange:v1';
const requestFields = ['version', 'kind', 'action', 'contextId', 'rootId', 'generation', 'replica',
  'challenge', 'issuedAt', 'expiresAt', 'sequence', 'envelopeId', 'signature'];
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function requestBody(r: HistoryExchangeRequest): Omit<HistoryExchangeRequest, 'signature'> {
  return { version: r.version, kind: r.kind, action: r.action, contextId: r.contextId, rootId: r.rootId,
    generation: r.generation, replica: r.replica, challenge: r.challenge, issuedAt: r.issuedAt,
    expiresAt: r.expiresAt, sequence: r.sequence, envelopeId: r.envelopeId };
}
const requestBytes = (r: HistoryExchangeRequest) => Buffer.from(`${DOMAIN}:request\n${JSON.stringify(requestBody(r))}`);

/** Omit now only when validating historical evidence, never when accepting a network request. */
export function parseHistoryExchangeRequest(value: unknown, context: HistoryCheckpointContext, now?: number): HistoryExchangeRequest {
  if (!exactWitnessFields(value, requestFields) || value.version !== 1 || value.kind !== 'history-request'
    || !['append', 'head', 'read'].includes(value.action as string) || value.contextId !== historyCheckpointContextId(context)
    || !isHistoryDigest(value.rootId) || !integer(value.generation) || !context.members.includes(value.replica as string)
    || !witnessBytes(value.challenge, 32) || !integer(value.issuedAt) || !integer(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > HISTORY_REQUEST_MAX_LIFETIME_MS
    || !integer(value.sequence) || (value.action === 'head' && value.sequence !== 0)
    || (value.action === 'append' ? !isHistoryDigest(value.envelopeId) : value.envelopeId !== null)
    || !witnessBytes(value.signature, 64)
    || (now !== undefined && (!integer(now) || now < value.issuedAt || now >= value.expiresAt))) {
    throw new Error('Invalid or expired history request');
  }
  const request = { ...requestBody(value as unknown as HistoryExchangeRequest), signature: value.signature };
  if (!verify(requestBytes(request), Buffer.from(request.signature, 'base64url'), Buffer.from(context.owner, 'base64url'))) {
    throw new Error('Invalid history request owner signature');
  }
  return request;
}
export function createHistoryExchangeRequest(body: Omit<HistoryExchangeRequest, 'version' | 'kind' | 'contextId' | 'signature'>,
  context: HistoryCheckpointContext, signingKey: SigningKeyPair): HistoryExchangeRequest {
  const key = copyAdmissionSigningKey(signingKey);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history owner');
    const unsigned: HistoryExchangeRequest = { ...body, version: 1, kind: 'history-request',
      contextId: historyCheckpointContextId(context), signature: '' };
    return parseHistoryExchangeRequest({ ...unsigned, signature: Buffer.from(sign(requestBytes(unsigned), key.secretKey)).toString('base64url') }, context);
  } finally { key.secretKey.fill(0); }
}

function parseHead(value: unknown, context: HistoryCheckpointContext, request: HistoryExchangeRequest): HistoryReplicaHead {
  if (!exactWitnessFields(value, ['generation', 'rootId', 'sequence', 'envelopeId', 'freeze'])
    || value.generation !== request.generation || value.rootId !== request.rootId || !integer(value.sequence)
    || !isHistoryDigest(value.envelopeId) || (value.sequence === 0 && value.envelopeId !== value.rootId)) throw new Error('Invalid history replica head');
  const freeze = value.freeze === null ? null : parseHistoryFreeze(value.freeze, context);
  if (freeze && freeze.generation !== value.generation) throw new Error('Wrong history freeze generation');
  return { generation: value.generation as number, rootId: value.rootId as string, sequence: value.sequence, envelopeId: value.envelopeId, freeze };
}
const responseBytes = (r: HistoryExchangeResponse) => Buffer.from(`${DOMAIN}:response\n${JSON.stringify([
  requestBody(r.request), r.request.signature, r.status, r.head,
  r.envelope === null ? null : historyCheckpointEnvelopeId(r.envelope),
])}`);
function responseBody(value: unknown, request: HistoryExchangeRequest, context: HistoryCheckpointContext): HistoryExchangeResponse {
  if (!exactWitnessFields(value, ['version', 'kind', 'request', 'status', 'head', 'envelope', 'signature'])
    || value.version !== 1 || value.kind !== 'history-response' || !witnessBytes(value.signature, 64)) throw new Error('Invalid history response');
  const echoed = parseHistoryExchangeRequest(value.request, context);
  if (JSON.stringify(echoed) !== JSON.stringify(parseHistoryExchangeRequest(request, context))) throw new Error('History reply belongs to another request');
  const head = parseHead(value.head, context, echoed);
  const envelope = value.envelope === null ? null : parseHistoryCheckpointEnvelope(value.envelope, context);
  if (echoed.action === 'append') {
    if (value.status !== 'stored' || envelope !== null || head.freeze !== null || head.sequence < echoed.sequence
      || (head.sequence === echoed.sequence && head.envelopeId !== echoed.envelopeId)) throw new Error('Invalid durable history acknowledgement');
  } else if (echoed.action === 'head') {
    if (value.status !== 'head' || envelope !== null) throw new Error('Invalid history head response');
  } else if (value.status === 'missing') {
    if (envelope !== null || head.sequence >= echoed.sequence) throw new Error('Invalid missing history block');
  } else if (value.status !== 'block' || !envelope || envelope.sequence !== echoed.sequence
    || envelope.generation !== echoed.generation || envelope.sequence > head.sequence
    || (envelope.sequence === 0 && historyCheckpointEnvelopeId(envelope) !== echoed.rootId)
    || (envelope.sequence === head.sequence && historyCheckpointEnvelopeId(envelope) !== head.envelopeId)) {
    throw new Error('Invalid history block response');
  }
  return { version: 1, kind: 'history-response', request: echoed, status: value.status as HistoryExchangeResponse['status'],
    head, envelope, signature: value.signature };
}
export function createHistoryExchangeResponse(request: HistoryExchangeRequest, status: HistoryExchangeResponse['status'],
  head: HistoryReplicaHead, envelope: HistoryCheckpointEnvelope | null, context: HistoryCheckpointContext,
  signingKey: SigningKeyPair): HistoryExchangeResponse {
  const key = copyAdmissionSigningKey(signingKey);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== request.replica) throw new Error('Wrong history replica signing key');
    const unsigned = responseBody({ version: 1, kind: 'history-response', request, status, head, envelope,
      signature: Buffer.alloc(64).toString('base64url') }, request, context);
    return { ...unsigned, signature: Buffer.from(sign(responseBytes(unsigned), key.secretKey)).toString('base64url') };
  } finally { key.secretKey.fill(0); }
}
export function parseHistoryExchangeResponse(value: unknown, request: HistoryExchangeRequest,
  context: HistoryCheckpointContext): HistoryExchangeResponse {
  const response = responseBody(value, request, context);
  if (!verify(responseBytes(response), Buffer.from(response.signature, 'base64url'), Buffer.from(request.replica, 'base64url'))) {
    throw new Error('Invalid history replica signature');
  }
  return response;
}
export function parseHistoryWriteCertificate(value: unknown, envelope: HistoryCheckpointEnvelope,
  rootId: string, context: HistoryCheckpointContext): HistoryWriteCertificate {
  const block = parseHistoryCheckpointEnvelope(envelope, context), id = historyCheckpointEnvelopeId(block);
  if (!isHistoryDigest(rootId) || (block.sequence === 0 && rootId !== id)
    || !exactWitnessFields(value, ['version', 'receipts']) || value.version !== 1 || !Array.isArray(value.receipts)
    || value.receipts.length < 4 || value.receipts.length > 5) throw new Error('Four history receipts required');
  const receipts = value.receipts.map(receipt => {
    const request = parseHistoryExchangeRequest(receipt?.request, context);
    if (request.action !== 'append' || request.rootId !== rootId || request.generation !== block.generation
      || request.sequence !== block.sequence || request.envelopeId !== id) throw new Error('History certificate binds different data');
    return parseHistoryExchangeResponse(receipt, request, context);
  });
  if (new Set(receipts.map(r => r.request.replica)).size !== receipts.length
    || new Set(receipts.map(r => JSON.stringify([r.request.challenge, r.request.issuedAt, r.request.expiresAt]))).size !== 1) {
    throw new Error('History receipts must be distinct and from the same attempt');
  }
  return { version: 1, receipts };
}
