/** Durable admission votes and certificates. No provisional vote is ever refunded. */
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { SigningKeyPair } from '@resonance/core';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionKeyFingerprint, assertAdmissionPolicyCurrent, admissionPolicyKeys, isArchivedAdmissionKey, type SignedAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import {
  admissionWitnessSetId, admissionSpendClaimId, copyAdmissionSigningKey, createAdmissionWitnessRequest, createAdmissionWitnessVote,
  exactWitnessFields, verifyAdmissionWitnessRequest, verifyAdmissionWitnessVote, verifyAdmissionSpendCertificate,
  type AdmissionSpendClaim, type AdmissionWitnessRequest, type AdmissionWitnessVote, type AdmissionSpendCertificate, type AdmissionWitnessSet,
} from '@resonance/core/admission-witness';
import { requestAdmissionWitnessVote } from './admission-witness-transport.js';
import { planAdmissionHistoryRetirement, validRetiredIssuerKeys, type AdmissionHistoryMaintenance } from './admission-history-retirement.js';

interface CommonOptions {
  /** Operational callers must authenticate this policy first; the configured verifier does so. */
  directory: string; encryptionKey: Uint8Array; policy: SignedAdmissionPolicy; signingKey: SigningKeyPair;
  initialize?: boolean; now?: () => number; maxSpends?: number;
}
export interface AdmissionWitness { vote(request: unknown, acceptNew?: () => boolean): AdmissionWitnessVote; close(): void }
const indexKey = (claim: AdmissionSpendClaim) => `${claim.issuerKey}:${claim.spend}`;
function entries(policy: SignedAdmissionPolicy) {
  return new Map(admissionPolicyKeys(policy).map(key => [admissionKeyFingerprint(key.profile.issuerPublicKey), key]));
}
function current(policy: SignedAdmissionPolicy, entry: AdmissionPolicyKey, now: number) {
  assertAdmissionPolicyCurrent(policy, now);
  if (now < entry.notBefore || now >= entry.retryUntil) throw new Error('Admission witness key is retired or not yet active');
}
function capacity(value = 10000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('Invalid witness history capacity');
  return value;
}

export function createAdmissionWitness(options: CommonOptions): AdmissionWitness & AdmissionHistoryMaintenance {
  const limit = capacity(options.maxSpends), policy = structuredClone(options.policy), byKey = entries(policy), key = copyAdmissionSigningKey(options.signingKey);
  const publicKey = Buffer.from(key.publicKey).toString('base64url'), now = options.now ?? Date.now;
  type State = { version: 1 | 2; witness: string; votes: AdmissionWitnessVote[]; retiredIssuerKeys?: string[] };
  const votes = new Map<string, AdmissionWitnessVote>();
  const retired = new Set<string>();
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    if (!admissionPolicyKeys(policy).some(entry => entry.witnesses?.members.some(member => member.publicKey === publicKey))) throw new Error('Witness key is absent from signed membership');
    storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-witness-votes.json'), key: options.encryptionKey,
      domain: 'resonance:admission-witness-votes:v1', maxBytes: 16 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing', initial: { version: 2, witness: publicKey, votes: [], retiredIssuerKeys: [] },
      validate(value): value is State {
        const version = (value as State | null)?.version;
        if (!exactWitnessFields(value, ['version','witness','votes', ...(version === 2 ? ['retiredIssuerKeys'] : [])])
          || (version !== 1 && version !== 2) || value.witness !== publicKey
          || (version === 2 && !validRetiredIssuerKeys(value.retiredIssuerKeys, policy, publicKey, 'witness'))
          || !Array.isArray(value.votes) || value.votes.length > limit) return false;
        const retiredKeys = new Set(version === 2 ? value.retiredIssuerKeys as string[] : []);
        const seen = new Set<string>();
        return value.votes.every(vote => {
          const set = byKey.get(vote?.issuerKey)?.witnesses;
          if (!set || retiredKeys.has(vote?.issuerKey) || vote.witness !== publicKey || !verifyAdmissionWitnessVote(vote, vote, set) || seen.has(indexKey(vote))) return false;
          seen.add(indexKey(vote)); return true;
        });
      } });
    for (const vote of storage.read().votes) votes.set(indexKey(vote), vote);
    for (const id of storage.read().retiredIssuerKeys ?? []) retired.add(id);
  } catch (error) { key.secretKey.fill(0); throw error; }
  const planRetirement = (issuerKey: string) => planAdmissionHistoryRetirement({ role: 'witness', participant: publicKey, policy, issuerKey,
    state: storage.read(), retiredIssuerKeys: [...retired], entries: votes.size,
    remove: [...votes.values()].filter(vote => vote.issuerKey === issuerKey).length, maximumEntries: limit, now: now() });
  return {
    planRetirement,
    retire(issuerKey, approvedDigest) {
      const plan = planRetirement(issuerKey);
      if (approvedDigest !== plan.approvalDigest) throw new Error('Admission history changed or approval does not match; review retirement again');
      const retainedVotes = [...votes.values()].filter(vote => vote.issuerKey !== issuerKey);
      // The irreversible fence and removal are ONE atomic flushed snapshot.
      storage.write({ version: 2, witness: publicKey, retiredIssuerKeys: [...retired, issuerKey].sort(), votes: retainedVotes });
      retired.add(issuerKey); votes.clear(); for (const vote of retainedVotes) votes.set(indexKey(vote), vote);
      return plan;
    },
    vote(value, acceptNew) {
      storage.read();
      const issuerKey = value && typeof value === 'object' ? (value as AdmissionWitnessRequest).issuerKey : undefined;
      const entry = issuerKey ? byKey.get(issuerKey) : undefined;
      if (!entry?.witnesses || !entry.witnesses.members.some(member => member.publicKey === publicKey)
        || !verifyAdmissionWitnessRequest(value, entry.witnesses)) throw new Error('Unauthenticated admission vote request');
      if (retired.has(value.issuerKey) || isArchivedAdmissionKey(policy, value.issuerKey)) throw new Error('Admission issuer key is permanently retired on this witness');
      const time = now(); current(policy, entry, time);
      const previous = votes.get(indexKey(value));
      if (previous) {
        if (admissionSpendClaimId(previous) !== admissionSpendClaimId(value)) throw new Error('Conflicting admission vote');
        return structuredClone(previous);
      }
      if (time >= entry.spendUntil) throw new Error('New admission votes are retired');
      if (acceptNew?.() === false) throw new Error('Admission witness owner paused new votes');
      // An owner callback can close this role or run maintenance before returning.
      storage.read();
      if (retired.has(value.issuerKey) || isArchivedAdmissionKey(policy, value.issuerKey)) throw new Error('Admission issuer key is permanently retired on this witness');
      const afterOwner = now(); current(policy, entry, afterOwner);
      if (afterOwner >= entry.spendUntil) throw new Error('New admission votes are retired');
      if (votes.size >= limit) throw new Error('Admission witness history is full');
      const vote = createAdmissionWitnessVote(value, key);
      // No signature can escape before its immutable decision is flushed.
      storage.write({ version: 2, witness: publicKey, votes: [...votes.values(), vote], retiredIssuerKeys: [...retired].sort() });
      votes.set(indexKey(value), vote);
      return structuredClone(vote);
    },
    close() { storage.close(); key.secretKey.fill(0); },
  };
}

