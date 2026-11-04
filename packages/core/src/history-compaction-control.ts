/** Owner-authorized retention/read of historical checkpoint certificates.
 * No action in this protocol deletes ciphertext or grants writer authority. */
import { sign, type SigningKeyPair } from './crypto.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import { verifyHistorySignature } from './history-signature.js';
import { historyCheckpointContextId, historyDigest, isHistoryDigest, type HistoryCheckpointContext } from './history-checkpoint.js';
import { parseHistoryReplicaHead, HISTORY_REQUEST_MAX_LIFETIME_MS, type HistoryReplicaHead } from './history-exchange.js';
import { parseHistoryCompactionAttestation, type HistoryCompactionCertificate } from './history-compaction.js';

export const HISTORY_COMPACTION_CONTROL_MAX_BYTES = 16 * 1024;
export interface HistoryCompactionControlRequest {
  version: 1; kind: 'history-compaction-control'; action: 'retain' | 'read'; contextId: string;
  genesisId: string; rootId: string; generation: number; replica: string; certificateId: string | null;
  challenge: string; issuedAt: number; expiresAt: number; signature: string;
}
export interface HistoryCompactionControlFrame { request: HistoryCompactionControlRequest; certificate: HistoryCompactionCertificate | null }
export interface HistoryCompactionControlResponse {
  version: 1; kind: 'history-compaction-control-response'; request: HistoryCompactionControlRequest;
  head: HistoryReplicaHead; certificate: HistoryCompactionCertificate | null; signature: string;
}
const DOMAIN = 'resonance:history-compaction-control:v1';
const fields = ['version', 'kind', 'action', 'contextId', 'genesisId', 'rootId', 'generation', 'replica', 'certificateId',
  'challenge', 'issuedAt', 'expiresAt', 'signature'];
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const requestBytes = (r: HistoryCompactionControlRequest) => Buffer.from(`${DOMAIN}:request\n${JSON.stringify([
  r.version, r.kind, r.action, r.contextId, r.genesisId, r.rootId, r.generation, r.replica, r.certificateId, r.challenge, r.issuedAt, r.expiresAt,
])}`);
/** Canonicalize and authenticate before computing its identity. */
export function historyCompactionCertificateId(value: unknown, context: HistoryCheckpointContext, genesisId: string): string {
  return historyDigest(`${DOMAIN}:certificate\n${JSON.stringify(parseHistoryCompactionAttestation(value, context, genesisId))}`);
}
export function parseHistoryCompactionControlRequest(value: unknown, context: HistoryCheckpointContext, genesisId: string,
  now?: number): HistoryCompactionControlRequest {
  if (!exactWitnessFields(value, fields) || value.version !== 1 || value.kind !== 'history-compaction-control'
    || !['retain', 'read'].includes(value.action as string) || value.contextId !== historyCheckpointContextId(context)
    || !isHistoryDigest(genesisId) || value.genesisId !== genesisId || !isHistoryDigest(value.rootId)
    || !integer(value.generation) || (value.generation === 0) !== (value.rootId === genesisId)
    || !context.members.includes(value.replica as string) || (value.action === 'read' ? value.certificateId !== null : !isHistoryDigest(value.certificateId))
    || !witnessBytes(value.challenge, 32) || !integer(value.issuedAt) || !integer(value.expiresAt) || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > HISTORY_REQUEST_MAX_LIFETIME_MS || !witnessBytes(value.signature, 64)
    || (now !== undefined && (!integer(now) || now < value.issuedAt || now >= value.expiresAt))
    || Buffer.byteLength(JSON.stringify(value)) > 2048) throw new Error('Invalid or expired compaction control request');
  const request = { version: 1, kind: value.kind, action: value.action, contextId: value.contextId, genesisId, rootId: value.rootId,
    generation: value.generation, replica: value.replica, certificateId: value.certificateId, challenge: value.challenge,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt, signature: value.signature } as HistoryCompactionControlRequest;
  if (!verifyHistorySignature(requestBytes(request), Buffer.from(request.signature, 'base64url'), Buffer.from(context.owner, 'base64url'))) {
    throw new Error('Invalid compaction control owner signature');
  }
  return request;
}
export function createHistoryCompactionControlRequest(input: Omit<HistoryCompactionControlRequest, 'version' | 'kind' | 'contextId' | 'signature'>,
  context: HistoryCheckpointContext, signer: SigningKeyPair): HistoryCompactionControlRequest {
  const key = copyAdmissionSigningKey(signer);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong compaction control owner');
    const request: HistoryCompactionControlRequest = { ...input, version: 1, kind: 'history-compaction-control',
      contextId: historyCheckpointContextId(context), signature: '' };
    return parseHistoryCompactionControlRequest({ ...request, signature: Buffer.from(sign(requestBytes(request), key.secretKey)).toString('base64url') }, context, input.genesisId);
  } finally { key.secretKey.fill(0); }
}
/** Supply now for incoming requests; omit it only while checking historical replies. */
export function parseHistoryCompactionControlFrame(value: unknown, context: HistoryCheckpointContext, genesisId: string, now?: number): HistoryCompactionControlFrame {
  if (!exactWitnessFields(value, ['request', 'certificate']) || Buffer.byteLength(JSON.stringify(value)) > HISTORY_COMPACTION_CONTROL_MAX_BYTES) {
    throw new Error('Invalid compaction control frame');
  }
  const request = parseHistoryCompactionControlRequest(value.request, context, genesisId, now);
  const certificate = value.certificate === null ? null : parseHistoryCompactionAttestation(value.certificate, context, genesisId);
  if (request.action === 'read' ? certificate !== null : !certificate || certificate.proposal.rootId !== request.rootId
    || certificate.proposal.generation !== request.generation || historyCompactionCertificateId(certificate, context, genesisId) !== request.certificateId) {
    throw new Error('Compaction control payload does not match its authorization');
  }
  return { request, certificate };
}
const responseBytes = (r: HistoryCompactionControlResponse, context: HistoryCheckpointContext) => Buffer.from(`${DOMAIN}:response\n${JSON.stringify([
  requestBytes(r.request).toString('base64url'), r.request.signature, r.head,
  r.certificate === null ? null : historyCompactionCertificateId(r.certificate, context, r.request.genesisId),
])}`);
function responseBody(value: unknown, originalValue: HistoryCompactionControlFrame, context: HistoryCheckpointContext, genesisId: string): HistoryCompactionControlResponse {
  if (!exactWitnessFields(value, ['version', 'kind', 'request', 'head', 'certificate', 'signature']) || value.version !== 1
    || value.kind !== 'history-compaction-control-response' || !witnessBytes(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value)) > HISTORY_COMPACTION_CONTROL_MAX_BYTES) throw new Error('Invalid compaction control response');
  const original = parseHistoryCompactionControlFrame(originalValue, context, genesisId);
  const request = parseHistoryCompactionControlRequest(value.request, context, genesisId);
  if (JSON.stringify(request) !== JSON.stringify(original.request)) throw new Error('Compaction control response belongs to another request');
  const head = parseHistoryReplicaHead(value.head, context, request);
  const certificate = value.certificate === null ? null : parseHistoryCompactionAttestation(value.certificate, context, genesisId);
  if (certificate && (certificate.proposal.rootId !== request.rootId || certificate.proposal.generation !== request.generation
    || certificate.proposal.sequence > head.sequence || (certificate.proposal.sequence === head.sequence && certificate.proposal.envelopeId !== head.envelopeId))) {
    throw new Error('Compaction response does not retain its certified history');
  }
  // A member may already retain another valid four-vote proof for this exact
  // checkpoint. Keep that first proof rather than replacing it on retries.
  if (request.action === 'retain' && (!certificate || certificate.proposal.sequence !== original.certificate!.proposal.sequence
    || certificate.proposal.envelopeId !== original.certificate!.proposal.envelopeId)) {
    throw new Error('Compaction retention receipt binds another checkpoint');
  }
  return { version: 1, kind: 'history-compaction-control-response', request, head, certificate, signature: value.signature };
}
export function createHistoryCompactionControlResponse(original: HistoryCompactionControlFrame, head: HistoryReplicaHead,
  certificate: HistoryCompactionCertificate | null, context: HistoryCheckpointContext, signer: SigningKeyPair): HistoryCompactionControlResponse {
  const request = original.request, key = copyAdmissionSigningKey(signer);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== request.replica) throw new Error('Wrong compaction control member');
    const response = responseBody({ version: 1, kind: 'history-compaction-control-response', request, head, certificate,
      signature: Buffer.alloc(64).toString('base64url') }, original, context, request.genesisId);
    return { ...response, signature: Buffer.from(sign(responseBytes(response, context), key.secretKey)).toString('base64url') };
  } finally { key.secretKey.fill(0); }
}
export function parseHistoryCompactionControlResponse(value: unknown, original: HistoryCompactionControlFrame,
  context: HistoryCheckpointContext, genesisId: string): HistoryCompactionControlResponse {
  const response = responseBody(value, original, context, genesisId);
  if (!verifyHistorySignature(responseBytes(response, context), Buffer.from(response.signature, 'base64url'), Buffer.from(response.request.replica, 'base64url'))) {
    throw new Error('Invalid compaction control member signature');
  }
  return response;
}
