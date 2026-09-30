/** Offline invitation admission. No member identifier is added to issuance or redemption. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { prepareAdmissionBatchIssuer, validateAdmissionIssuanceTarget, type AdmissionIssuanceResponse } from './blind-admission-issuance.js';

export interface AdmissionIssuancePermit {
  version: 1; kind: 'admission-issuance-permit'; scope: AdmissionWalletProfileV1['scope'];
  keyFingerprint: string; count: number; secret: string;
}
export interface AdmissionIssuerPolicy { batchSize: number; maxPermits: number }
interface Entry { permitHash: string; batchId?: string; response?: AdmissionIssuanceResponse }
interface State { version: 1; profile: AdmissionWalletProfileV1; policy: AdmissionIssuerPolicy; entries: Entry[]; communityPolicy?: SignedAdmissionPolicy }
const DOMAIN = 'resonance:admission-issuer-ledger:v1';
const MAX_BYTES = 8 * 1024 * 1024;
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function validatePolicy(policy: unknown): asserts policy is AdmissionIssuerPolicy {
  if (!exact(policy, ['batchSize', 'maxPermits']) || !Number.isInteger(policy.batchSize) || (policy.batchSize as number) < 1 || (policy.batchSize as number) > 32
    || !Number.isInteger(policy.maxPermits) || (policy.maxPermits as number) < 1 || (policy.maxPermits as number) > 256) {
    throw new Error('Issuer policy requires a fixed batch size of 1–32 and a maximum of 1–256 permits');
  }
}
function permitHash(secret: string) { return createHash('sha256').update(`${DOMAIN}:permit\n${secret}`).digest('hex'); }
function validState(value: unknown, profile: AdmissionWalletProfileV1): value is State {
  if (!exact(value, (value as State)?.communityPolicy ? ['version', 'profile', 'policy', 'entries', 'communityPolicy'] : ['version', 'profile', 'policy', 'entries']) || value.version !== 1
    || JSON.stringify(value.profile) !== JSON.stringify(profile)) return false;
  try { validatePolicy(value.policy); } catch { return false; }
  if (!Array.isArray(value.entries) || value.entries.length > value.policy.maxPermits) return false;
  const permits = new Set<string>(); const batches = new Set<string>();
  for (const entry of value.entries) {
    if (!exact(entry, entry?.response !== undefined ? ['permitHash', 'batchId', 'response'] : entry?.batchId !== undefined ? ['permitHash', 'batchId'] : ['permitHash'])
      || !hex(entry.permitHash) || permits.has(entry.permitHash)) return false;
    permits.add(entry.permitHash);
    if (entry.batchId !== undefined) {
      if (!hex(entry.batchId) || batches.has(entry.batchId)) return false;
      batches.add(entry.batchId);
    }
    if (entry.response !== undefined) {
      const response = entry.response;
      if (!exact(response, ['version', 'kind', 'batchId', 'responses']) || response.version !== 1 || response.kind !== 'admission-issuance-response'
        || response.batchId !== entry.batchId || !Array.isArray(response.responses) || response.responses.length !== value.policy.batchSize
        || response.responses.some(bytes => typeof bytes !== 'string' || bytes.length !== 342 || Buffer.from(bytes, 'base64url').length !== 256
          || Buffer.from(bytes, 'base64url').toString('base64url') !== bytes)) return false;
    }
  }
  return true;
}

/** create is explicit initialization only. Ordinary opens MUST find the existing ledger.
 * A ledger and signing key belong to one operator/device; copying or rolling back them
 * defeats local allowance enforcement and is not a distributed issuance protocol.
 */
