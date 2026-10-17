/** Fixed-membership, four-of-five admission votes. Contains no bearer token or user identity. */
import { createHash } from 'node:crypto';
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { isRelayAdmissionActionV2, type RelayAdmissionActionV2 } from './admission-v2.js';
import { assertSecureRelayTransportEndpoint } from './relay-transport.js';

export interface AdmissionWitnessSet {
  version: 1; quorum: 4;
  members: Array<{ publicKey: string; endpoint: string }>;
  /** Infrastructure signing keys allowed to request votes; never client keys. */
  coordinators: string[];
}
export interface AdmissionSpendClaim {
  setId: string; issuerKey: string; spend: string; action: RelayAdmissionActionV2; requestBinding: string;
}
export interface AdmissionWitnessRequest extends AdmissionSpendClaim {
  version: 1; kind: 'admission-witness-request'; coordinator: string; signature: string;
}
export interface AdmissionWitnessVote extends AdmissionSpendClaim {
  version: 1; kind: 'admission-witness-vote'; witness: string; signature: string;
}
export interface AdmissionSpendCertificate { version: 1; votes: AdmissionWitnessVote[] }
const DOMAIN = 'resonance:admission-witness:v1';
export const exactWitnessFields = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...fields].sort().join(',');
export function witnessBytes(v: unknown, size: number): v is string {
  return typeof v === 'string' && v.length <= 100 && Buffer.from(v, 'base64url').length === size
    && Buffer.from(v, 'base64url').toString('base64url') === v;
}
export function parseAdmissionWitnessSet(value: unknown): AdmissionWitnessSet {
  if (!exactWitnessFields(value, ['version','quorum','members','coordinators']) || value.version !== 1 || value.quorum !== 4
    || !Array.isArray(value.members) || value.members.length !== 5 || !Array.isArray(value.coordinators)
    || value.coordinators.length < 1 || value.coordinators.length > 8 || !value.coordinators.every(v => witnessBytes(v, 32))) throw new Error('Invalid four-of-five witness set');
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey','endpoint']) || !witnessBytes(member.publicKey, 32)
      || typeof member.endpoint !== 'string' || member.endpoint.length > 512) throw new Error('Invalid admission witness');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  }).sort((a, b) => a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0);
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5
    || new Set(value.coordinators).size !== value.coordinators.length) throw new Error('Witness membership must be distinct');
  return { version: 1, quorum: 4, members, coordinators: [...value.coordinators].sort() as string[] };
}
export function admissionWitnessSetId(set: AdmissionWitnessSet): string {
  return `sha256:${createHash('sha256').update(`${DOMAIN}:membership\n${JSON.stringify(set)}`).digest('hex')}`;
}
const claimFields = ['setId','issuerKey','spend','action','requestBinding'];
export function validAdmissionSpendClaim(value: AdmissionSpendClaim): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value.setId) && /^sha256:[a-f0-9]{64}$/.test(value.issuerKey)
    && witnessBytes(value.spend, 32) && isRelayAdmissionActionV2(value.action)
    && typeof value.requestBinding === 'string' && /^admreq_[A-Za-z0-9_-]{86}$/.test(value.requestBinding);
}
export function admissionSpendClaimId(claim: AdmissionSpendClaim): string {
  return JSON.stringify([claim.setId, claim.issuerKey, claim.spend, claim.action, claim.requestBinding]);
}
function payload(kind: string, claim: AdmissionSpendClaim, key: string) {
  return Buffer.from(`${DOMAIN}:${kind}\n${admissionSpendClaimId(claim)}\n${key}`);
}
export function copyAdmissionSigningKey(key: SigningKeyPair): SigningKeyPair {
  const owned = { publicKey: Uint8Array.from(key.publicKey), secretKey: Uint8Array.from(key.secretKey) };
  try {
    if (owned.publicKey.length !== 32 || owned.secretKey.length !== 64
      || !verify(Buffer.from(DOMAIN), sign(Buffer.from(DOMAIN), owned.secretKey), owned.publicKey)) throw new Error('Invalid admission infrastructure signing key');
    return owned;
  } catch (error) { owned.secretKey.fill(0); throw error; }
}
export function createAdmissionWitnessRequest(claim: AdmissionSpendClaim, key: SigningKeyPair): AdmissionWitnessRequest {
  if (!validAdmissionSpendClaim(claim)) throw new Error('Invalid admission spend claim');
  const coordinator = Buffer.from(key.publicKey).toString('base64url');
  return { ...claim, version: 1, kind: 'admission-witness-request', coordinator,
    signature: Buffer.from(sign(payload('request', claim, coordinator), key.secretKey)).toString('base64url') };
}
export function verifyAdmissionWitnessRequest(value: unknown, set: AdmissionWitnessSet): value is AdmissionWitnessRequest {
  if (!exactWitnessFields(value, [...claimFields,'version','kind','coordinator','signature']) || value.version !== 1
    || value.kind !== 'admission-witness-request' || !witnessBytes(value.coordinator, 32) || !witnessBytes(value.signature, 64)) return false;
  const v = value as unknown as AdmissionWitnessRequest;
  return validAdmissionSpendClaim(v) && v.setId === admissionWitnessSetId(set) && set.coordinators.includes(v.coordinator)
    && verify(payload('request', v, v.coordinator), Buffer.from(v.signature, 'base64url'), Buffer.from(v.coordinator, 'base64url'));
}
export function createAdmissionWitnessVote(claim: AdmissionSpendClaim, key: SigningKeyPair): AdmissionWitnessVote {
  const witness = Buffer.from(key.publicKey).toString('base64url');
  return { setId: claim.setId, issuerKey: claim.issuerKey, spend: claim.spend, action: claim.action, requestBinding: claim.requestBinding,
    version: 1, kind: 'admission-witness-vote', witness,
    signature: Buffer.from(sign(payload('vote', claim, witness), key.secretKey)).toString('base64url') };
}
export function verifyAdmissionWitnessVote(value: unknown, claim: AdmissionSpendClaim, set: AdmissionWitnessSet): value is AdmissionWitnessVote {
  if (!exactWitnessFields(value, [...claimFields,'version','kind','witness','signature']) || value.version !== 1
    || value.kind !== 'admission-witness-vote' || !witnessBytes(value.witness, 32) || !witnessBytes(value.signature, 64)) return false;
  const v = value as unknown as AdmissionWitnessVote;
  return validAdmissionSpendClaim(v) && admissionSpendClaimId(v) === admissionSpendClaimId(claim)
    && v.setId === admissionWitnessSetId(set) && set.members.some(m => m.publicKey === v.witness)
    && verify(payload('vote', v, v.witness), Buffer.from(v.signature, 'base64url'), Buffer.from(v.witness, 'base64url'));
}
export function verifyAdmissionSpendCertificate(value: unknown, claim: AdmissionSpendClaim, set: AdmissionWitnessSet): value is AdmissionSpendCertificate {
  return exactWitnessFields(value, ['version','votes']) && value.version === 1 && Array.isArray(value.votes)
    && value.votes.length >= 4 && value.votes.length <= 5 && new Set(value.votes.map(v => v?.witness)).size === value.votes.length
    && value.votes.every(v => verifyAdmissionWitnessVote(v, claim, set));
}
