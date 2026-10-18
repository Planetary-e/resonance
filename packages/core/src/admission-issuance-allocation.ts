/** Offline authority allocation. This bounds an honest authority workflow, not copied keys or rolled-back journals. */
import { createHash } from 'node:crypto';
import { sign, verify } from './crypto.js';
import { admissionKeyFingerprint, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-profile.js';

export interface AdmissionIssuerAllocation { profile: AdmissionWalletProfileV1; batchSize: number; maxPermits: number }
export interface AdmissionIssuanceAllocationBody {
  version: 1; kind: 'admission-issuance-allocation'; community: 'public'; epoch: string;
  notBefore: number; issueUntil: number; totalTokenBudget: number; allocations: AdmissionIssuerAllocation[];
}
export interface SignedAdmissionIssuanceAllocation extends AdmissionIssuanceAllocationBody { authority: string; signature: string }
export const MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES = 65536;
// Eight issuers × 32 tokens × 256 permits. This explicit pilot bound keeps aggregate arithmetic and local state bounded.
export const MAX_ADMISSION_ISSUANCE_TOKEN_BUDGET = 65536;
const DOMAIN = 'resonance:admission-issuance-allocation:v1';
const FIELDS = ['version', 'kind', 'community', 'epoch', 'notBefore', 'issueUntil', 'totalTokenBudget', 'allocations'];
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const encoded = (value: unknown, size: number): value is string => typeof value === 'string' && value.length <= 100
  && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value;
function payload(body: AdmissionIssuanceAllocationBody) {
  return Buffer.from(`${DOMAIN}\n${JSON.stringify([body.version, body.kind, body.community, body.epoch,
    body.notBefore, body.issueUntil, body.totalTokenBudget, body.allocations.map(entry => [entry.profile, entry.batchSize, entry.maxPermits])])}`);
}
/** Structural normalization only: authenticate with verify before trusting a received allocation. */
export async function parseAdmissionIssuanceAllocationBody(value: unknown): Promise<AdmissionIssuanceAllocationBody> {
  if (!exact(value, FIELDS) || value.version !== 1 || value.kind !== 'admission-issuance-allocation' || value.community !== 'public'
    || typeof value.epoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.epoch)
    || !integer(value.notBefore, 0) || !integer(value.issueUntil, 0) || value.notBefore >= value.issueUntil
    || !integer(value.totalTokenBudget, 1, MAX_ADMISSION_ISSUANCE_TOKEN_BUDGET)
    || !Array.isArray(value.allocations) || value.allocations.length < 1 || value.allocations.length > 8
    || Buffer.byteLength(JSON.stringify(value)) > MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES) throw new Error('Invalid admission issuance allocation');
  const input = structuredClone(value); const allocations: AdmissionIssuerAllocation[] = [], seen = new Set<string>();
  let total = 0;
  for (const entry of input.allocations as unknown[]) {
    if (!exact(entry, ['profile', 'batchSize', 'maxPermits']) || !integer(entry.batchSize, 1, 32) || !integer(entry.maxPermits, 1, 256)) throw new Error('Invalid issuer allocation limits');
    const { profile } = await parseAdmissionWalletProfile(entry.profile);
    if (profile.scope.community !== input.community || profile.scope.epoch !== input.epoch) throw new Error('Issuer allocation scope does not match the community epoch');
    const id = admissionKeyFingerprint(profile.issuerPublicKey);
    if (seen.has(id)) throw new Error('Duplicate issuer key in admission allocation');
    seen.add(id); total += entry.batchSize * entry.maxPermits;
    if (total > (input.totalTokenBudget as number)) throw new Error('Issuer allocations exceed the total token budget');
    allocations.push({ profile, batchSize: entry.batchSize, maxPermits: entry.maxPermits });
  }
  allocations.sort((a, b) => admissionKeyFingerprint(a.profile.issuerPublicKey).localeCompare(admissionKeyFingerprint(b.profile.issuerPublicKey)));
  return { version: 1, kind: 'admission-issuance-allocation', community: 'public', epoch: input.epoch as string,
    notBefore: input.notBefore as number, issueUntil: input.issueUntil as number, totalTokenBudget: input.totalTokenBudget as number, allocations };
}
export async function signAdmissionIssuanceAllocation(value: unknown, authority: string, secretKey: Uint8Array): Promise<SignedAdmissionIssuanceAllocation> {
  if (!encoded(authority, 32)) throw new Error('Invalid allocation authority');
  const secret = Uint8Array.from(secretKey);
  try {
    const body = await parseAdmissionIssuanceAllocationBody(value), signature = sign(payload(body), secret);
    if (!verify(payload(body), signature, Buffer.from(authority, 'base64url'))) throw new Error('Allocation authority private key does not match');
    const signed = { ...body, authority, signature: Buffer.from(signature).toString('base64url') };
    if (Buffer.byteLength(JSON.stringify(signed) + '\n') > MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES) throw new Error('Signed admission allocation exceeds its byte limit');
    return signed;
  } finally { secret.fill(0); }
}
/** Historical verification intentionally does not require a currently open issuance window. */
export async function verifyAdmissionIssuanceAllocation(value: unknown, authority: string): Promise<SignedAdmissionIssuanceAllocation> {
  if (!encoded(authority, 32) || !exact(value, [...FIELDS, 'authority', 'signature']) || value.authority !== authority
    || !encoded(value.signature, 64) || Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES) throw new Error('Allocation is not signed by the pinned authority');
  const input = structuredClone(value), { signature, authority: _, ...unsigned } = input;
  const body = await parseAdmissionIssuanceAllocationBody(unsigned);
  if (!verify(payload(body), Buffer.from(signature as string, 'base64url'), Buffer.from(authority, 'base64url'))) throw new Error('Invalid admission allocation signature');
  return { ...body, authority, signature: signature as string };
}
/** Requires the normalized signed result returned by sign/verify; does not itself authenticate or parse inputs. */
export function admissionIssuanceAllocationDigest(normalizedSigned: SignedAdmissionIssuanceAllocation): string {
  return `sha256:${createHash('sha256').update('resonance:admission-issuance-allocation-digest:v1\n').update(payload(normalizedSigned))
    .update(JSON.stringify([normalizedSigned.authority, normalizedSigned.signature])).digest('hex')}`;
}
export function assertAdmissionIssuanceAllocationCurrent(allocation: AdmissionIssuanceAllocationBody, now: number): void {
  if (!integer(now, 0) || now < allocation.notBefore || now >= allocation.issueUntil) throw new Error('Admission issuance allocation is not current');
}
/** Both arguments must already be normalized and the manifest authenticated. Full profile equality pins scope and destinations. */
export function selectAdmissionIssuerAllocation(allocation: SignedAdmissionIssuanceAllocation, normalizedProfile: AdmissionWalletProfileV1): AdmissionIssuerAllocation {
  const entry = allocation.allocations.find(candidate => JSON.stringify(candidate.profile) === JSON.stringify(normalizedProfile));
  if (!entry) throw new Error('Issuer profile is absent from the signed admission allocation');
  return structuredClone(entry);
}