export type AdmissionWitnessTransport = (member: AdmissionWitnessSet['members'][number], request: AdmissionWitnessRequest, signal: AbortSignal) => Promise<unknown>;
export function createAdmissionQuorumGate(options: CommonOptions & { transport?: AdmissionWitnessTransport; timeoutMs?: number; onTransportSocket?: (socket: Socket) => void }) {
  const limit = capacity(options.maxSpends), policy = structuredClone(options.policy), byKey = entries(policy), key = copyAdmissionSigningKey(options.signingKey);
  const publicKey = Buffer.from(key.publicKey).toString('base64url'), now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 3000;
  type State = { version: 1 | 2; coordinator: string; certificates: AdmissionSpendCertificate[]; retiredIssuerKeys?: string[] };
  const certificates = new Map<string, AdmissionSpendCertificate>();
  const retired = new Set<string>();
  const pending = new Set<AbortController>();
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000) throw new Error('Invalid witness deadline');
    if (!admissionPolicyKeys(policy).some(entry => entry.witnesses?.coordinators.includes(publicKey))) throw new Error('Coordinator key is absent from signed membership');
    storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-witness-certificates.json'), key: options.encryptionKey,
      domain: 'resonance:admission-witness-certificates:v1', maxBytes: 32 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing', initial: { version: 2, coordinator: publicKey, certificates: [], retiredIssuerKeys: [] },
      validate(value): value is State {
        const version = (value as State | null)?.version;
        if (!exactWitnessFields(value, ['version','coordinator','certificates', ...(version === 2 ? ['retiredIssuerKeys'] : [])])
          || (version !== 1 && version !== 2) || value.coordinator !== publicKey
          || (version === 2 && !validRetiredIssuerKeys(value.retiredIssuerKeys, policy, publicKey, 'coordinator'))
          || !Array.isArray(value.certificates) || value.certificates.length > limit) return false;
        const retiredKeys = new Set(version === 2 ? value.retiredIssuerKeys as string[] : []);
        const seen = new Set<string>();
        return value.certificates.every(cert => {
          const claim = cert?.votes?.[0], set = byKey.get(claim?.issuerKey)?.witnesses;
          if (!set || !claim || retiredKeys.has(claim.issuerKey) || !verifyAdmissionSpendCertificate(cert, claim, set) || seen.has(indexKey(claim))) return false;
          seen.add(indexKey(claim)); return true;
        });
      } });
    for (const cert of storage.read().certificates) certificates.set(indexKey(cert.votes[0]), cert);
    for (const id of storage.read().retiredIssuerKeys ?? []) retired.add(id);
  } catch (error) { key.secretKey.fill(0); throw error; }
  const planRetirement = (issuerKey: string) => {
    if (pending.size) throw new Error('Cannot compact admission history while quorum attempts are in progress');
    return planAdmissionHistoryRetirement({ role: 'coordinator', participant: publicKey, policy, issuerKey,
      state: storage.read(), retiredIssuerKeys: [...retired], entries: certificates.size,
      remove: [...certificates.values()].filter(cert => cert.votes[0].issuerKey === issuerKey).length, maximumEntries: limit, now: now() });
  };
  return {
    planRetirement,
    retire(issuerKey: string, approvedDigest: string) {
      const plan = planRetirement(issuerKey);
      if (approvedDigest !== plan.approvalDigest) throw new Error('Admission history changed or approval does not match; review retirement again');
      const retainedCertificates = [...certificates.values()].filter(cert => cert.votes[0].issuerKey !== issuerKey);
      storage.write({ version: 2, coordinator: publicKey, retiredIssuerKeys: [...retired, issuerKey].sort(), certificates: retainedCertificates });
      retired.add(issuerKey); certificates.clear(); for (const cert of retainedCertificates) certificates.set(indexKey(cert.votes[0]), cert);
      return plan;
    },
    async authorize(issuerKey: string, spend: string, context: { action: AdmissionSpendClaim['action']; requestBinding: string }) {
      storage.read();
      const entry = byKey.get(issuerKey);
      if (!entry?.witnesses || !entry.witnesses.coordinators.includes(publicKey)) throw new Error('No authorized witness coordinator for issuer key');
      if (retired.has(issuerKey) || isArchivedAdmissionKey(policy, issuerKey)) throw new Error('Admission issuer key is permanently retired on this coordinator');
      current(policy, entry, now());
      const claim: AdmissionSpendClaim = { setId: admissionWitnessSetId(entry.witnesses), issuerKey, spend, action: context.action, requestBinding: context.requestBinding };
      const cached = certificates.get(indexKey(claim));
      if (cached) {
        if (!verifyAdmissionSpendCertificate(cached, claim, entry.witnesses)) throw new Error('Conflicting admission certificate');
        return;
      }
      if (pending.size >= 32 || certificates.size >= limit) throw new Error('Admission quorum capacity exhausted');
      const controller = new AbortController(); pending.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const request = createAdmissionWitnessRequest(claim, key);
        const cert = await collectVotes(entry.witnesses, request, controller.signal, options.transport
          ?? ((member, req, signal) => requestAdmissionWitnessVote(member, req, signal, options.onTransportSocket)));
        storage.read(); current(policy, entry, now());
        if (retired.has(issuerKey) || isArchivedAdmissionKey(policy, issuerKey)) throw new Error('Admission issuer key is permanently retired on this coordinator');
        if (controller.signal.aborted) throw new Error('Admission quorum cancelled');
        if (!verifyAdmissionSpendCertificate(cert, claim, entry.witnesses)) throw new Error('Invalid admission certificate');
        const existing = certificates.get(indexKey(claim));
        if (existing) {
          if (!verifyAdmissionSpendCertificate(existing, claim, entry.witnesses)) throw new Error('Conflicting admission certificate');
          return;
        }
        if (certificates.size >= limit) throw new Error('Admission certificate history is full');
        storage.write({ version: 2, coordinator: publicKey, certificates: [...certificates.values(), cert], retiredIssuerKeys: [...retired].sort() });
        certificates.set(indexKey(claim), cert);
      } finally { clearTimeout(timer); controller.abort(); pending.delete(controller); }
    },
    close() { for (const controller of pending) controller.abort(); storage.close(); key.secretKey.fill(0); },
  };
}

function collectVotes(set: AdmissionWitnessSet, request: AdmissionWitnessRequest, signal: AbortSignal, transport: AdmissionWitnessTransport): Promise<AdmissionSpendCertificate> {
  return new Promise((resolve, reject) => {
    const votes = new Map<string, AdmissionWitnessVote>(); let remaining = 5, settled = false;
    const finish = (cert?: AdmissionSpendCertificate) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort);
      if (cert) resolve(cert); else reject(new Error('Four admission witnesses are unavailable or disagree'));
    };
    const abort = () => finish();
    if (signal.aborted) { finish(); return; }
    signal.addEventListener('abort', abort, { once: true });
    for (const member of set.members) {
      // Catch synchronous injected transport failures too. Late votes cannot commit.
      void Promise.resolve().then(() => signal.aborted ? undefined : transport(member, request, signal)).then(value => {
        if (!settled && verifyAdmissionWitnessVote(value, request, set) && value.witness === member.publicKey) votes.set(value.witness, structuredClone(value));
      }).catch(() => {}).finally(() => {
        remaining--;
        if (votes.size >= 4) finish({ version: 1, votes: [...votes.values()] });
        else if (votes.size + remaining < 4) finish();
      });
    }
  });
}
