import { snapshotAdmissionReplayValue, ownAdmissionReplayValue, isOwnedAdmissionReplayValue } from '@resonance/core';
import type { ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
/** Flat inherited constraints. Original signatures retain their original set IDs;
 * no imported row is a destination-local accepted spend. */
import { admissionWitnessSetId, admissionSpendClaimId, exactWitnessFields, parseAdmissionWitnessSet, verifyAdmissionWitnessVote, verifyAdmissionSpendCertificate,
  type AdmissionWitnessSet, type AdmissionWitnessVote, type AdmissionSpendCertificate, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { parseWitnessHandoffProposal, parseWitnessHandoffActivation, witnessHandoffProposalId, witnessHandoffDigest, parseWitnessFreezeReport,
  parseWitnessDrainCertificate, witnessHandoffKeyDigest, type WitnessHandoffProposal, type WitnessHandoffActivation, type WitnessFreezeReport, type WitnessDrainReport, type WitnessHandoffPhase } from '@resonance/core/admission-witness-handoff';
import { verifyAdmissionPolicy, admissionKeyFingerprint, admissionPolicyDigest, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';

export interface WitnessInheritedEvidence {
  sets: AdmissionWitnessSet[]; activations: WitnessHandoffActivation[];
  votes: AdmissionWitnessVote[]; certificates: AdmissionSpendCertificate[];
  /** Includes every original accepted row; these never enter the local spend map. */
  accepted: Array<{ owner: string; issuerKey: string | null; spend: string; action: string; binding: string }>;
  denials: string[];
}
export interface WitnessTransferManifest {
  version: 2; proposal: WitnessHandoffProposal; freezes: WitnessFreezeReport[];
  terminals: Array<{ witness: string; contextId: string; genesisId: string; rootId: string;
    generation: number; nextGeneration: number; head: { sequence: number; id: string }; original: string; envelopes: string[] }>;
  inherited: WitnessInheritedEvidence;
}
export interface ProtectedWitnessHandoffState {
  version: 1; writerStateBytes: number; genesis: SignedAdmissionPolicy; context: AdmissionPolicyObservers;
  phase: WitnessHandoffPhase; proposal: WitnessHandoffProposal | null;
  manifest: WitnessTransferManifest | null; drained: WitnessDrainReport[];
  inherited: WitnessInheritedEvidence; activation: WitnessHandoffActivation | null;
}
export const emptyWitnessEvidence = (): WitnessInheritedEvidence => ({ sets: [], activations: [], votes: [], certificates: [], accepted: [], denials: [] });
const index = (v: AdmissionSpendClaim) => `${v.issuerKey}:${v.spend}`;
const binding = (v: Pick<AdmissionSpendClaim, 'action' | 'requestBinding'>) => JSON.stringify([v.action, v.requestBinding]);
function unique<T>(values: T[]): T[] { return [...new Map(values.map(v => [JSON.stringify(v), v])).values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
export function mergeWitnessEvidence(values: WitnessInheritedEvidence[]): WitnessInheritedEvidence {
  return { sets: unique(values.flatMap(v => v.sets)), activations: unique(values.flatMap(v => v.activations)), votes: unique(values.flatMap(v => v.votes)),
    certificates: unique(values.flatMap(v => v.certificates).map(c=>({...c,votes:[...c.votes].sort((a,b)=>a.witness.localeCompare(b.witness))}))), accepted: unique(values.flatMap(v => v.accepted)), denials: [...new Set(values.flatMap(v => v.denials))].sort() };
}
export function parseWitnessInheritedEvidence(value: unknown, genesis: SignedAdmissionPolicy, limit = 10000): WitnessInheritedEvidence {
  if (!exactWitnessFields(value, ['sets','activations','votes','certificates','accepted','denials']) || Object.values(value).some(v => !Array.isArray(v))) throw new Error('Invalid inherited witness evidence');
  const raw = snapshotAdmissionReplayValue(value) as unknown as WitnessInheritedEvidence;
  // Same existing semantic row ceiling; inherited and current claims are charged together by the role reducer.
  if (raw.votes.length + raw.certificates.length + raw.accepted.length + raw.denials.length > limit || raw.sets.length > limit || raw.activations.length > limit) throw new Error('Inherited witness evidence exceeds existing role capacity');
  const sets = raw.sets.map(parseAdmissionWitnessSet), activations = raw.activations.map(value => parseWitnessHandoffActivation(value)), allowed = new Map<string, AdmissionWitnessSet>();
  const scoped = new Set<string>(), epochs = new Set<string>();
  for (const entry of genesis.keys) if (entry.witnesses) { allowed.set(admissionWitnessSetId(entry.witnesses), entry.witnesses); scoped.add(`${admissionKeyFingerprint(entry.profile.issuerPublicKey)}:${admissionWitnessSetId(entry.witnesses)}`); epochs.add(`${admissionKeyFingerprint(entry.profile.issuerPublicKey)}:${entry.witnesses.epoch}`); }
  const pending = [...activations];
  for (let round = 0; pending.length && round <= activations.length; round++) {
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i].proposal;
      if (p.authority !== genesis.authority || !genesis.keys.some(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === p.issuerKey && witnessHandoffKeyDigest(e) === p.keyDigest)) throw new Error('Inherited configuration changed authority');
      if (scoped.has(`${p.issuerKey}:${admissionWitnessSetId(p.oldSet)}`)) { if(epochs.has(`${p.issuerKey}:${p.newSet.epoch}`))throw new Error('Historical witness epoch cannot be reused'); epochs.add(`${p.issuerKey}:${p.newSet.epoch}`); allowed.set(admissionWitnessSetId(p.newSet), p.newSet); scoped.add(`${p.issuerKey}:${admissionWitnessSetId(p.newSet)}`); pending.splice(i,1); progress = true; }
    }
    if (!progress) throw new Error('Inherited witness configurations lost their authenticated ancestry');
  }
  if (pending.length || sets.some(set => JSON.stringify(allowed.get(admissionWitnessSetId(set))) !== JSON.stringify(set))) throw new Error('Inherited evidence has an unauthenticated witness epoch');
  const byId = new Map(sets.map(set => [admissionWitnessSetId(set), set]));
  for (const vote of raw.votes) { const set = byId.get(vote.setId); if (!set || !scoped.has(`${vote.issuerKey}:${vote.setId}`) || !verifyAdmissionWitnessVote(vote, vote, set)) throw new Error('Inherited original vote is invalid'); }
  for (const certificate of raw.certificates) { const claim = certificate?.votes?.[0], set = byId.get(claim?.setId); if (!set || !scoped.has(`${claim.issuerKey}:${claim.setId}`) || !verifyAdmissionSpendCertificate(certificate, claim, set)) throw new Error('Inherited original certificate is invalid'); }
  for (const row of raw.accepted) if (!exactWitnessFields(row, ['owner','issuerKey','spend','action','binding']) || typeof row.owner !== 'string' || typeof row.spend !== 'string' || typeof row.action !== 'string' || typeof row.binding !== 'string') throw new Error('Invalid original accepted record');
  if (raw.denials.some(v => typeof v !== 'string')) throw new Error('Invalid inherited permanent denial');
  const normalized = mergeWitnessEvidence([{ ...raw, sets, activations }]);
  if (JSON.stringify(normalized) !== JSON.stringify(raw)) throw new Error('Inherited evidence must be unique and canonical');
  return isOwnedAdmissionReplayValue(raw) ? raw : ownAdmissionReplayValue(normalized);
}
/** Compare epoch identities, including an altered set using the same epoch.
 * The complete authenticated ancestry parser independently rejects reuse too. */
export function assertWitnessEpochUnused(proposal: WitnessHandoffProposal, genesis: SignedAdmissionPolicy, evidence: WitnessInheritedEvidence, allowInstalled = false) {
  const currentId=witnessHandoffProposalId(proposal);
  const original=genesis.keys.find(e=>admissionKeyFingerprint(e.profile.issuerPublicKey)===proposal.issuerKey)?.witnesses;
  if(original?.epoch===proposal.newSet.epoch || evidence.activations.some(a=>a.proposal.issuerKey===proposal.issuerKey && a.proposal.newSet.epoch===proposal.newSet.epoch && (!allowInstalled || witnessHandoffProposalId(a.proposal)!==currentId)))throw new Error('Historical witness epoch cannot be reused');
}
export function witnessConstraint(evidence: WitnessInheritedEvidence, claim: AdmissionSpendClaim, originalCertificate?: AdmissionSpendCertificate): 'fresh' | 'bound' | 'split' | 'conflict' | 'denied' {
  if (evidence.denials.includes(claim.issuerKey)) return 'denied';
  const votes = evidence.votes.filter(v => index(v) === index(claim));
  const certificates = evidence.certificates.filter(c => index(c.votes[0]) === index(claim));
  if (originalCertificate) {
    const original = originalCertificate.votes?.[0], set = evidence.sets.find(s => admissionWitnessSetId(s) === original?.setId);
    if (!set || index(original) !== index(claim) || !verifyAdmissionSpendCertificate(originalCertificate, original, set)) throw new Error('Recovery requires a genuine original four-vote certificate');
    certificates.push(originalCertificate);
  }
  const complete = new Set(certificates.map(c => binding(c.votes[0])));
  if (complete.size > 1) return 'conflict';
  if (complete.size) return complete.has(binding(claim)) ? 'bound' : 'denied';
  const claims = new Set([...votes.map(binding), ...evidence.accepted.filter(r => `${r.issuerKey}:${r.spend}` === index(claim)).map(r => JSON.stringify([r.action,r.binding]))]);
  if (claims.size > 1) return 'split';
  if (claims.size) return claims.has(binding(claim)) ? 'bound' : 'denied';
  return 'fresh';
}
export async function parseProtectedWitnessHandoffState(value: unknown, policy: ArchivedAdmissionPolicy, limit = 10000): Promise<ProtectedWitnessHandoffState> {
  if (!exactWitnessFields(value, ['version','writerStateBytes','genesis','context','phase','proposal','manifest','drained','inherited','activation']) || value.version !== 1
    || !Number.isSafeInteger(value.writerStateBytes) || (value.writerStateBytes as number) < 1024*1024 || (value.writerStateBytes as number) > 40*1024*1024
    || !['ACTIVE_OLD','PREPARING','OLD_FENCED','DRAINED','NEW_READY','ACTIVE_NEW'].includes(value.phase as string)) throw new Error('Invalid protected witness handoff state');
  const raw = snapshotAdmissionReplayValue(value) as unknown as ProtectedWitnessHandoffState, genesis = await verifyAdmissionPolicy(raw.genesis, policy.authority);
  if (!sameAdmissionPolicyHead(admissionPolicyHead(genesis), raw.context.genesis) || raw.context.authority !== policy.authority || genesis.keys.some(k => k.witnesses?.version !== 2)) throw new Error('Protected witness enrollment requires its original signed genesis');
  const inherited = parseWitnessInheritedEvidence(raw.inherited, genesis, limit), proposal = raw.proposal && parseWitnessHandoffProposal(raw.proposal);
  if(proposal)assertWitnessEpochUnused(proposal,genesis,inherited,true);
  if (proposal && admissionPolicyObserversId(proposal.context) !== admissionPolicyObserversId(raw.context)) throw new Error('Handoff observer pins changed');
  const manifest = raw.manifest;
  if (manifest) {
    if (!exactWitnessFields(manifest, ['version','proposal','freezes','inherited','terminals']) || manifest.version !== 2 || !proposal || witnessHandoffProposalId(manifest.proposal) !== witnessHandoffProposalId(proposal)
      || manifest.freezes.length !== 4 || new Set(manifest.freezes.map(v => parseWitnessFreezeReport(v, proposal).witness)).size !== 4) throw new Error('Invalid immutable witness transfer manifest');
    if (!Array.isArray(manifest.terminals) || manifest.terminals.length !== 4
      || new Set(manifest.terminals.map(t => t.witness)).size !== 4
      || manifest.terminals.some(t => !manifest.freezes.some(f => f.witness === t.witness && f.head === t.head?.id)
        || ![t.contextId,t.genesisId,t.rootId,t.head?.id,t.original].every(v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v))
        || !Number.isSafeInteger(t.generation) || t.generation < 0 || !Number.isSafeInteger(t.nextGeneration) || t.nextGeneration <= t.generation
        || !Number.isSafeInteger(t.head?.sequence) || t.head.sequence < 0
        || !Array.isArray(t.envelopes) || !t.envelopes.length || t.envelopes.length > 10001
        || t.envelopes.some(id => !/^sha256:[a-f0-9]{64}$/.test(id)) || t.envelopes.at(-1) !== t.head.id
        || !manifest.freezes.some(f => f.witness === t.witness && f.evidence === witnessHandoffDigest({ original: t.original, terminal: { rootId: t.rootId, generation: t.generation, nextGeneration: t.nextGeneration, envelopes: t.envelopes } })))) throw new Error('Manifest requires exact terminal identities');
    parseWitnessInheritedEvidence(manifest.inherited, genesis, limit);
    assertWitnessEpochUnused(proposal,genesis,manifest.inherited);
    const merged = mergeWitnessEvidence([manifest.inherited, inherited]);
    if (JSON.stringify(merged) !== JSON.stringify(inherited)) throw new Error('Successor lost manifest constraints');
  }
  if (raw.drained.length) { if (!manifest || !proposal) throw new Error('Drain lacks its manifest'); parseWitnessDrainCertificate(raw.drained, proposal, witnessHandoffDigest(manifest)); }
  const activation = raw.activation && parseWitnessHandoffActivation(raw.activation);
  if (activation && (!manifest || !proposal || activation.manifest !== witnessHandoffDigest(manifest) || witnessHandoffProposalId(activation.proposal) !== witnessHandoffProposalId(proposal))) throw new Error('Activation differs from installed witness state');
  if (['DRAINED','NEW_READY','ACTIVE_NEW'].includes(raw.phase) && (!manifest || raw.drained.length !== 4) || raw.phase === 'ACTIVE_NEW' && !activation) throw new Error('Witness phase lacks its durable proofs');
  const normalized = { ...raw, genesis, inherited, proposal, activation };
  return isOwnedAdmissionReplayValue(raw) && JSON.stringify(normalized) === JSON.stringify(raw) ? raw : ownAdmissionReplayValue(normalized);
}
export function assertWitnessStateRetention(before: ProtectedWitnessHandoffState, after: ProtectedWitnessHandoffState) {
  if (before.writerStateBytes !== after.writerStateBytes) throw new Error('Protected witness writer capacity is pinned across restart and restore');
  if (admissionPolicyDigest(before.genesis) !== admissionPolicyDigest(after.genesis) || admissionPolicyObserversId(before.context) !== admissionPolicyObserversId(after.context)
    || JSON.stringify(mergeWitnessEvidence([before.inherited, after.inherited])) !== JSON.stringify(after.inherited)) throw new Error('Handoff lost original enrollment/evidence/denials');
  const same = JSON.stringify(before.proposal) === JSON.stringify(after.proposal);
  const returning = !same && after.phase === 'DRAINED' && before.phase === 'OLD_FENCED' && before.proposal && after.inherited.activations.some(a => witnessHandoffProposalId(a.proposal) === witnessHandoffProposalId(before.proposal!));
  if (!same && !returning && before.phase !== 'ACTIVE_NEW' && before.phase !== 'ACTIVE_OLD') throw new Error('Conflicting authenticated handoff proposal permanently fences preparation');
  if (same && before.manifest && JSON.stringify(before.manifest) !== JSON.stringify(after.manifest)) throw new Error('Immutable witness manifest changed');
  const phases = ['ACTIVE_OLD','PREPARING','OLD_FENCED','DRAINED','NEW_READY','ACTIVE_NEW'];
  if (same && phases.indexOf(after.phase) < phases.indexOf(before.phase)) throw new Error('Protected witness epoch cannot roll back or unfence');
}
