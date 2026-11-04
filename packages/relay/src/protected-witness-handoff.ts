import { copyAdmissionReplayValue } from '@resonance/core';
import { withAdmissionReplayValues } from '@resonance/core';
/** Explicit operator preparation/activation for an already enrolled protected key.
 * Offline history verification cannot authorize a token or extend a live deadline. */
import { randomBytes } from 'node:crypto';
import { createAdmissionOriginalReferences, originalReferenceWorkBudget, shareOriginalReferenceWorkBudget, type OriginalReferenceWorkBudget } from './admission-original-references.js';
import { withSuccessfulEd25519VerificationReuse, type SigningKeyPair } from '@resonance/core';
import { AdmissionPolicyArchiveExecutionContext, archivedAdmissionPolicyDigest, type ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
import { admissionKeyFingerprint, admissionPolicyDigest, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { admissionWitnessSetId, parseAdmissionWitnessSet, verifyAdmissionSpendCertificate, type AdmissionSpendCertificate, type AdmissionWitnessSet } from '@resonance/core/admission-witness';
import { parseWitnessHandoffProposal, createWitnessFreezeReport, parseWitnessFreezeReport, witnessHandoffProposalId, witnessHandoffDigest, witnessHandoffKeyDigest,
  witnessHandoffObserverPins, createWitnessHandoffProposal, createWitnessReadyReport, parseWitnessDrainCertificate, parseWitnessHandoffActivation,
  type WitnessHandoffProposal, type WitnessFreezeReport, type WitnessDrainReport, type WitnessHandoffActivation } from '@resonance/core/admission-witness-handoff';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, HISTORY_ENVELOPE_MAX_BYTES, HISTORY_DELTA_MAX_PAYLOAD,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryRecoveryPreparation, type HistoryRecoveryPreparation } from '@resonance/core/history-exchange';
import { assertHistorySuccessorChain } from '@resonance/core/history-successor';
import { parseAdmissionHistoryImage, reduceAdmissionHistory, type AdmissionHistoryImage } from './admission-history-records.js';
import { createPolicyProofReplayHistory, decodePolicyProofReplayRecord } from './admission-policy-history-proof.js';
import type { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';
import { emptyWitnessEvidence, mergeWitnessEvidence, parseWitnessInheritedEvidence, assertWitnessEpochUnused, witnessConstraint,
  type ProtectedWitnessHandoffState, type WitnessTransferManifest, type WitnessInheritedEvidence } from './witness-handoff-state.js';

type History = Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
export interface WitnessFreezeEvidence {
  version: 1; context: HistoryCheckpointContext; genesisId: string; encryptionKey: string;
  blocks: HistoryCheckpointEnvelope[]; report: WitnessFreezeReport;
  terminal?: { rootId: string; generation: number; nextGeneration: number; envelopes: string[] };
}
function evidenceDescriptor(value: Omit<WitnessFreezeEvidence, 'report'>) {
  const original = { version: value.version, context: value.context, genesisId: value.genesisId, encryptionKey: value.encryptionKey,
    blocks: value.blocks.map(historyCheckpointEnvelopeId) };
  return value.terminal ? { original: witnessHandoffDigest(original), terminal: value.terminal } : original;
}
function localEvidence(history: History): WitnessInheritedEvidence {
  const state = history.read(), image = state.image, roles = image.version === 2 ? image.roles : { witness: null, coordinator: null };
  return mergeWitnessEvidence([image.handoff?.inherited ?? emptyWitnessEvidence(), {
    sets: image.policy.keys.flatMap(k => k.witnesses ? [k.witnesses] : []), activations: image.handoff?.activation ? [image.handoff.activation] : [],
    votes: roles.witness?.votes ?? [], certificates: roles.coordinator?.certificates ?? [],
    accepted: image.state.spends.map(row => ({ owner: state.context.owner, ...row })),
    denials: [...image.state.retiredIssuerKeys, ...(roles.witness?.retiredIssuerKeys ?? []), ...(roles.coordinator?.retiredIssuerKeys ?? [])],
  }]);
}
export async function enrollProtectedWitnessEpoch(history: History, genesisValue: SignedAdmissionPolicy) {
  history.assertHandoffFunding();
  const state = history.read(), genesis = copyAdmissionReplayValue(genesisValue), trust = state.image.policyTrust;
  if (state.image.handoff) { if (state.image.handoff.phase === 'ACTIVE_OLD' && admissionPolicyDigest(state.image.handoff.genesis) === admissionPolicyDigest(genesis)) return; throw new Error('Protected witness enrollment already exists; it cannot be reset'); }
  if (!trust || state.image.policy.revision !== genesis.revision || archivedAdmissionPolicyDigest(state.image.policy) !== admissionPolicyDigest(genesis)
    || !sameAdmissionPolicyHead(admissionPolicyHead(genesis), trust.context.genesis)
    || genesis.keys.some(k => k.witnesses?.version !== 2 || k.witnesses.observerContext !== witnessHandoffObserverPins(trust.context))) throw new Error('Enrollment requires the original explicitly protected policy, not an arbitrary legacy live key');
  await history.writeHandoffState({ version: 1, writerStateBytes: history.writerStateBytes(), genesis, context: trust.context, phase: 'ACTIVE_OLD', proposal: null, manifest: null,
    drained: [], inherited: localEvidence(history), activation: null });
}
export function proposeProtectedWitnessHandoff(history: History, issuerKey: string, newSetValue: AdmissionWitnessSet, authorityKey: SigningKeyPair): WitnessHandoffProposal {
  const state = history.read(), enrollment = state.image.handoff, entry = state.image.policy.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === issuerKey);
  if (!enrollment || !entry?.witnesses || !state.image.policyTrust) throw new Error('Witness handoff requires explicit protected enrollment');
  const newSet = parseAdmissionWitnessSet(newSetValue);
  const proposal = createWitnessHandoffProposal({ id: randomBytes(32).toString('base64url'), previous: state.image.policyTrust.installed, issuerKey,
    keyDigest: witnessHandoffKeyDigest(entry), oldSet: entry.witnesses, newSet, context: enrollment.context }, authorityKey);
  assertWitnessEpochUnused(proposal,enrollment.genesis,localEvidence(history)); return proposal;
}
export async function freezeProtectedWitness(history: History, proposalValue: WitnessHandoffProposal, witnessKey: SigningKeyPair, encryptionKey: Uint8Array): Promise<WitnessFreezeEvidence> {
  history.assertHandoffFunding();
  const proposal = parseWitnessHandoffProposal(copyAdmissionReplayValue(proposalValue)), original = history.read(), enrolled = original.image.handoff;
  const witness = Buffer.from(witnessKey.publicKey).toString('base64url'), role = original.image.version === 2 ? original.image.roles.witness : null;
  const entry = original.image.policy.keys.find(k => admissionKeyFingerprint(k.profile.issuerPublicKey) === proposal.issuerKey);
  if (!enrolled || !role || role.witness !== witness || !proposal.oldSet.members.some(m => m.publicKey === witness)
    || !entry?.witnesses || admissionWitnessSetId(entry.witnesses) !== admissionWitnessSetId(proposal.oldSet)
    || !original.image.policyTrust || !sameAdmissionPolicyHead(proposal.previous, original.image.policyTrust.installed)
    || proposal.keyDigest !== witnessHandoffKeyDigest(entry)) throw new Error('Freeze must select this exact protected witness, key and predecessor');
  assertWitnessEpochUnused(proposal,enrolled.genesis,localEvidence(history));
  if (enrolled.proposal && !['ACTIVE_NEW','ACTIVE_OLD'].includes(enrolled.phase) && witnessHandoffProposalId(enrolled.proposal) !== witnessHandoffProposalId(proposal)) throw new Error('Conflicting preparation remains fenced');
  if (['ACTIVE_NEW','ACTIVE_OLD'].includes(enrolled.phase)) await history.writeHandoffState({ ...enrolled, phase: 'PREPARING', proposal, manifest: null, drained: [], activation: null,
    inherited: localEvidence(history) });
  const preparing = history.handoffState()!;
  if (preparing.phase === 'PREPARING') await history.writeHandoffState({ ...preparing, phase: 'OLD_FENCED', inherited: localEvidence(history) });
  const current = history.read();
  if (current.pending || current.image.handoff?.phase !== 'OLD_FENCED') throw new Error('Freeze cannot omit an uncertain tail');
  const blocks = [...history.originalBlocks()].map(b => copyAdmissionReplayValue(b));
  if (!blocks.length || historyCheckpointEnvelopeId(blocks.at(-1)!) !== current.applied?.id) throw new Error('Freeze requires the complete retained original history');
  const unsigned: Omit<WitnessFreezeEvidence, 'report'> = { version: 1, context: current.context, genesisId: historyCheckpointEnvelopeId(blocks[0]), encryptionKey: Buffer.from(encryptionKey).toString('base64url'), blocks };
  return { ...unsigned, report: createWitnessFreezeReport(proposal, witnessHandoffDigest(evidenceDescriptor(unsigned)), current.applied.id, witnessKey) };
}
/** Explicit producer operation: returns original signed evidence paired with the
 * authenticated generation barrier. Consumers independently verify the paired
 * preparation against retained original deployment and exact-state pins. */
export async function prepareTerminalProtectedWitness(history: History, proposal: WitnessHandoffProposal,
  settings: Parameters<History['prepareTerminalWitness']>[1]) {
  return history.prepareTerminalWitness(proposal, settings);
}
/** Trusted operator input retained independently from original enrollment and owner state.
 * Never construct these pins by copying an untrusted transfer bundle. */
export interface WitnessTerminalPins {
  context: HistoryCheckpointContext; genesisId: string; rootId: string;
  generation: number; nextGeneration: number; head: { sequence: number; id: string };
}
export interface WitnessTerminalEvidence { evidence: WitnessFreezeEvidence; preparation: HistoryRecoveryPreparation }
function verifyTerminalPair(value: WitnessTerminalEvidence, pins: WitnessTerminalPins, proposal: WitnessHandoffProposal) {
  if (!value?.evidence || !value.preparation || !pins) throw new Error('Actual paired terminal preparation and independent original pins required');
  const context = parseHistoryCheckpointContext(pins.context), evidence = value.evidence;
  if (context.owner !== evidence.report?.witness || context.authority !== proposal.authority
    || historyCheckpointContextId(context) !== historyCheckpointContextId(evidence.context)
    || evidence.genesisId !== pins.genesisId) throw new Error('Terminal original context or genesis pins differ');
  const preparation = parseHistoryRecoveryPreparation(value.preparation, context, pins.genesisId);
  const terminal = { rootId: preparation.rootId, generation: preparation.generation,
    nextGeneration: preparation.nextGeneration, envelopes: preparation.envelopes.map(historyCheckpointEnvelopeId) };
  const head = preparation.envelopes.at(-1)!;
  if (terminal.rootId !== pins.rootId || terminal.generation !== pins.generation || terminal.nextGeneration !== pins.nextGeneration
    || !pins.head || historyCheckpointEnvelopeId(head) !== pins.head.id || head.sequence !== pins.head.sequence
    || evidence.report.head !== pins.head.id || JSON.stringify(evidence.terminal) !== JSON.stringify(terminal)) {
    throw new Error('Terminal root, generation, barrier or exact head differs from independent pins');
  }
  // Originals may span older generations, but the complete selected generation
  // must be the exact suffix, not a signed earlier OLD_FENCED prefix.
  const suffix = evidence.blocks.slice(-preparation.envelopes.length).map(historyCheckpointEnvelopeId);
  if (JSON.stringify(suffix) !== JSON.stringify(terminal.envelopes)) throw new Error('Terminal selected generation differs from original history');
  return { witness: context.owner, contextId: historyCheckpointContextId(context), genesisId: pins.genesisId,
    rootId: terminal.rootId, generation: terminal.generation, nextGeneration: terminal.nextGeneration, head: { ...pins.head }, original: witnessHandoffDigest({ version: evidence.version, context: evidence.context, genesisId: evidence.genesisId, encryptionKey: evidence.encryptionKey, blocks: evidence.blocks.map(historyCheckpointEnvelopeId) }), envelopes: terminal.envelopes };
}
interface VerificationBudget { operation: AdmissionPolicyArchiveExecutionContext; ids: Set<string>; bytes: number; blocks: number }
async function verifyFrozenHistory(value: WitnessFreezeEvidence, proposal: WitnessHandoffProposal, budget: VerificationBudget): Promise<{ image: AdmissionHistoryImage; evidence: WitnessInheritedEvidence }> {
  budget.operation.check();
  const context = parseHistoryCheckpointContext(value.context), report = parseWitnessFreezeReport(value.report, proposal);
  if (value.version !== 1 || context.role !== 'relay-admission-spends' || context.authority !== proposal.authority
    || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 10001 || !/^[A-Za-z0-9_-]{43}$/.test(value.encryptionKey)
    || witnessHandoffDigest(evidenceDescriptor(value)) !== report.evidence) throw new Error('Original frozen history descriptor differs');
  const key = Buffer.from(value.encryptionKey, 'base64url');
  const originals = createAdmissionOriginalReferences(historyCheckpointContextId(context), { check: () => budget.operation.check(), workBudget: originalReferenceWorkBudget(budget.operation) });
  const source = () => value.blocks;
  let proofHistory: ReturnType<typeof createPolicyProofReplayHistory> | undefined;
  let image: AdmissionHistoryImage | undefined, head: HistoryCheckpointEnvelope | undefined, ids: string[] = [];
  try {
    proofHistory = createPolicyProofReplayHistory({ shareDecodedRecords: true, context, encryptionKey: key, source, operation: { startup: budget.operation } });
    let occurrence = 0;
    for (const raw of proofHistory.source()) {
      const index = occurrence++;
      budget.operation.check(); const block = parseHistoryCheckpointEnvelope(raw, context), id = historyCheckpointEnvelopeId(block), encoded = JSON.stringify(block), encodedBytes = Buffer.byteLength(encoded);
      originalReferenceWorkBudget(budget.operation).charge(encodedBytes);
      if (!budget.ids.has(id)) {
        budget.ids.add(id); budget.bytes += encodedBytes; budget.blocks++;
        if (budget.bytes > 256 * 1024 * 1024 || budget.blocks > 10001) throw new Error('Original witness verification exceeds existing cumulative history capacity');
      }
      if (encodedBytes > HISTORY_ENVELOPE_MAX_BYTES) throw new Error('Original history frame exceeds existing bound');
      if (block.kind === 'continuation') {
        if (!head || block.proposal.generation !== head.generation) throw new Error('Original history continuation lost its predecessor');
        assertHistorySuccessorChain(block.proposal, ids); ids = [id];
      } else {
        const decoded = decodePolicyProofReplayRecord(proofHistory, index, raw);
        if (!head) {
          if (block.kind !== 'checkpoint' || block.generation !== 0 || block.sequence !== 0 || id !== value.genesisId) throw new Error('Original witness history lost its genesis');
          image = await parseAdmissionHistoryImage(decoded, context.authority, 10000, proofHistory);
          if (`sha256:${archivedAdmissionPolicyDigest(image.policy)}` !== context.policyDigest) throw new Error('Original witness genesis differs from signed context');
          ids = [id];
        } else {
          if (block.generation !== head.generation || block.sequence !== head.sequence + 1 || block.previous !== historyCheckpointEnvelopeId(head)) throw new Error('Original witness history has a missing or conflicting tail');
          image = (await reduceAdmissionHistory(image!, decoded, 10000, block.kind, proofHistory)).image; ids.push(id);
        }
      }
      head = block;
    }
    const handoff = image?.handoff, witness = image?.version === 2 ? image.roles.witness : null;
    if (!image || !head || historyCheckpointEnvelopeId(head) !== report.head || !handoff || handoff.phase !== 'OLD_FENCED'
      || !handoff.proposal || witnessHandoffProposalId(handoff.proposal) !== witnessHandoffProposalId(proposal) || witness?.witness !== report.witness) throw new Error('Frozen history does not end at this witness exact durable fence');
    budget.operation.check();
    const evidence = mergeWitnessEvidence([handoff.inherited, {
      sets: image.policy.keys.flatMap(k => k.witnesses ? [k.witnesses] : []), activations: handoff.activation ? [handoff.activation] : [],
      votes: witness.votes, certificates: image.version === 2 ? image.roles.coordinator?.certificates ?? [] : [],
      accepted: image.state.spends.map(row => ({ owner: context.owner, ...row })),
      denials: [...image.state.retiredIssuerKeys, ...witness.retiredIssuerKeys, ...(image.version === 2 ? image.roles.coordinator?.retiredIssuerKeys ?? [] : [])],
    }]);
    return { image, evidence };
  } finally { proofHistory?.release(); key.fill(0); }
}
const verifiedTransfers = new WeakMap<WitnessTransferManifest, SignedAdmissionPolicy>();
export async function prepareProtectedWitnessTransfer(proposalValue: WitnessHandoffProposal, values: Array<WitnessTerminalEvidence | WitnessFreezeEvidence>, signal?: AbortSignal, pins: WitnessTerminalPins[] = [], workBudget?: OriginalReferenceWorkBudget): Promise<WitnessTransferManifest> {
  const proposal = parseWitnessHandoffProposal(copyAdmissionReplayValue(proposalValue));
  if (!Array.isArray(values) || values.length !== 4 || pins.length !== 4 || new Set(pins.map(p => p.context.owner)).size !== 4) throw new Error('Transfer requires exactly four complete distinct frozen original witnesses');
  const operation = new AdmissionPolicyArchiveExecutionContext({ execution: { version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: 30000 }, timeoutMs: 30000, signal });
  if (workBudget) shareOriginalReferenceWorkBudget(operation, workBudget);
  return withAdmissionReplayValues({ check: () => operation.check(), charge: bytes => originalReferenceWorkBudget(operation).charge(bytes) }, () => withSuccessfulEd25519VerificationReuse({ check: () => operation.check() }, async () => {
  let snapshotted = 0;
  const retainedPins = copyAdmissionReplayValue(pins);
  const pairs = values.map(value => { operation.check(); const encoded = JSON.stringify(value); if ((snapshotted += Buffer.byteLength(encoded)) > 256 * 1024 * 1024) throw new Error('Freeze transfer snapshot exceeds existing history byte bound'); originalReferenceWorkBudget(operation).charge(Buffer.byteLength(encoded)); originalReferenceWorkBudget(operation).charge(Buffer.byteLength(encoded)); return JSON.parse(encoded) as WitnessTerminalEvidence; });
  const terminals = pairs.map(pair => verifyTerminalPair(pair, retainedPins.find(pin => pin.context.owner === pair.evidence?.report?.witness)!, proposal)).sort((a,b) => a.witness.localeCompare(b.witness));
  if (new Set(terminals.map(terminal => terminal.witness)).size !== 4) throw new Error('Four distinct terminal owners required');
  const originals = pairs.map(pair => pair.evidence);
  const budget: VerificationBudget = { operation, ids: new Set(), bytes: 0, blocks: 0 }, evidence: WitnessInheritedEvidence[] = [];
  let genesis: SignedAdmissionPolicy | undefined;
  for (const value of originals) {
    const result = await withAdmissionReplayValues({ check: () => operation.check(), charge: bytes => originalReferenceWorkBudget(operation).charge(bytes) }, () => verifyFrozenHistory(value, proposal, budget));
    if (genesis && admissionPolicyDigest(genesis) !== admissionPolicyDigest(result.image.handoff!.genesis)) throw new Error('Frozen witnesses disagree on original protected enrollment');
    genesis = result.image.handoff!.genesis; evidence.push(result.evidence);
  }
  const inherited = parseWitnessInheritedEvidence(mergeWitnessEvidence(evidence), genesis!);
  assertWitnessEpochUnused(proposal,genesis!,inherited); operation.check();
  const manifest: WitnessTransferManifest = { version: 2, proposal, terminals, freezes: originals.map(v => parseWitnessFreezeReport(v.report, proposal)).sort((a,b) => a.witness.localeCompare(b.witness)), inherited };
  verifiedTransfers.set(manifest, genesis!); return manifest;
  }));
}
async function installVerifiedWitnessState(history: History, values: Array<WitnessTerminalEvidence | WitnessFreezeEvidence>, manifestValue: WitnessTransferManifest, drainedValue: WitnessDrainReport[], signal?: AbortSignal, pins: WitnessTerminalPins[] = []) {
  history.assertHandoffFunding();
  const manifest = await prepareProtectedWitnessTransfer(manifestValue.proposal, values, signal, pins);
  if (witnessHandoffDigest(manifest) !== witnessHandoffDigest(manifestValue)) throw new Error('Successor must independently install the identical agreed original state');
  const proposal = manifest.proposal, drained = parseWitnessDrainCertificate(drainedValue, proposal, witnessHandoffDigest(manifest)), genesis = verifiedTransfers.get(manifest)!;
  const previous = history.handoffState(), inherited = mergeWitnessEvidence([localEvidence(history), manifest.inherited]);
  const next: ProtectedWitnessHandoffState = { version: 1, writerStateBytes: history.writerStateBytes(), genesis, context: proposal.context, phase: 'DRAINED', proposal, manifest, drained, inherited, activation: null };
  const exact = previous?.proposal && witnessHandoffProposalId(previous.proposal) === witnessHandoffProposalId(proposal) && previous.manifest && witnessHandoffDigest(previous.manifest) === witnessHandoffDigest(manifest);
  if (!exact || !['DRAINED','NEW_READY','ACTIVE_NEW'].includes(previous!.phase)) await history.writeHandoffState(next);
  return { manifest, proposal, drained, next };
}
export async function installProtectedWitnessTransfer(history: History, values: Array<WitnessTerminalEvidence | WitnessFreezeEvidence>, manifestValue: WitnessTransferManifest, drainedValue: WitnessDrainReport[], witnessKey: SigningKeyPair, signal?: AbortSignal, pins: WitnessTerminalPins[] = []) {
  const witness = Buffer.from(witnessKey.publicKey).toString('base64url');
  if (!parseWitnessHandoffProposal(manifestValue.proposal).newSet.members.some(m => m.publicKey === witness)) throw new Error('Readiness key is absent from successor cohort');
  const { manifest, proposal, drained, next } = await installVerifiedWitnessState(history,values,manifestValue,drainedValue,signal,pins);
  const roles = history.roleState();
  if (roles.witness && roles.witness.witness !== witness) throw new Error('Successor cannot replace another captured participant');
  const capture = { ...roles, witness: roles.witness ?? { version: 2 as const, witness, votes: [], retiredIssuerKeys: [] } };
  const review = await history.planRoleCapture(capture); await history.captureRoles(capture, review.approvalDigest);
  if (history.handoffState()!.phase === 'DRAINED') await history.writeHandoffState({ ...next, phase: 'NEW_READY' });
  return createWitnessReadyReport(proposal, witnessHandoffDigest(manifest), drained, witnessKey);
}
/** Destination relays independently install all constraints too. Their local
 * accepted rows stay local; this receipt is not a successor witness readiness vote. */
export async function installProtectedCoordinatorTransfer(history: History, values: Array<WitnessTerminalEvidence | WitnessFreezeEvidence>, manifestValue: WitnessTransferManifest, drainedValue: WitnessDrainReport[], coordinatorKey: SigningKeyPair, signal?: AbortSignal, pins: WitnessTerminalPins[] = []) {
  const coordinator=Buffer.from(coordinatorKey.publicKey).toString('base64url');
  if (!parseWitnessHandoffProposal(manifestValue.proposal).newSet.coordinators.includes(coordinator)) throw new Error('Coordinator is absent from successor epoch');
  const {next,manifest}=await installVerifiedWitnessState(history,values,manifestValue,drainedValue,signal,pins), roles=history.roleState();
  if (roles.coordinator && roles.coordinator.coordinator!==coordinator) throw new Error('Coordinator installation cannot replace another retained role');
  const capture={...roles,coordinator:roles.coordinator??{version:2 as const,coordinator,certificates:[],retiredIssuerKeys:[]}};
  const review=await history.planRoleCapture(capture);await history.captureRoles(capture,review.approvalDigest);
  if(history.handoffState()!.phase==='DRAINED')await history.writeHandoffState({...next,phase:'NEW_READY'});
  return {version:1,kind:'witness-coordinator-installed',manifest:witnessHandoffDigest(manifest)};
}
export async function activateProtectedWitnessTransfer(history: History, activationValue: WitnessHandoffActivation) {
  const activation = parseWitnessHandoffActivation(copyAdmissionReplayValue(activationValue)), current = history.handoffState();
  if (current?.phase === 'ACTIVE_NEW' && JSON.stringify(current.activation) === JSON.stringify(activation)) return;
  if (!current?.manifest || !current.proposal || current.phase !== 'NEW_READY' || activation.manifest !== witnessHandoffDigest(current.manifest)
    || witnessHandoffProposalId(activation.proposal) !== witnessHandoffProposalId(current.proposal)) throw new Error('Witness activation requires its exact durable readiness');
  const installed = history.read().image.policy;
  const entry = installed.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === activation.proposal.issuerKey);
  if (!entry?.witnessHandoff || JSON.stringify(entry.witnessHandoff) !== JSON.stringify(activation)) throw new Error('Install the authority signed observer-activated immediate policy before witness activation');
  await history.writeHandoffState({ ...current, phase: 'ACTIVE_NEW', activation,
    inherited: mergeWitnessEvidence([current.inherited, { ...emptyWitnessEvidence(), sets: [activation.proposal.newSet], activations: [activation] }]) });
}
export async function retainOriginalWitnessCertificate(history: History, certificate: AdmissionSpendCertificate) {
  const current = history.handoffState(), claim = certificate?.votes?.[0];
  const set = current?.inherited.sets.find(s => admissionWitnessSetId(s) === claim?.setId);
  if (!current || !set || !verifyAdmissionSpendCertificate(certificate, claim, set)) throw new Error('Recovery requires a genuine retained-epoch four-vote certificate');
  const inherited = mergeWitnessEvidence([localEvidence(history), { ...emptyWitnessEvidence(), certificates: [copyAdmissionReplayValue(certificate)] }]);
  await history.writeHandoffState({ ...current, inherited });
  return witnessConstraint(inherited, claim);
}
