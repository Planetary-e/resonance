/** Authority-assigned opaque operator claims. A claim handle is not proof of a person. */
import { sign, verify } from './crypto.js';
import { admissionKeyFingerprint } from './admission-profile.js';
import { admissionIssuanceAllocationDigest, verifyAdmissionIssuanceAllocation } from './admission-issuance-allocation.js';

export interface AdmissionClaimAssignmentBody {
  version: 1; kind: 'admission-claim-assignment'; authority: string; allocationDigest: string;
  community: 'public'; epoch: string; claimHandle: string; issuerKeyFingerprint: string;
}
export interface SignedAdmissionClaimAssignment extends AdmissionClaimAssignmentBody { signature: string }
export const MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES = 4096;
const DOMAIN = 'resonance:admission-claim-assignment:v1';
const FIELDS = ['version', 'kind', 'authority', 'allocationDigest', 'community', 'epoch', 'claimHandle', 'issuerKeyFingerprint'];
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const encoded = (value: unknown, size: number): value is string => typeof value === 'string' && value.length <= 100
  && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value;
function payload(body: AdmissionClaimAssignmentBody): Buffer {
  return Buffer.from(`${DOMAIN}\n${JSON.stringify([body.version, body.kind, body.authority, body.allocationDigest,
    body.community, body.epoch, body.claimHandle, body.issuerKeyFingerprint])}`);
}
/** Structural normalization only; received evidence must be authenticated with verify. */
export function parseAdmissionClaimAssignmentBody(value: unknown): AdmissionClaimAssignmentBody {
  if (!exact(value, FIELDS) || value.version !== 1 || value.kind !== 'admission-claim-assignment'
    || !encoded(value.authority, 32) || typeof value.allocationDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.allocationDigest)
    || value.community !== 'public' || typeof value.epoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.epoch)
    || !encoded(value.claimHandle, 32) || typeof value.issuerKeyFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.issuerKeyFingerprint)
    || Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES) throw new Error('Invalid admission claim assignment');
  return { version: 1, kind: 'admission-claim-assignment', authority: value.authority, allocationDigest: value.allocationDigest,
    community: 'public', epoch: value.epoch, claimHandle: value.claimHandle, issuerKeyFingerprint: value.issuerKeyFingerprint };
}
async function authenticateBindings(body: AdmissionClaimAssignmentBody, allocationManifest: unknown, authority: string) {
  const manifest = await verifyAdmissionIssuanceAllocation(allocationManifest, authority);
  if (manifest.version !== 2 || manifest.claimPolicy !== 'authority-assigned-v1') throw new Error('Claim assignment requires an authority-assigned v2 allocation');
  if (body.authority !== authority || body.allocationDigest !== admissionIssuanceAllocationDigest(manifest)
    || body.community !== manifest.community || body.epoch !== manifest.epoch
    || !manifest.allocations.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.issuerKeyFingerprint)) {
    throw new Error('Claim assignment does not match its pinned allocation, scope, or issuer');
  }
}
export async function signAdmissionClaimAssignment(value: unknown, allocationManifest: unknown, authority: string, secretKey: Uint8Array): Promise<SignedAdmissionClaimAssignment> {
  const body = parseAdmissionClaimAssignmentBody(value), manifest = structuredClone(allocationManifest), secret = Uint8Array.from(secretKey);
  try {
    await authenticateBindings(body, manifest, authority);
    const signature = sign(payload(body), secret);
    if (!verify(payload(body), signature, Buffer.from(authority, 'base64url'))) throw new Error('Claim assignment authority private key does not match');
    return { ...body, signature: Buffer.from(signature).toString('base64url') };
  } finally { secret.fill(0); }
}
/** Historical verification intentionally accepts cached assignments after allocation expiry. */
export async function verifyAdmissionClaimAssignment(value: unknown, allocationManifest: unknown, authority: string): Promise<SignedAdmissionClaimAssignment> {
  if (!exact(value, [...FIELDS, 'signature']) || !encoded(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES) throw new Error('Invalid signed admission claim assignment');
  const input = structuredClone(value), manifest = structuredClone(allocationManifest), { signature, ...unsigned } = input;
  const body = parseAdmissionClaimAssignmentBody(unsigned);
  await authenticateBindings(body, manifest, authority);
  if (!verify(payload(body), Buffer.from(signature as string, 'base64url'), Buffer.from(authority, 'base64url'))) throw new Error('Invalid admission claim assignment signature');
  return { ...body, signature: signature as string };
}
