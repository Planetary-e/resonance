import { snapshotAdmissionReplayValue, ownAdmissionReplayValue, isOwnedAdmissionReplayValue } from './admission-replay-values.js';
/** Protected witness replacement commitments. These signatures do not replace
 * the complete funded original histories checked before successor readiness. */
import { createHash } from 'node:crypto';
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { admissionWitnessSetId, exactWitnessFields, parseAdmissionWitnessSet, witnessBytes, type AdmissionWitnessSet } from './admission-witness.js';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers, type AdmissionPolicyHead, type AdmissionPolicyObservers } from './admission-policy-freshness.js';
import { admissionKeyFingerprint } from './admission-profile.js';
import type { AdmissionPolicyKey } from './admission-policy.js';
import { chargeAdmissionWork, chargeAdmissionWorkBase64, type AdmissionWorkMeter } from './admission-work.js';

export const WITNESS_HANDOFF_LIVE_MS = 3000;
export const witnessHandoffObserverPins = (context: AdmissionPolicyObservers) => witnessHandoffDigest([context.authority, context.members]);
export type WitnessHandoffPhase = 'ACTIVE_OLD' | 'PREPARING' | 'OLD_FENCED' | 'DRAINED' | 'NEW_READY' | 'ACTIVE_NEW';
export const witnessHandoffDigest = (value: unknown) => `sha256:${createHash('sha256').update('resonance:witness-handoff:v1\n').update(JSON.stringify(value)).digest('hex')}`;
export const isWitnessHandoffDigest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function witnessHandoffKeyDigest(entry: AdmissionPolicyKey) {
  return witnessHandoffDigest([entry.profile, entry.notBefore, entry.issueUntil, entry.spendUntil, entry.retryUntil]);
}
export interface WitnessHandoffProposal {
  version: 1; kind: 'witness-handoff-proposal'; id: string; previous: AdmissionPolicyHead;
  issuerKey: string; keyDigest: string; oldSet: AdmissionWitnessSet; newSet: AdmissionWitnessSet;
  context: AdmissionPolicyObservers; authority: string; signature: string;
}
export interface WitnessFreezeReport {
  version: 1; kind: 'witness-freeze'; proposal: string; witness: string;
  /** Complete original-history transfer descriptor, including uncertain writes. */
  evidence: string; head: string; signature: string;
}
export interface WitnessDrainReport {
  version: 1; kind: 'witness-drained'; proposal: string; manifest: string;
  observer: string; signature: string;
}
export interface WitnessReadyReport {
  version: 1; kind: 'witness-ready'; proposal: string; manifest: string;
  drain: string; witness: string; signature: string;
}
export interface WitnessHandoffActivation {
  version: 1; kind: 'witness-handoff-activation'; proposal: WitnessHandoffProposal;
  manifest: string; freezes: WitnessFreezeReport[]; drained: WitnessDrainReport[];
  ready: WitnessReadyReport[]; authority: string; signature: string;
}
const fields = {
  'witness-handoff-proposal': ['version','kind','id','previous','issuerKey','keyDigest','oldSet','newSet','context','authority','signature'],
  'witness-freeze': ['version','kind','proposal','witness','evidence','head','signature'],
  'witness-drained': ['version','kind','proposal','manifest','observer','signature'],
  'witness-ready': ['version','kind','proposal','manifest','drain','witness','signature'],
  'witness-handoff-activation': ['version','kind','proposal','manifest','freezes','drained','ready','authority','signature'],
} as const;
type Signed = WitnessHandoffProposal | WitnessFreezeReport | WitnessDrainReport | WitnessReadyReport | WitnessHandoffActivation;
function payload(value: Signed, work?: AdmissionWorkMeter) {
  const record = value as unknown as Record<string, unknown>, bytes = Buffer.from(`resonance:${value.kind}:v1\n${JSON.stringify(fields[value.kind].filter(f => f !== 'signature').map(f => record[f]))}`);
  chargeAdmissionWork(work, bytes.length, 'serialize'); return bytes;
}
function signed<T extends Signed>(body: Omit<T, 'signature'>, key: SigningKeyPair, work?: AdmissionWorkMeter): T {
  const value = { ...structuredClone(body), signature: '' } as T;
  value.signature = chargeAdmissionWorkBase64(work, sign(payload(value, work), key.secretKey)); return value;
}
function authentic(value: unknown, kind: Signed['kind'], identity: string, work?: AdmissionWorkMeter): value is Signed {
  if (!exactWitnessFields(value, [...fields[kind]]) || value.version !== 1 || value.kind !== kind || !witnessBytes(value.signature, 64) || !witnessBytes(identity, 32)) return false;
  chargeAdmissionWork(work, 64, 'base64'); return verify(payload(value as unknown as Signed, work), Buffer.from(value.signature, 'base64url'), Buffer.from(identity, 'base64url'));
}
export function parseWitnessHandoffProposal(value: unknown, work?: AdmissionWorkMeter): WitnessHandoffProposal {
  if (!exactWitnessFields(value, [...fields['witness-handoff-proposal']]) || value.version !== 1 || value.kind !== 'witness-handoff-proposal'
    || !witnessBytes(value.id, 32) || !isWitnessHandoffDigest(value.issuerKey) || !isWitnessHandoffDigest(value.keyDigest)) throw new Error('Invalid protected witness handoff proposal');
  const raw = snapshotAdmissionReplayValue(value) as unknown as WitnessHandoffProposal;
  const previous = parseAdmissionPolicyHead(raw.previous), oldSet = parseAdmissionWitnessSet(raw.oldSet), newSet = parseAdmissionWitnessSet(raw.newSet), context = parseAdmissionPolicyObservers(raw.context);
  if (oldSet.version !== 2 || newSet.version !== 2 || oldSet.epoch === newSet.epoch
    || oldSet.observerContext !== witnessHandoffObserverPins(context) || newSet.observerContext !== oldSet.observerContext
    || raw.authority !== context.authority || !authentic(raw, raw.kind, context.authority, work)) throw new Error('Handoff needs distinct protected epochs and the original pinned authority/observers');
  const normalized = { ...raw, previous, oldSet, newSet, context };
  return isOwnedAdmissionReplayValue(raw) && JSON.stringify(normalized) === JSON.stringify(raw) ? raw : ownAdmissionReplayValue(normalized);
}
export const witnessHandoffProposalId = (value: WitnessHandoffProposal) => witnessHandoffDigest(parseWitnessHandoffProposal(value));
export function createWitnessHandoffProposal(body: Omit<WitnessHandoffProposal, 'version' | 'kind' | 'authority' | 'signature'>, key: SigningKeyPair, work?: AdmissionWorkMeter) {
  const canonical = { ...body, previous: parseAdmissionPolicyHead(body.previous), oldSet: parseAdmissionWitnessSet(body.oldSet), newSet: parseAdmissionWitnessSet(body.newSet), context: parseAdmissionPolicyObservers(body.context) };
  return parseWitnessHandoffProposal(signed<WitnessHandoffProposal>({ version: 1, kind: 'witness-handoff-proposal', ...canonical,
    authority: Buffer.from(key.publicKey).toString('base64url') }, key, work), work);
}
export function createWitnessFreezeReport(proposal: WitnessHandoffProposal, evidence: string, head: string, key: SigningKeyPair, work?: AdmissionWorkMeter): WitnessFreezeReport {
  const value = signed<WitnessFreezeReport>({ version: 1, kind: 'witness-freeze', proposal: witnessHandoffProposalId(proposal),
    witness: Buffer.from(key.publicKey).toString('base64url'), evidence, head }, key, work);
  return parseWitnessFreezeReport(value, proposal, work);
}
export function parseWitnessFreezeReport(value: unknown, proposal: WitnessHandoffProposal, work?: AdmissionWorkMeter): WitnessFreezeReport {
  const p = parseWitnessHandoffProposal(proposal, work), raw = value as WitnessFreezeReport;
  if (!authentic(value, 'witness-freeze', raw?.witness, work) || raw.proposal !== witnessHandoffProposalId(p)
    || !p.oldSet.members.some(m => m.publicKey === raw.witness) || !isWitnessHandoffDigest(raw.evidence) || !isWitnessHandoffDigest(raw.head)) throw new Error('Invalid original witness freeze report');
  return snapshotAdmissionReplayValue(raw);
}
export function createWitnessDrainReport(proposal: WitnessHandoffProposal, manifest: string, key: SigningKeyPair, work?: AdmissionWorkMeter): WitnessDrainReport {
  return parseWitnessDrainReport(signed<WitnessDrainReport>({ version: 1, kind: 'witness-drained', proposal: witnessHandoffProposalId(proposal),
    manifest, observer: Buffer.from(key.publicKey).toString('base64url') }, key, work), proposal, manifest, work);
}
export function parseWitnessDrainReport(value: unknown, proposal: WitnessHandoffProposal, manifest: string, work?: AdmissionWorkMeter): WitnessDrainReport {
  const p = parseWitnessHandoffProposal(proposal, work), raw = value as WitnessDrainReport;
  if (!isWitnessHandoffDigest(manifest) || !authentic(value, 'witness-drained', raw?.observer, work) || raw.proposal !== witnessHandoffProposalId(p)
    || raw.manifest !== manifest || !p.context.members.some(m => m.publicKey === raw.observer)) throw new Error('Invalid protected observer drain report');
  return snapshotAdmissionReplayValue(raw);
}
export function parseWitnessDrainCertificate(values: unknown, proposal: WitnessHandoffProposal, manifest: string, work?: AdmissionWorkMeter): WitnessDrainReport[] {
  if (!Array.isArray(values) || values.length !== 4) throw new Error('Handoff needs exactly four distinct drained observers');
  const reports = values.map(v => parseWitnessDrainReport(v, proposal, manifest, work));
  if (new Set(reports.map(r => r.observer)).size !== 4) throw new Error('Repeated drained observer');
  return reports.sort((a,b) => a.observer.localeCompare(b.observer));
}
export function createWitnessReadyReport(proposal: WitnessHandoffProposal, manifest: string, drained: WitnessDrainReport[], key: SigningKeyPair, work?: AdmissionWorkMeter): WitnessReadyReport {
  const drain = witnessHandoffDigest(parseWitnessDrainCertificate(drained, proposal, manifest, work));
  return signed<WitnessReadyReport>({ version: 1, kind: 'witness-ready', proposal: witnessHandoffProposalId(proposal), manifest, drain,
    witness: Buffer.from(key.publicKey).toString('base64url') }, key, work);
}
export function parseWitnessHandoffActivation(value: unknown, work?: AdmissionWorkMeter): WitnessHandoffActivation {
  if (!exactWitnessFields(value, [...fields['witness-handoff-activation']])) throw new Error('Invalid witness activation');
  const raw = snapshotAdmissionReplayValue(value) as unknown as WitnessHandoffActivation, proposal = parseWitnessHandoffProposal(raw.proposal, work);
  if (!isWitnessHandoffDigest(raw.manifest) || !Array.isArray(raw.freezes) || raw.freezes.length !== 4 || !Array.isArray(raw.ready) || raw.ready.length !== 4
    || raw.authority !== proposal.authority || !authentic(raw, 'witness-handoff-activation', proposal.authority, work)) throw new Error('Unauthenticated witness activation');
  const freezes = raw.freezes.map(v => parseWitnessFreezeReport(v, proposal, work)), drained = parseWitnessDrainCertificate(raw.drained, proposal, raw.manifest, work), drain = witnessHandoffDigest(drained);
  if (new Set(freezes.map(v => v.witness)).size !== 4 || new Set(raw.ready.map(v => v.witness)).size !== 4
    || raw.ready.some(v => !authentic(v, 'witness-ready', v.witness, work) || v.proposal !== witnessHandoffProposalId(proposal) || v.manifest !== raw.manifest || v.drain !== drain
      || !proposal.newSet.members.some(m => m.publicKey === v.witness))) throw new Error('Activation differs from four immutable original/new histories');
  const normalized = { ...raw, proposal, freezes, drained };
  return isOwnedAdmissionReplayValue(raw) && JSON.stringify(normalized) === JSON.stringify(raw) ? raw : ownAdmissionReplayValue(normalized);
}
export function createWitnessHandoffActivation(body: Omit<WitnessHandoffActivation, 'version' | 'kind' | 'authority' | 'signature'>, key: SigningKeyPair, work?: AdmissionWorkMeter) {
  const proposal = parseWitnessHandoffProposal(body.proposal, work);
  const canonical = { ...body, proposal, freezes: body.freezes.map(v => parseWitnessFreezeReport(v, proposal, work)).sort((a,b) => a.witness.localeCompare(b.witness)),
    drained: parseWitnessDrainCertificate(body.drained, proposal, body.manifest, work), ready: [...body.ready].sort((a,b) => a.witness.localeCompare(b.witness)) };
  return parseWitnessHandoffActivation(signed<WitnessHandoffActivation>({ version: 1, kind: 'witness-handoff-activation', ...canonical,
    authority: Buffer.from(key.publicKey).toString('base64url') }, key, work), work);
}
/** Called by both legacy and archive successor validation. Enrollment cannot
 * silently upgrade an existing live legacy key. */
