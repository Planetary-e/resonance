/** Small challenge-bound metadata frames intended for encrypted private routing.
 * No account, token, policy body, endpoint or caller-selected observer is sent. */
import { exactWitnessFields } from './admission-witness.js';
import { ADMISSION_POLICY_HEAD_MAX_BYTES, createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadRequest, parseAdmissionPolicyHead,
  parseAdmissionPolicyHeadCertificate, type AdmissionPolicyHeadCertificate, type AdmissionPolicyHeadRequest,
  type AdmissionPolicyObservers } from './admission-policy-freshness.js';

export const ADMISSION_POLICY_QUERY_TYPE = 'admission_policy_query' as const;
export const ADMISSION_POLICY_QUERY_REPLY_TYPE = 'admission_policy_query_reply' as const;
export const ADMISSION_POLICY_QUERY_MAX_BYTES = 1024;
export const ADMISSION_POLICY_QUERY_REPLY_MAX_BYTES = ADMISSION_POLICY_HEAD_MAX_BYTES + 256;
export interface AdmissionPolicyQuery {
  version: 1; type: typeof ADMISSION_POLICY_QUERY_TYPE; request: AdmissionPolicyHeadRequest;
}
export interface AdmissionPolicyQueryReply {
  version: 1; type: typeof ADMISSION_POLICY_QUERY_REPLY_TYPE; certificate: AdmissionPolicyHeadCertificate;
}
function bounded(value: unknown, maximum: number): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maximum) throw new Error('Policy query frame exceeds its limit');
    try { return JSON.parse(value); } catch { throw new Error('Policy query frame must be JSON'); }
  }
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maximum) throw new Error('Policy query frame exceeds its limit');
  return value;
}
export function parseAdmissionPolicyQuery(value: unknown, context: AdmissionPolicyObservers, now: number): AdmissionPolicyQuery {
  const raw = bounded(value, ADMISSION_POLICY_QUERY_MAX_BYTES);
  if (!exactWitnessFields(raw, ['version', 'type', 'request']) || raw.version !== 1 || raw.type !== ADMISSION_POLICY_QUERY_TYPE) throw new Error('Invalid policy query frame');
  return { version: 1, type: ADMISSION_POLICY_QUERY_TYPE, request: parseAdmissionPolicyHeadRequest(raw.request, context, now) };
}
export function createAdmissionPolicyQuery(context: AdmissionPolicyObservers, now = Date.now(), lifetimeMs = 3000): AdmissionPolicyQuery {
  return { version: 1, type: ADMISSION_POLICY_QUERY_TYPE, request: createAdmissionPolicyHeadRequest(context, now, lifetimeMs) };
}
/** A verified quorum head; the caller must still match an authenticated policy,
 * preserve its retained branch/revision and recheck expiry before using it. */
export function parseAdmissionPolicyQueryReply(value: unknown, original: AdmissionPolicyQuery,
  context: AdmissionPolicyObservers, now: number): AdmissionPolicyQueryReply {
  const raw = bounded(value, ADMISSION_POLICY_QUERY_REPLY_MAX_BYTES), request = parseAdmissionPolicyQuery(original, context, now).request;
  if (!exactWitnessFields(raw, ['version', 'type', 'certificate']) || raw.version !== 1 || raw.type !== ADMISSION_POLICY_QUERY_REPLY_TYPE) throw new Error('Invalid policy query reply');
  const certificate = raw.certificate as { votes?: Array<{ head?: unknown }> } | null;
  const head = parseAdmissionPolicyHead(certificate?.votes?.[0]?.head);
  return { version: 1, type: ADMISSION_POLICY_QUERY_REPLY_TYPE,
    certificate: parseAdmissionPolicyHeadCertificate(certificate, request, context, head, now) };
}
