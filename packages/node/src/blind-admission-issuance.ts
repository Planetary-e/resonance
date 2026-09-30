/** Offline exchange: the issuer sees blinded requests, never the resulting tokens. */
import { createHash } from 'node:crypto';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, type BlindAdmissionScopeV2 } from '@resonance/core';
import { admissionKeyFingerprint, parseAdmissionWalletProfile } from './admission-wallet-profile.js';

export interface AdmissionIssuanceRequest {
  version: 1; kind: 'admission-issuance-request'; scope: BlindAdmissionScopeV2;
  keyFingerprint: string; requests: string[]; batchId: string;
}
export interface AdmissionIssuanceResponse {
  version: 1; kind: 'admission-issuance-response'; batchId: string; responses: string[];
}
const MAX_BATCH = 32;
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function batchId(value: Omit<AdmissionIssuanceRequest, 'batchId'>) {
  return hash([value.version, value.kind, value.scope.issuer, value.scope.community, value.scope.epoch, value.keyFingerprint, value.requests]);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function encoded(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length <= 400 && Buffer.from(value, 'base64url').length === bytes
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function validateRequest(value: unknown): asserts value is AdmissionIssuanceRequest {
  if (!exact(value, ['version', 'kind', 'scope', 'keyFingerprint', 'requests', 'batchId'])
    || value.version !== 1 || value.kind !== 'admission-issuance-request'
    || !exact(value.scope, ['issuer', 'community', 'epoch'])
    || typeof value.scope.issuer !== 'string' || !value.scope.issuer.trim() || value.scope.issuer.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.scope.issuer) || value.scope.community !== 'public'
    || typeof value.scope.epoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.scope.epoch)
    || typeof value.keyFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.keyFingerprint)
    || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > MAX_BATCH
    || value.requests.some(request => !encoded(request, 259)) || new Set(value.requests).size !== value.requests.length
    || value.batchId !== batchId(value as unknown as AdmissionIssuanceRequest)) throw new Error('Invalid blinded issuance request');
}
export function validateAdmissionIssuanceResponse(value: unknown, request: AdmissionIssuanceRequest): asserts value is AdmissionIssuanceResponse {
  if (!exact(value, ['version', 'kind', 'batchId', 'responses']) || value.version !== 1
    || value.kind !== 'admission-issuance-response' || value.batchId !== request.batchId
    || !Array.isArray(value.responses) || value.responses.length !== request.requests.length
    || value.responses.some(response => !encoded(response, 256))) throw new Error('Response does not match the pending blinded request');
}

/** Blinding state lives in memory only. Lock/restart/cancel requires a new request. */
export async function createAdmissionIssuanceBatch(profileValue: unknown, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw new Error('Request between 1 and 32 tokens');
  const { profile, publicKey } = await parseAdmissionWalletProfile(profileValue);
  const clients: Awaited<ReturnType<typeof createBlindAdmissionRequestV2>>[] = [];
  for (let i = 0; i < count; i++) clients.push(await createBlindAdmissionRequestV2(profile.scope, publicKey));
  const body: Omit<AdmissionIssuanceRequest, 'batchId'> = { version: 1, kind: 'admission-issuance-request',
    scope: profile.scope, keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey),
    requests: clients.map(client => Buffer.from(client.request).toString('base64url')) };
  const request = { ...body, batchId: batchId(body) };
  let consumed = false;
  return {
    request: structuredClone(request),
    async finalize(value: unknown) {
      validateAdmissionIssuanceResponse(value, request);
      if (consumed) throw new Error('This blinded request has already been finalized');
      consumed = true;
      const responses = [...value.responses];
      try {
        const tokens: string[] = [];
        for (let i = 0; i < clients.length; i++) tokens.push(await clients[i].finalize(Buffer.from(responses[i], 'base64url')));
        return tokens;
      } finally { clients.length = 0; }
    },
  };
}

/** Calling this is the volunteer's explicit approval, not an automatic eligibility policy.
 * expectedProfile must come from the issuer's own configuration, never from the requester.
 * Use a separate key for each accepted scope; the blinded challenge is hidden from the signer.
 */
export async function issueAdmissionBatch(options: { request: unknown; expectedProfile: unknown; privateKey: CryptoKey }) {
  validateRequest(options.request);
  const request = structuredClone(options.request);
  const { profile, publicKey } = await parseAdmissionWalletProfile(options.expectedProfile);
  if (request.keyFingerprint !== admissionKeyFingerprint(profile.issuerPublicKey)
    || ['issuer', 'community', 'epoch'].some(field => request.scope[field as keyof BlindAdmissionScopeV2] !== profile.scope[field as keyof BlindAdmissionScopeV2])) {
    throw new Error('Blinded request targets a different issuer key or token period');
  }
  // Detect a mismatched private key before approving even the first blind signature.
  const probe = new TextEncoder().encode('resonance:issuer-key-check:v1');
  const signature = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 48 }, options.privateKey, probe);
  if (!await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, publicKey, signature, probe)) throw new Error('Issuer private key does not match its pinned public key');
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, profile.scope.issuer, options.privateKey, publicKey);
  const responses: string[] = [];
  for (const bytes of request.requests) responses.push(Buffer.from(await issueBlindAdmissionRequestV2(issuer, Buffer.from(bytes, 'base64url'))).toString('base64url'));
  return { version: 1, kind: 'admission-issuance-response', batchId: request.batchId, responses } satisfies AdmissionIssuanceResponse;
}
