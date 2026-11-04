/** Experimental four-of-five policy-head observation. This is a wire primitive,
 * not an activation protocol: responders must retain a monotone authenticated
 * head durably, and callers must enforce an independent monotonic deadline. */
import { createHash, randomBytes } from 'node:crypto';
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { copyAdmissionSigningKey, exactWitnessFields, parseAdmissionWitnessSet, witnessBytes } from './admission-witness.js';
import { chargeAdmissionWork, chargeAdmissionWorkBase64, type AdmissionWorkMeter } from './admission-work.js';

export interface AdmissionPolicyHead { revision: number; digest: string; transition: string }
export interface AdmissionPolicyObservers {
  version: 1; kind: 'admission-policy-observers'; authority: string;
  genesis: AdmissionPolicyHead; quorum: 4;
  members: Array<{ publicKey: string; endpoint: string }>;
}
export interface AdmissionPolicyHeadRequest {
  version: 1; kind: 'admission-policy-head-request'; contextId: string;
  challenge: string; issuedAt: number; expiresAt: number;
}
export interface AdmissionPolicyHeadVote {
  version: 1; kind: 'admission-policy-head-vote'; request: AdmissionPolicyHeadRequest;
  head: AdmissionPolicyHead; observer: string; signature: string;
}
export interface AdmissionPolicyHeadCertificate {
  version: 1; kind: 'admission-policy-head-certificate'; votes: AdmissionPolicyHeadVote[];
}
export const ADMISSION_POLICY_HEAD_MAX_BYTES = 8192;
export const ADMISSION_POLICY_HEAD_MAX_LIFETIME_MS = 30_000;
const DOMAIN = 'resonance:admission-policy-head:v1';
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function parseAdmissionPolicyHead(value: unknown): AdmissionPolicyHead {
  if (!exactWitnessFields(value, ['revision', 'digest', 'transition']) || !integer(value.revision) || value.revision < 1
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.transition !== 'string' || !/^[a-f0-9]{64}$/.test(value.transition)) throw new Error('Invalid admission policy head');
  return { revision: value.revision, digest: value.digest, transition: value.transition };
}
export function parseAdmissionPolicyObservers(value: unknown): AdmissionPolicyObservers {
  if (!exactWitnessFields(value, ['version', 'kind', 'authority', 'genesis', 'quorum', 'members'])
    || value.version !== 1 || value.kind !== 'admission-policy-observers' || !witnessBytes(value.authority, 32)) {
    throw new Error('Invalid admission policy observers');
  }
  const set = parseAdmissionWitnessSet({ version: 1, quorum: value.quorum, members: value.members, coordinators: [value.authority] });
  const genesis = parseAdmissionPolicyHead(value.genesis);
  if (genesis.transition !== genesis.digest) throw new Error('Invalid initial policy transition anchor');
  return { version: 1, kind: 'admission-policy-observers', authority: value.authority, genesis, quorum: 4, members: set.members };
}
export function admissionPolicyObserversId(value: AdmissionPolicyObservers, work?: AdmissionWorkMeter): string {
  const context = parseAdmissionPolicyObservers(value), bytes = Buffer.from(`${DOMAIN}:observers\n${JSON.stringify(context)}`); chargeAdmissionWork(work, bytes.length, 'serialize');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export function parseAdmissionPolicyHeadRequest(value: unknown, context: AdmissionPolicyObservers, now: number, work?: AdmissionWorkMeter): AdmissionPolicyHeadRequest {
  if (!exactWitnessFields(value, ['version', 'kind', 'contextId', 'challenge', 'issuedAt', 'expiresAt'])
    || value.version !== 1 || value.kind !== 'admission-policy-head-request'
    || value.contextId !== admissionPolicyObserversId(context, work) || !witnessBytes(value.challenge, 32)
    || !integer(value.issuedAt) || !integer(value.expiresAt) || !integer(now)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > ADMISSION_POLICY_HEAD_MAX_LIFETIME_MS
    || now < value.issuedAt || now >= value.expiresAt) throw new Error('Invalid or expired admission policy head request');
  return { version: 1, kind: 'admission-policy-head-request', contextId: value.contextId as string,
    challenge: value.challenge, issuedAt: value.issuedAt, expiresAt: value.expiresAt };
}
export function createAdmissionPolicyHeadRequest(context: AdmissionPolicyObservers, now = Date.now(), lifetimeMs = 3000, work?: AdmissionWorkMeter): AdmissionPolicyHeadRequest {
  return parseAdmissionPolicyHeadRequest({ version: 1, kind: 'admission-policy-head-request', contextId: admissionPolicyObserversId(context, work),
    challenge: chargeAdmissionWorkBase64(work, randomBytes(32)), issuedAt: now, expiresAt: now + lifetimeMs }, context, now, work);
}
function admittedHead(value: unknown, context: AdmissionPolicyObservers) {
  const current = parseAdmissionPolicyHead(value), genesis = parseAdmissionPolicyHead(context.genesis);
  if (current.revision < genesis.revision || (current.revision === genesis.revision && (current.digest !== genesis.digest || current.transition !== genesis.transition))) {
    throw new Error('Policy head precedes or conflicts with the independently pinned genesis');
  }
  return current;
}
function payload(request: AdmissionPolicyHeadRequest, current: AdmissionPolicyHead, observer: string, work?: AdmissionWorkMeter) {
  const bytes = Buffer.from(`${DOMAIN}:vote\n${JSON.stringify([request.contextId, request.challenge, request.issuedAt, request.expiresAt,
    current.revision, current.digest, current.transition, observer])}`); chargeAdmissionWork(work, bytes.length, 'serialize'); return bytes;
}
/** The caller is responsible for durable head installation before signing. */
export function createAdmissionPolicyHeadVote(requestValue: unknown, headValue: AdmissionPolicyHead,
  contextValue: AdmissionPolicyObservers, key: SigningKeyPair, now = Date.now(), work?: AdmissionWorkMeter): AdmissionPolicyHeadVote {
  const context = parseAdmissionPolicyObservers(contextValue), request = parseAdmissionPolicyHeadRequest(requestValue, context, now, work);
  const current = admittedHead(headValue, context), owned = copyAdmissionSigningKey(key);
  try {
    const observer = Buffer.from(owned.publicKey).toString('base64url');
    if (!context.members.some(member => member.publicKey === observer)) throw new Error('Policy observer is not enrolled');
    return { version: 1, kind: 'admission-policy-head-vote', request, head: current, observer,
      signature: chargeAdmissionWorkBase64(work, sign(payload(request, current, observer, work), owned.secretKey)) };
  } finally { owned.secretKey.fill(0); }
}
export function parseAdmissionPolicyHeadVote(value: unknown, requestValue: AdmissionPolicyHeadRequest,
  contextValue: AdmissionPolicyObservers, now: number, work?: AdmissionWorkMeter): AdmissionPolicyHeadVote {
  const context = parseAdmissionPolicyObservers(contextValue), original = parseAdmissionPolicyHeadRequest(requestValue, context, now, work);
  if (!exactWitnessFields(value, ['version', 'kind', 'request', 'head', 'observer', 'signature'])
    || value.version !== 1 || value.kind !== 'admission-policy-head-vote' || !witnessBytes(value.observer, 32)
    || !witnessBytes(value.signature, 64) || !context.members.some(member => member.publicKey === value.observer)) throw new Error('Invalid policy head vote');
  const request = parseAdmissionPolicyHeadRequest(value.request, context, now, work), current = admittedHead(value.head, context);
  chargeAdmissionWork(work, 64, 'base64');
  if (JSON.stringify(request) !== JSON.stringify(original)
    || !verify(payload(request, current, value.observer, work), Buffer.from(value.signature, 'base64url'), Buffer.from(value.observer, 'base64url'))) {
    throw new Error('Policy head vote does not authenticate this request');
  }
  return { version: 1, kind: 'admission-policy-head-vote', request, head: current, observer: value.observer, signature: value.signature };
}
/** A certificate observes this exact head during this request. It cannot prove
 * no later update exists or revoke already accepted operations retroactively. */
export function parseAdmissionPolicyHeadCertificate(value: unknown, request: AdmissionPolicyHeadRequest,
  context: AdmissionPolicyObservers, expected: AdmissionPolicyHead, now: number, work?: AdmissionWorkMeter): AdmissionPolicyHeadCertificate {
  const current = admittedHead(expected, parseAdmissionPolicyObservers(context));
  if (!exactWitnessFields(value, ['version', 'kind', 'votes']) || value.version !== 1 || value.kind !== 'admission-policy-head-certificate'
    || !Array.isArray(value.votes) || value.votes.length < 4 || value.votes.length > 5) throw new Error('Policy freshness needs four distinct observers');
  const votes = value.votes.map(vote => parseAdmissionPolicyHeadVote(vote, request, context, now, work));
  if (new Set(votes.map(vote => vote.observer)).size !== votes.length
    || votes.some(vote => vote.head.revision !== current.revision || vote.head.digest !== current.digest || vote.head.transition !== current.transition)) throw new Error('Policy freshness votes disagree or repeat an observer');
  const result: AdmissionPolicyHeadCertificate = { version: 1, kind: 'admission-policy-head-certificate', votes };
  if (Buffer.byteLength(JSON.stringify(result)) > ADMISSION_POLICY_HEAD_MAX_BYTES) throw new Error('Policy freshness certificate exceeds its bound');
  return result;
}
