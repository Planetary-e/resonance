import { assertArchivedAdmissionPolicyCurrent } from '@resonance/core/admission-policy-archive';
/** Role signatures/certificates become usable only after their decision is in
 * the protected four-copy owner history. Local role files are never a fallback. */
import type { Socket } from 'node:net';
import type { SigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, isArchivedAdmissionKey } from '@resonance/core/admission-policy';
import { admissionSpendClaimId, admissionWitnessSetId, copyAdmissionSigningKey, createAdmissionWitnessRequest, createAdmissionWitnessVote, verifyAdmissionSpendCertificate, verifyAdmissionWitnessRequest, type AdmissionSpendClaim, type AdmissionSpendCertificate, type AdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { collectAdmissionWitnessVotes, type AdmissionWitness, type AdmissionWitnessTransport } from './admission-witness.js';
import { requestAdmissionWitnessVote } from './admission-witness-transport.js';
import type { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';

export function createProtectedAdmissionRoles(options: {
  history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
  witnessKey?: SigningKeyPair; coordinatorKey?: SigningKeyPair; now?: () => number;
  transport?: AdmissionWitnessTransport; timeoutMs?: number; onTransportSocket?: (socket: Socket) => void;
}) {
  const { history } = options, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 3000;
  // The protected owner selects its policy at open/ready; a policy change opens
  // new adapters. Do not clone the complete spend/vote image for each lookup.
  const policy = history.policy(), byKey = new Map(policy.keys.map(entry => [admissionKeyFingerprint(entry.profile.issuerPublicKey), entry]));
  let witnessKey: SigningKeyPair | undefined, coordinatorKey: SigningKeyPair | undefined, closed = false, voting = false, coordinating = false;
  let pending: AbortController | undefined;
  let voteFinished: Promise<void> | undefined;
  const publicKey = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
  function close() { if (closed) return; closed = true; pending?.abort(); witnessKey?.secretKey.fill(0); coordinatorKey?.secretKey.fill(0); }
  const available = () => { if (closed) throw new Error('Protected admission roles are closed'); };
  function policyAndEntry(issuerKey: string) {
    available(); assertArchivedAdmissionPolicyCurrent(policy, now());
    const entry = byKey.get(issuerKey);
    if (!entry?.witnesses || (policy.version === 3 ? !byKey.has(issuerKey) : isArchivedAdmissionKey(policy, issuerKey)) || now() < entry.notBefore || now() >= entry.retryUntil) {
      throw new Error('Protected admission issuer is unavailable or retired');
    }
    return { policy, entry };
  }
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000) throw new Error('Invalid witness deadline');
    const roles = history.roleState();
    if (options.witnessKey) {
      witnessKey = copyAdmissionSigningKey(options.witnessKey);
      if (roles.witness?.witness !== publicKey(witnessKey)) throw new Error('Protected witness history must be captured or restored before serving');
    }
    if (options.coordinatorKey) {
      coordinatorKey = copyAdmissionSigningKey(options.coordinatorKey);
      if (roles.coordinator?.coordinator !== publicKey(coordinatorKey)) throw new Error('Protected coordinator history must be captured or restored before serving');
    }
  } catch (error) { close(); throw error; }
  const witness: AdmissionWitness | undefined = witnessKey ? {
    async vote(value, acceptNew) {
      available(); if (voting) throw new Error('Protected witness decision is in progress'); voting = true;
      let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; }); voteFinished = completed;
      try {
        const issuerKey = (value as AdmissionWitnessRequest | null)?.issuerKey;
        const { entry } = policyAndEntry(issuerKey!);
        if (!entry.witnesses!.members.some(member => member.publicKey === publicKey(witnessKey!))
          || !verifyAdmissionWitnessRequest(value, entry.witnesses!)) throw new Error('Unauthenticated admission vote request');
        const state = history.roleState().witness!;
        if (state.retiredIssuerKeys.includes(value.issuerKey)) throw new Error('Admission issuer key is permanently retired on this witness');
        const retained = history.pendingRoleDecision();
        const previous = retained?.kind === 'witness-vote' && retained.vote.issuerKey === value.issuerKey && retained.vote.spend === value.spend
          ? retained.vote : state.votes.find(vote => vote.issuerKey === value.issuerKey && vote.spend === value.spend);
        if (previous && admissionSpendClaimId(previous) !== admissionSpendClaimId(value)) throw new Error('Conflicting admission vote');
        if (!previous) {
          if (now() >= entry.spendUntil) throw new Error('New admission votes are retired');
          if (acceptNew?.() === false) throw new Error('Admission witness owner paused new votes');
          available(); policyAndEntry(value.issuerKey);
          if (now() >= entry.spendUntil) throw new Error('New admission votes are retired');
        }
        const vote = previous ?? createAdmissionWitnessVote(value, witnessKey!);
        await history.writeRoleDecision({ kind: 'witness-vote', vote });
        available(); policyAndEntry(value.issuerKey);
        return structuredClone(vote);
      } finally { voting = false; if (voteFinished === completed) voteFinished = undefined; finish(); }
    }, close,
  } : undefined;
  async function withCertificate<T>(issuerKey: string, spend: string, context: { action: AdmissionSpendClaim['action']; requestBinding: string },
    commit: (certificate: AdmissionSpendCertificate) => Promise<T>): Promise<T> {
      available(); if (coordinating) throw new Error('Protected admission quorum is in progress'); coordinating = true;
      const controller = new AbortController(); pending = controller;
      const deadline = performance.now() + timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const current = () => {
        available(); policyAndEntry(issuerKey);
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error('Admission quorum cancelled');
      };
      try {
        const { entry } = policyAndEntry(issuerKey), state = history.roleState().coordinator!;
        if (!entry.witnesses!.coordinators.includes(state.coordinator) || state.retiredIssuerKeys.includes(issuerKey)) {
          throw new Error('Coordinator is unavailable or permanently retired');
        }
        const claim: AdmissionSpendClaim = { setId: admissionWitnessSetId(entry.witnesses!), issuerKey, spend,
          action: context.action, requestBinding: context.requestBinding };
        const retained = history.pendingRoleDecision();
        const cached = retained?.kind === 'coordinator-certificate' && retained.certificate.votes[0].issuerKey === issuerKey
          && retained.certificate.votes[0].spend === spend ? retained.certificate
          : state.certificates.find(c => c.votes[0].issuerKey === issuerKey && c.votes[0].spend === spend);
        if (cached && !verifyAdmissionSpendCertificate(cached, claim, entry.witnesses!)) throw new Error('Conflicting admission certificate');
        const certificate = cached ?? await collectAdmissionWitnessVotes(entry.witnesses!, createAdmissionWitnessRequest(claim, coordinatorKey!), controller.signal,
          options.transport ?? ((member, request, signal) => requestAdmissionWitnessVote(member, request, signal, options.onTransportSocket)));
        // The same relay may be the fifth witness. Four other replies can arrive
        // while its own decision still owns this journal. Finish that write
        // within the existing deadline before committing the coordinator row.
        if (voteFinished) await new Promise<void>((resolve, reject) => {
          const cancel = () => { controller.signal.removeEventListener('abort', cancel); reject(new Error('Admission quorum cancelled')); };
          controller.signal.addEventListener('abort', cancel, { once: true });
          if (controller.signal.aborted) { cancel(); return; }
          voteFinished!.then(() => { controller.signal.removeEventListener('abort', cancel); resolve(); });
        });
        current(); const result = await commit(certificate); current(); return result;
      } finally { clearTimeout(timer); controller.abort(); if (pending === controller) pending = undefined; coordinating = false; }
  }
  const quorum = coordinatorKey ? {
    // The callback is a trusted transaction boundary. It must make the proof
    // durable before returning an admission or exposing the certificate.
    withCertificate,
    authorize(issuerKey: string, spend: string, context: { action: AdmissionSpendClaim['action']; requestBinding: string }) {
      return withCertificate(issuerKey, spend, context, certificate => history.writeRoleDecision({ kind: 'coordinator-certificate', certificate }));
    }, close,
  } : undefined;
  return { witness, quorum, close };
}
