/** Durable admission votes and certificates. No provisional vote is ever refunded. */
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { SigningKeyPair } from '@resonance/core';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionKeyFingerprint, assertAdmissionPolicyCurrent, type SignedAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import {
  admissionWitnessSetId, admissionSpendClaimId, copyAdmissionSigningKey, createAdmissionWitnessRequest, createAdmissionWitnessVote,
  exactWitnessFields, verifyAdmissionWitnessRequest, verifyAdmissionWitnessVote, verifyAdmissionSpendCertificate,
  type AdmissionSpendClaim, type AdmissionWitnessRequest, type AdmissionWitnessVote, type AdmissionSpendCertificate, type AdmissionWitnessSet,
} from '@resonance/core/admission-witness';
import { requestAdmissionWitnessVote } from './admission-witness-transport.js';

interface CommonOptions {
  /** Operational callers must authenticate this policy first; the configured verifier does so. */
  directory: string; encryptionKey: Uint8Array; policy: SignedAdmissionPolicy; signingKey: SigningKeyPair;
  initialize?: boolean; now?: () => number; maxSpends?: number;
}
export interface AdmissionWitness { vote(request: unknown, acceptNew?: () => boolean): AdmissionWitnessVote; close(): void }
const indexKey = (claim: AdmissionSpendClaim) => `${claim.issuerKey}:${claim.spend}`;
function entries(policy: SignedAdmissionPolicy) {
  return new Map(policy.keys.map(key => [admissionKeyFingerprint(key.profile.issuerPublicKey), key]));
}
function current(policy: SignedAdmissionPolicy, entry: AdmissionPolicyKey, now: number) {
  assertAdmissionPolicyCurrent(policy, now);
  if (now < entry.notBefore || now >= entry.retryUntil) throw new Error('Admission witness key is retired or not yet active');
}
function capacity(value = 10000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('Invalid witness history capacity');
  return value;
}

export function createAdmissionWitness(options: CommonOptions): AdmissionWitness {
  const limit = capacity(options.maxSpends), policy = structuredClone(options.policy), byKey = entries(policy), key = copyAdmissionSigningKey(options.signingKey);
  const publicKey = Buffer.from(key.publicKey).toString('base64url'), now = options.now ?? Date.now;
  type State = { version: 1; witness: string; votes: AdmissionWitnessVote[] };
  const votes = new Map<string, AdmissionWitnessVote>();
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    if (!policy.keys.some(entry => entry.witnesses?.members.some(member => member.publicKey === publicKey))) throw new Error('Witness key is absent from signed membership');
    storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-witness-votes.json'), key: options.encryptionKey,
      domain: 'resonance:admission-witness-votes:v1', maxBytes: 16 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing', initial: { version: 1, witness: publicKey, votes: [] },
      validate(value): value is State {
        if (!exactWitnessFields(value, ['version','witness','votes']) || value.version !== 1 || value.witness !== publicKey
          || !Array.isArray(value.votes) || value.votes.length > limit) return false;
        const seen = new Set<string>();
        return value.votes.every(vote => {
          const set = byKey.get(vote?.issuerKey)?.witnesses;
          if (!set || vote.witness !== publicKey || !verifyAdmissionWitnessVote(vote, vote, set) || seen.has(indexKey(vote))) return false;
          seen.add(indexKey(vote)); return true;
        });
      } });
    for (const vote of storage.read().votes) votes.set(indexKey(vote), vote);
  } catch (error) { key.secretKey.fill(0); throw error; }
  return {
    vote(value, acceptNew) {
      storage.read();
      const issuerKey = value && typeof value === 'object' ? (value as AdmissionWitnessRequest).issuerKey : undefined;
      const entry = issuerKey ? byKey.get(issuerKey) : undefined;
      if (!entry?.witnesses || !entry.witnesses.members.some(member => member.publicKey === publicKey)
        || !verifyAdmissionWitnessRequest(value, entry.witnesses)) throw new Error('Unauthenticated admission vote request');
      const time = now(); current(policy, entry, time);
      const previous = votes.get(indexKey(value));
      if (previous) {
        if (admissionSpendClaimId(previous) !== admissionSpendClaimId(value)) throw new Error('Conflicting admission vote');
        return structuredClone(previous);
      }
      if (time >= entry.spendUntil) throw new Error('New admission votes are retired');
      if (acceptNew?.() === false) throw new Error('Admission witness owner paused new votes');
      if (votes.size >= limit) throw new Error('Admission witness history is full');
      const vote = createAdmissionWitnessVote(value, key);
      // No signature can escape before its immutable decision is flushed.
      storage.write({ version: 1, witness: publicKey, votes: [...votes.values(), vote] });
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
  type State = { version: 1; coordinator: string; certificates: AdmissionSpendCertificate[] };
  const certificates = new Map<string, AdmissionSpendCertificate>();
  const pending = new Set<AbortController>();
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000) throw new Error('Invalid witness deadline');
    if (!policy.keys.some(entry => entry.witnesses?.coordinators.includes(publicKey))) throw new Error('Coordinator key is absent from signed membership');
    storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-witness-certificates.json'), key: options.encryptionKey,
      domain: 'resonance:admission-witness-certificates:v1', maxBytes: 32 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing', initial: { version: 1, coordinator: publicKey, certificates: [] },
      validate(value): value is State {
        if (!exactWitnessFields(value, ['version','coordinator','certificates']) || value.version !== 1 || value.coordinator !== publicKey
          || !Array.isArray(value.certificates) || value.certificates.length > limit) return false;
        const seen = new Set<string>();
        return value.certificates.every(cert => {
          const claim = cert?.votes?.[0], set = byKey.get(claim?.issuerKey)?.witnesses;
          if (!set || !claim || !verifyAdmissionSpendCertificate(cert, claim, set) || seen.has(indexKey(claim))) return false;
          seen.add(indexKey(claim)); return true;
        });
      } });
    for (const cert of storage.read().certificates) certificates.set(indexKey(cert.votes[0]), cert);
  } catch (error) { key.secretKey.fill(0); throw error; }
  return {
    async authorize(issuerKey: string, spend: string, context: { action: AdmissionSpendClaim['action']; requestBinding: string }) {
      storage.read();
      const entry = byKey.get(issuerKey);
      if (!entry?.witnesses || !entry.witnesses.coordinators.includes(publicKey)) throw new Error('No authorized witness coordinator for issuer key');
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
        if (controller.signal.aborted) throw new Error('Admission quorum cancelled');
        if (!verifyAdmissionSpendCertificate(cert, claim, entry.witnesses)) throw new Error('Invalid admission certificate');
        const existing = certificates.get(indexKey(claim));
        if (existing) {
          if (!verifyAdmissionSpendCertificate(existing, claim, entry.witnesses)) throw new Error('Conflicting admission certificate');
          return;
        }
        if (certificates.size >= limit) throw new Error('Admission certificate history is full');
        storage.write({ version: 1, coordinator: publicKey, certificates: [...certificates.values(), cert] });
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
