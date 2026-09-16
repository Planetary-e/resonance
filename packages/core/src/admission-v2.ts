/** Anonymous admission presentation boundary for protocol v2 relay requests. */

import { decodeUTF8, encodeBase64, sha512 } from './crypto.js';

export const ADMISSION_CAPABILITY_KIND_V2 = 'admission-capability' as const;

export type RelayAdmissionActionV2 =
  | 'publication-write'
  | 'search'
  | 'mailbox-fetch'
  | 'mailbox-acknowledge'
  | 'mailbox-deposit';

/**
 * An opaque, unlinkable credential presentation supplied by a token wallet.
 * Its cryptography is selected by `scheme` and interpreted only by the relay's
 * configured verifier. The proof is expected to authenticate the request
 * binding passed to that verifier.
 */
export interface AdmissionCapabilityV2 {
  version: 2;
  kind: typeof ADMISSION_CAPABILITY_KIND_V2;
  scheme: string;
  /** Issuer or verification-key identifier; never a user identifier. */
  issuer: string;
  /** Opaque, unpadded base64url token. */
  token: string;
  /** Opaque, unpadded base64url proof bound to the exact relay request. */
  requestProof: string;
}

export function verifyAdmissionCapabilityV2(value: unknown): value is AdmissionCapabilityV2 {
  return isObject(value)
    && hasOnlyKeys(value, ['issuer', 'kind', 'requestProof', 'scheme', 'token', 'version'])
    && value.version === 2
    && value.kind === ADMISSION_CAPABILITY_KIND_V2
    && isScheme(value.scheme)
    && isBoundedIdentifier(value.issuer, 256)
    && isOpaqueBase64Url(value.token, 16, 8192)
    && isOpaqueBase64Url(value.requestProof, 16, 8192);
}

/**
 * Stable digest presented to both the client wallet and relay verifier. A
 * capability can be retried for this binding, but must fail for another one.
 */
export function createAdmissionRequestBindingV2(
  action: RelayAdmissionActionV2,
  request: unknown,
): string {
  if (!isRelayAdmissionActionV2(action)) throw new Error('Invalid relay admission action');
  const digest = sha512(decodeUTF8(
    `resonance:admission:v2:request\n${action}\n${canonicalize(request)}`,
  ));
  return `admreq_${encodeBase64Url(digest)}`;
}

export function isRelayAdmissionActionV2(value: unknown): value is RelayAdmissionActionV2 {
  return value === 'publication-write'
    || value === 'search'
    || value === 'mailbox-fetch'
    || value === 'mailbox-acknowledge'
    || value === 'mailbox-deposit';
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot bind a non-finite request value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(
      key => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
    ).join(',')}}`;
  }
  throw new Error(`Cannot bind a request containing ${typeof value}`);
}

function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isScheme(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function isBoundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isOpaqueBase64Url(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