export async function openAdmissionIssuerLedger(options: {
  path: string; expectedProfile: unknown; privateKey: CryptoKey; create?: AdmissionIssuerPolicy; now?: () => number;
}) {
  const privateKey = options.privateKey;
  const create = options.create === undefined ? undefined : structuredClone(options.create);
  if (create) validatePolicy(create);
  const issuer = await prepareAdmissionBatchIssuer({ expectedProfile: options.expectedProfile, privateKey });
  const profile = structuredClone(issuer.profile);
  const privateBytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey));
  let key: Buffer;
  try { key = Buffer.from(hkdfSync('sha256', privateBytes, Buffer.alloc(0), DOMAIN, 32)); }
  finally { privateBytes.fill(0); }
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    storage = openEncryptedLocalState<State>({ path: options.path, key, domain: DOMAIN, maxBytes: MAX_BYTES,
      mode: create ? 'create-new' : 'open-existing',
      initial: { version: 1, profile, policy: create ?? { batchSize: 1, maxPermits: 1 }, entries: [] },
      validate: (value): value is State => validState(value, profile) });
  } finally { key.fill(0); }
  try { const policy = storage.read().communityPolicy; if (policy) {
    await verifyAdmissionPolicy(policy, policy.authority);
    if (!policy.keys.some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Issuer is absent from its signed community policy');
  } } catch (error) { storage.close(); throw error; }
  let busy = false;
  function checkPolicy(recover = false) {
    const policy = storage.read().communityPolicy; if (!policy) return;
    const now = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(policy, now);
    const id = admissionKeyFingerprint(profile.issuerPublicKey);
    const entry = policy.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id);
    if (!entry || now < entry.notBefore || now >= (recover ? entry.spendUntil : entry.issueUntil)
      || (!recover && policy.activeKey !== id)) throw new Error('Issuer is retired or inactive under the signed community policy');
  }
  function ready() { storage.read(); if (busy) throw new Error('Issuer approval is already in progress'); }
  function validatePermit(value: unknown): asserts value is AdmissionIssuancePermit {
    const state = storage.read();
    if (!exact(value, ['version', 'kind', 'scope', 'keyFingerprint', 'count', 'secret']) || value.version !== 1 || value.kind !== 'admission-issuance-permit'
      || !exact(value.scope, ['issuer', 'community', 'epoch'])
      || value.scope.issuer !== profile.scope.issuer || value.scope.community !== profile.scope.community || value.scope.epoch !== profile.scope.epoch
      || value.keyFingerprint !== admissionKeyFingerprint(profile.issuerPublicKey) || value.count !== state.policy.batchSize
      || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
      || Buffer.from(value.secret, 'base64url').toString('base64url') !== value.secret) throw new Error('Invalid permit for this issuer policy');
  }
  return {
    async installPolicy(value: unknown, authority: string) {
      ready(); const state = storage.read();
      if (state.communityPolicy && state.communityPolicy.authority !== authority) throw new Error('Community authority is already pinned');
      busy = true;
      try {
        const policy = await verifyAdmissionPolicy(value, authority); storage.read();
        assertAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
        if (state.communityPolicy) assertAdmissionPolicySuccessor(state.communityPolicy, policy);
        if (!policy.keys.some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Issuer is absent from the signed community policy');
        storage.write({ ...state, communityPolicy: policy });
      } finally { busy = false; }
    },
    status() {
      const { policy, entries } = storage.read();
      const bound = entries.filter(entry => entry.batchId).length; const completed = entries.filter(entry => entry.response).length;
      return { ...policy, allocatedPermits: entries.length, remainingPermits: policy.maxPermits - entries.length,
        boundPermits: bound, completedPermits: completed, tokenBudget: policy.batchSize * policy.maxPermits,
        allocatedTokens: entries.length * policy.batchSize, boundTokens: bound * policy.batchSize };
    },
    /** An explicit community invitation, with no recipient/account field. Never refund or reuse. */
    grant(): AdmissionIssuancePermit {
      ready(); checkPolicy(); const state = storage.read();
      if (state.entries.length >= state.policy.maxPermits) throw new Error('Issuer permit allowance exhausted');
      const secret = randomBytes(32).toString('base64url');
      storage.write({ ...state, entries: [...state.entries, { permitHash: permitHash(secret) }] });
      return { version: 1, kind: 'admission-issuance-permit', scope: structuredClone(profile.scope),
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), count: state.policy.batchSize, secret };
    },
    async approve(permitValue: unknown, requestValue: unknown): Promise<AdmissionIssuanceResponse> {
      ready(); validatePermit(permitValue); validateAdmissionIssuanceTarget(requestValue, profile);
      const request = structuredClone(requestValue); const digest = permitHash(permitValue.secret);
      const state = storage.read(); const index = state.entries.findIndex(entry => entry.permitHash === digest);
      if (index < 0) throw new Error('Unknown issuance permit');
      if (request.requests.length !== state.policy.batchSize) throw new Error(`This permit requires exactly ${state.policy.batchSize} blinded requests`);
      const entry = state.entries[index];
      if (entry.batchId && entry.batchId !== request.batchId) throw new Error('Permit is already bound to another batch; only the exact original request can be retried');
      if (state.entries.some((other, i) => i !== index && other.batchId === request.batchId)) throw new Error('Batch is already assigned to another permit');
      if (entry.response) { checkPolicy(true); return structuredClone(entry.response); }
      checkPolicy();
      busy = true;
      try {
        // Reserve the ENTIRE batch before the first blind signature. A crash or lost
        // output leaves only this exact batch eligible. Nothing ever refunds its allowance.
        if (!entry.batchId) storage.write({ ...state, entries: state.entries.map((item, i) => i === index ? { ...item, batchId: request.batchId } : item) });
        const response = await issuer.issue(request);
        checkPolicy();
        const reserved = storage.read(); // Lock/close during crypto must prevent output.
        storage.write({ ...reserved, entries: reserved.entries.map((item, i) => i === index ? { ...item, response } : item) });
        return structuredClone(response); // Only a durably cached response may leave this boundary.
      } finally { busy = false; }
    },
    close() { storage.close(); },
  };
}
export type AdmissionIssuerLedger = Awaited<ReturnType<typeof openAdmissionIssuerLedger>>;