export function assertWitnessHandoffSuccessor(previous: AdmissionPolicyKey, next: AdmissionPolicyKey, previousDigest?: string, revision?: number) {
  if (JSON.stringify(previous.witnesses) === JSON.stringify(next.witnesses)) {
    if (JSON.stringify(previous.witnessHandoff) !== JSON.stringify(next.witnessHandoff)) throw new Error('Unchanged witness epoch cannot replace its activation evidence');
    return;
  }
  if(previous.witnesses?.version!==2||next.witnesses?.version!==2)throw new Error('A policy must retain prior keys and their original witness configuration');
  const proof = parseWitnessHandoffActivation(next.witnessHandoff);
  if (previous.witnesses?.version !== 2 || next.witnesses?.version !== 2 || witnessHandoffKeyDigest(previous) !== witnessHandoffKeyDigest(next)
    || proof.proposal.issuerKey !== admissionKeyFingerprint(previous.profile.issuerPublicKey)
    || proof.proposal.keyDigest !== witnessHandoffKeyDigest(previous) || admissionWitnessSetId(proof.proposal.oldSet) !== admissionWitnessSetId(previous.witnesses)
    || admissionWitnessSetId(proof.proposal.newSet) !== admissionWitnessSetId(next.witnesses)
    || previousDigest !== undefined && proof.proposal.previous.digest !== previousDigest
    || revision !== undefined && proof.proposal.previous.revision !== revision) throw new Error('Witness successor lost its original protected key, epoch, cutoffs or predecessor');
}
