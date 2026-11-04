/** Fresh authorization to create one certified child. A receipt is NOT a history write certificate. */
import { sign, type SigningKeyPair } from './crypto.js';
import { exactWitnessFields, witnessBytes } from './admission-witness.js';
import { verifyHistorySignature } from './history-signature.js';
import { historyCheckpointContextId, historyDigest, type HistoryCheckpointContext } from './history-checkpoint.js';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from './history-continuation.js';

export const HISTORY_PROVISION_MAX_BYTES = 40 * 1024;
export interface HistoryProvisionRequest {
  version: 2; kind: 'history-provision'; contextId: string; replica: string;
  challenge: string; issuedAt: number; expiresAt: number; root: HistoryContinuationRoot; signature: string;
}
export interface HistoryProvisionReceipt {
  version: 2; kind: 'history-provision-receipt'; requestId: string; rootId: string; signature: string;
}
const bytes = (purpose: string, value: unknown) => Buffer.from(`resonance:history-provision:v2:${purpose}\n${JSON.stringify(value)}`);
const body = (r: HistoryProvisionRequest) => [r.version, r.kind, r.contextId, r.replica, r.challenge, r.issuedAt, r.expiresAt, historyContinuationRootId(r.root)];
export const historyProvisionRequestId = (r: HistoryProvisionRequest) => historyDigest(bytes('id', [...body(r), r.signature]));
function signed(purpose: string, value: unknown, key: SigningKeyPair, expected: string) {
  if (Buffer.from(key.publicKey).toString('base64url') !== expected) throw new Error('Wrong history provision signer');
  return Buffer.from(sign(bytes(purpose, value), key.secretKey)).toString('base64url');
}
function verify(purpose: string, value: unknown, signature: unknown, key: string) {
  if (!witnessBytes(signature, 64) || !verifyHistorySignature(bytes(purpose, value), Buffer.from(signature, 'base64url'), Buffer.from(key, 'base64url'))) {
    throw new Error('Invalid history provision signature');
  }
}
export function parseHistoryProvisionRequest(raw: unknown, context: HistoryCheckpointContext, now?: number): HistoryProvisionRequest {
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > HISTORY_PROVISION_MAX_BYTES
    || !exactWitnessFields(raw, ['version', 'kind', 'contextId', 'replica', 'challenge', 'issuedAt', 'expiresAt', 'root', 'signature'])
    || raw.version !== 2 || raw.kind !== 'history-provision' || raw.contextId !== historyCheckpointContextId(context)
    || !context.members.includes(raw.replica as string) || !witnessBytes(raw.challenge, 32)
    || !integer(raw.issuedAt) || !integer(raw.expiresAt) || raw.expiresAt <= raw.issuedAt || raw.expiresAt - raw.issuedAt > 30_000
    || (now !== undefined && (!integer(now) || now < raw.issuedAt || now >= raw.expiresAt))) throw new Error('Invalid or expired history provision request');
  const r = { ...raw, root: parseHistoryContinuationRoot(raw.root, context) } as unknown as HistoryProvisionRequest;
  verify('request', body(r), r.signature, context.owner); return r;
}
export function createHistoryProvisionRequest(value: Pick<HistoryProvisionRequest, 'replica' | 'challenge' | 'issuedAt' | 'expiresAt' | 'root'>,
  context: HistoryCheckpointContext, key: SigningKeyPair): HistoryProvisionRequest {
  const r: HistoryProvisionRequest = { ...value, version: 2, kind: 'history-provision', contextId: historyCheckpointContextId(context), signature: '' };
  r.signature = signed('request', body(r), key, context.owner); return parseHistoryProvisionRequest(r, context);
}
const receiptBody = (r: HistoryProvisionReceipt) => [r.version, r.kind, r.requestId, r.rootId];
export function createHistoryProvisionReceipt(request: HistoryProvisionRequest, key: SigningKeyPair): HistoryProvisionReceipt {
  const r: HistoryProvisionReceipt = { version: 2, kind: 'history-provision-receipt', requestId: historyProvisionRequestId(request),
    rootId: historyContinuationRootId(request.root), signature: '' };
  r.signature = signed('receipt', receiptBody(r), key, request.replica); return r;
}
export function parseHistoryProvisionReceipt(raw: unknown, request: HistoryProvisionRequest): HistoryProvisionReceipt {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 1024 || !exactWitnessFields(raw, ['version', 'kind', 'requestId', 'rootId', 'signature'])
    || raw.version !== 2 || raw.kind !== 'history-provision-receipt' || raw.requestId !== historyProvisionRequestId(request)
    || raw.rootId !== historyContinuationRootId(request.root)) throw new Error('Invalid history provision receipt');
  const r = raw as unknown as HistoryProvisionReceipt;
  verify('receipt', receiptBody(r), r.signature, request.replica); return structuredClone(r);
}
