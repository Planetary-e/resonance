/** Publicly verifiable Privacy Pass tokens for protocol-v2 admission.
 * Issuers decide eligibility before signing blinded requests; relays never see
 * that decision or an account identifier in the redeemed token.
 */
import {
  Token, TOKEN_TYPES, publicVerif,
} from '@cloudflare/privacypass-ts';
import {
  type AdmissionCapabilityV2, type RelayAdmissionActionV2,
  verifyAdmissionCapabilityV2,
} from './admission-v2.js';
import { decodeUTF8, sha512 } from './crypto.js';

const MODE = publicVerif.BlindRSAMode.PSS;
const SCHEME = 'privacy-pass-blind-rsa-v1';
const encoder = new TextEncoder();

export interface BlindAdmissionScopeV2 {
  issuer: string;
  community: string;
  epoch: string;
}

function scopeName(scope: BlindAdmissionScopeV2): string {
  if (!scope.issuer || !scope.community || !scope.epoch
    || [scope.issuer, scope.community, scope.epoch].some(part => part.length > 128 || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('Invalid blind admission scope');
  }
  return `resonance:v2:${scope.community}:${scope.epoch}`;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export async function createBlindAdmissionChallengeV2(scope: BlindAdmissionScopeV2) {
  const context = await digest(encoder.encode(scopeName(scope)));
  return new publicVerif.Origin(MODE).createTokenChallenge(scope.issuer, context);
}

/** A one-shot blinding state. Do not serialize or reuse it. */
export async function createBlindAdmissionRequestV2(
  scope: BlindAdmissionScopeV2,
  issuerPublicKey: CryptoKey,
): Promise<{ request: Uint8Array; finalize(response: Uint8Array): Promise<string> }> {
  const client = new publicVerif.Client(MODE);
  const challenge = await createBlindAdmissionChallengeV2(scope);
  const keyBytes = await publicVerif.getPublicKeyBytes(issuerPublicKey);
  const request = await client.createTokenRequest(challenge, keyBytes);
  return {
    request: request.serialize(),
    async finalize(response) {
      const token = await client.finalize(publicVerif.TokenResponse.deserialize(response));
      return encode(token.serialize());
    },
  };
}

/** Call only after the community's issuance policy has approved this request. */
export async function issueBlindAdmissionRequestV2(
  issuer: publicVerif.Issuer,
  request: Uint8Array,
): Promise<Uint8Array> {
  if (request.length !== 259) throw new Error('Invalid blind admission request size');
  const decoded = publicVerif.TokenRequest.deserialize(TOKEN_TYPES.BLIND_RSA, request);
  const keyId = await issuer.tokenKeyID();
  if (decoded.truncatedTokenKeyId !== keyId[keyId.length - 1]) {
    throw new Error('Blind admission request targets another issuer key');
  }
  return issuer.issue(decoded)
    .then(response => response.serialize());
}

function requestProof(token: Uint8Array, action: RelayAdmissionActionV2, binding: string): string {
  return encode(sha512(decodeUTF8(`resonance:admission:proof:v2\n${action}\n${binding}\n${encode(token)}`)));
}

export function presentBlindAdmissionTokenV2(
  token: string,
  scope: BlindAdmissionScopeV2,
  action: RelayAdmissionActionV2,
  requestBinding: string,
): AdmissionCapabilityV2 {
  const bytes = decode(token);
  if (bytes.length !== 354) throw new Error('Invalid blind admission token size');
  return {
    version: 2,
    kind: 'admission-capability',
    scheme: SCHEME,
    issuer: scope.issuer,
    token,
    requestProof: requestProof(bytes, action, requestBinding),
  };
}

/** Returns the token's public, scoped spend identifier on success. */
export async function verifyBlindAdmissionTokenV2(
  capability: AdmissionCapabilityV2,
  scope: BlindAdmissionScopeV2,
  action: RelayAdmissionActionV2,
  requestBinding: string,
  issuerPublicKey: CryptoKey,
): Promise<string | null> {
  if (!verifyAdmissionCapabilityV2(capability) || capability.scheme !== SCHEME
    || capability.issuer !== scope.issuer) return null;
  const bytes = decode(capability.token);
  if (bytes.length !== 354 || encode(bytes) !== capability.token) return null;
  if (capability.requestProof !== requestProof(bytes, action, requestBinding)) return null;
  try {
    const token = Token.deserialize(TOKEN_TYPES.BLIND_RSA, bytes);
    const challenge = await createBlindAdmissionChallengeV2(scope);
    const challengeHash = await digest(challenge.serialize());
    const keyHash = await digest(await publicVerif.getPublicKeyBytes(issuerPublicKey));
    if (!equal(token.authInput.challengeDigest, challengeHash)
      || !equal(token.authInput.tokenKeyId, keyHash)) return null;
    const origin = new publicVerif.Origin(MODE);
    if (!await origin.verify(token, issuerPublicKey)) return null;
    return encode(await digest(bytes));
  } catch {
    return null;
  }
}

function equal(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
