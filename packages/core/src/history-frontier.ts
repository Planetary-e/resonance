/** Locate retained historical checkpoint evidence from an independently pinned
 * genesis. A fresh answer is neither writer readiness nor permission to prune. */
import { sign, type SigningKeyPair } from './crypto.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import { verifyHistorySignature } from './history-signature.js';
import { historyCheckpointContextId, isHistoryDigest, type HistoryCheckpointContext } from './history-checkpoint.js';
import { HISTORY_REQUEST_MAX_LIFETIME_MS } from './history-exchange.js';
import { parseHistoryCompactionAttestation, type HistoryCompactionCertificate } from './history-compaction.js';
import { historyCompactionCertificateId } from './history-compaction-control.js';

export const HISTORY_FRONTIER_REQUEST_MAX_BYTES = 2048;
export const HISTORY_FRONTIER_MAX_BYTES = 16 * 1024;
export interface HistoryFrontierRequest {
  version: 1; kind: 'history-frontier-request'; contextId: string; genesisId: string;
  replica: string; challenge: string; issuedAt: number; expiresAt: number; signature: string;
}
export interface HistoryFrontierResponse {
  version: 1; kind: 'history-frontier-response'; request: HistoryFrontierRequest;
  certificate: HistoryCompactionCertificate | null; signature: string;
}
const DOMAIN = 'resonance:history-frontier:v1';
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const requestBytes = (r: HistoryFrontierRequest) => Buffer.from(`${DOMAIN}:request\n${JSON.stringify([
  r.version, r.kind, r.contextId, r.genesisId, r.replica, r.challenge, r.issuedAt, r.expiresAt,
])}`);
/** Supply now at the network boundary; omit it only for historical validation. */
export function parseHistoryFrontierRequest(value: unknown, context: HistoryCheckpointContext, genesisId: string,
  now?: number): HistoryFrontierRequest {
  if (!exactWitnessFields(value, ['version', 'kind', 'contextId', 'genesisId', 'replica', 'challenge', 'issuedAt', 'expiresAt', 'signature'])
    || value.version !== 1 || value.kind !== 'history-frontier-request' || value.contextId !== historyCheckpointContextId(context)
    || !isHistoryDigest(genesisId) || value.genesisId !== genesisId || !context.members.includes(value.replica as string)
    || !witnessBytes(value.challenge, 32) || !integer(value.issuedAt) || !integer(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > HISTORY_REQUEST_MAX_LIFETIME_MS
    || !witnessBytes(value.signature, 64) || Buffer.byteLength(JSON.stringify(value)) > HISTORY_FRONTIER_REQUEST_MAX_BYTES
    || (now !== undefined && (!integer(now) || now < value.issuedAt || now >= value.expiresAt))) {
    throw new Error('Invalid or expired history frontier request');
  }
  const request: HistoryFrontierRequest = { version: 1, kind: 'history-frontier-request', contextId: value.contextId as string,
    genesisId, replica: value.replica as string, challenge: value.challenge as string, issuedAt: value.issuedAt,
    expiresAt: value.expiresAt, signature: value.signature as string };
  if (!verifyHistorySignature(requestBytes(request), Buffer.from(request.signature, 'base64url'), Buffer.from(context.owner, 'base64url'))) {
    throw new Error('Invalid history frontier owner signature');
  }
  return request;
}
export function createHistoryFrontierRequest(input: Omit<HistoryFrontierRequest, 'version' | 'kind' | 'contextId' | 'signature'>,
  context: HistoryCheckpointContext, signer: SigningKeyPair): HistoryFrontierRequest {
  const key = copyAdmissionSigningKey(signer);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history frontier owner');
    const request: HistoryFrontierRequest = { ...input, version: 1, kind: 'history-frontier-request', contextId: historyCheckpointContextId(context), signature: '' };
    return parseHistoryFrontierRequest({ ...request, signature: Buffer.from(sign(requestBytes(request), key.secretKey)).toString('base64url') }, context, input.genesisId);
  } finally { key.secretKey.fill(0); }
}
const responseBytes = (r: HistoryFrontierResponse, context: HistoryCheckpointContext) => Buffer.from(`${DOMAIN}:response\n${JSON.stringify([
  requestBytes(r.request).toString('base64url'), r.request.signature,
  r.certificate === null ? null : historyCompactionCertificateId(r.certificate, context, r.request.genesisId),
])}`);
function responseBody(value: unknown, original: HistoryFrontierRequest, context: HistoryCheckpointContext, genesisId: string): HistoryFrontierResponse {
  if (!exactWitnessFields(value, ['version', 'kind', 'request', 'certificate', 'signature']) || value.version !== 1
    || value.kind !== 'history-frontier-response' || !witnessBytes(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value)) > HISTORY_FRONTIER_MAX_BYTES) throw new Error('Invalid history frontier response');
  const request = parseHistoryFrontierRequest(value.request, context, genesisId);
  if (JSON.stringify(request) !== JSON.stringify(parseHistoryFrontierRequest(original, context, genesisId))) {
    throw new Error('History frontier response belongs to another request');
  }
  const certificate = value.certificate === null ? null : parseHistoryCompactionAttestation(value.certificate, context, genesisId);
  return { version: 1, kind: 'history-frontier-response', request, certificate, signature: value.signature as string };
}
export function createHistoryFrontierResponse(request: HistoryFrontierRequest, certificate: HistoryCompactionCertificate | null,
  context: HistoryCheckpointContext, signer: SigningKeyPair): HistoryFrontierResponse {
  const key = copyAdmissionSigningKey(signer);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== request.replica) throw new Error('Wrong history frontier member');
    const response = responseBody({ version: 1, kind: 'history-frontier-response', request, certificate,
      signature: Buffer.alloc(64).toString('base64url') }, request, context, request.genesisId);
    return { ...response, signature: Buffer.from(sign(responseBytes(response, context), key.secretKey)).toString('base64url') };
  } finally { key.secretKey.fill(0); }
}
export function parseHistoryFrontierResponse(value: unknown, original: HistoryFrontierRequest,
  context: HistoryCheckpointContext, genesisId: string): HistoryFrontierResponse {
  const response = responseBody(value, original, context, genesisId);
  if (!verifyHistorySignature(responseBytes(response, context), Buffer.from(response.signature, 'base64url'), Buffer.from(response.request.replica, 'base64url'))) {
    throw new Error('Invalid history frontier member signature');
  }
  return response;
}
