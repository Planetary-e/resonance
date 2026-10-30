import { parseWitnessHandoffProposal, parseWitnessFreezeReport, parseWitnessHandoffActivation, witnessHandoffProposalId, witnessHandoffObserverPins, isWitnessHandoffDigest, type WitnessHandoffProposal, type WitnessFreezeReport, type WitnessHandoffActivation } from '@resonance/core/admission-witness-handoff';
import { admissionWitnessSetId } from '@resonance/core/admission-witness';
/** Shared semantic validation for local and replicated observer snapshots. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { verifyAdmissionPolicy, assertAdmissionPolicySuccessor, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, sameAdmissionPolicyHead, matchesAdmissionPolicyHead, parseAdmissionPolicyAdvanceCommitment,
  type AdmissionPolicyAdvance, type AdmissionPolicyAdvanceCommitment } from '@resonance/core/admission-policy-advance';

import { archivedAdmissionPolicyDigest, verifyAdmissionPolicyV3, decodeAdmissionPolicyArchivePage, admissionPolicyArchivePageDigest,
  inspectResolvedAdmissionPolicy, resolveAdmissionPolicyAdvance, type ArchivedAdmissionPolicy, type ResolvedAdmissionPolicy,
  type AdmissionPolicyArchiveLimits, type AdmissionPolicyArchiveReader } from '@resonance/core/admission-policy-archive';

export interface AdmissionPolicyObserverState {
  version: 1 | 2; contextId: string; policy: ArchivedAdmissionPolicy;
  previous: ArchivedAdmissionPolicy | null; advance: AdmissionPolicyAdvanceCommitment | null;
  conflict: AdmissionPolicyAdvanceCommitment | null;
  /** V2 snapshot fence: only newly staged pages, never the full archive. */
  writerStateBytes?: number;
  handoff?: WitnessObserverSeal;
  archiveAppend?: Array<{ digest: string; data: string }>;
}
export const ADMISSION_POLICY_OBSERVER_MAX_BYTES = 2 * 1024 * 1024;
export function samePolicyObserverAdvance(a: AdmissionPolicyAdvanceCommitment, b: AdmissionPolicyAdvanceCommitment) {
  return a.contextId === b.contextId && sameAdmissionPolicyHead(a.previous, b.previous) && sameAdmissionPolicyHead(a.next, b.next);
}
export const policyObserverStateHead = (state: AdmissionPolicyObserverState, context: AdmissionPolicyObservers) => state.advance?.next ?? context.genesis;
export async function parseAdmissionPolicyObserverState(value: unknown, context: AdmissionPolicyObservers): Promise<AdmissionPolicyObserverState> {
  if ((value as AdmissionPolicyObserverState)?.policy?.version === 3 || (value as AdmissionPolicyObserverState)?.version === 2) throw new Error('V3 observer snapshots require resolved original ancestry');
  if (!exactWitnessFields(value, ['version', 'contextId', 'policy', 'previous', 'advance', 'conflict', ...((value as AdmissionPolicyObserverState)?.handoff ? ['handoff'] : []), ...((value as AdmissionPolicyObserverState)?.writerStateBytes!==undefined ? ['writerStateBytes'] : [])])
    || value.version !== 1 || value.contextId !== admissionPolicyObserversId(context)
    || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_OBSERVER_MAX_BYTES) throw new Error('Invalid policy observer state');
  const writerStateBytes=value.writerStateBytes;
  if(writerStateBytes!==undefined&&(!Number.isSafeInteger(writerStateBytes)||(writerStateBytes as number)<1024*1024||(writerStateBytes as number)>40*1024*1024))throw new Error('Invalid protected observer capacity pin');
  const retained = structuredClone(value), handoff = retained.handoff ? parseWitnessObserverSeal(retained.handoff, context) : undefined, policy = await verifyAdmissionPolicy(retained.policy, context.authority);
  if (retained.previous === null) {
    if (retained.advance !== null || retained.conflict !== null || !sameAdmissionPolicyHead(admissionPolicyHead(policy), context.genesis)) throw new Error('Invalid retained policy genesis');
    return { version: 1, contextId: retained.contextId as string, policy, previous: null, advance: null, conflict: null, ...(handoff ? { handoff } : {}), ...(writerStateBytes===undefined?{}:{writerStateBytes:writerStateBytes as number}) };
  }
  const previous = await verifyAdmissionPolicy(retained.previous, context.authority), advance = parseAdmissionPolicyAdvanceCommitment(retained.advance, context);
  if (!matchesAdmissionPolicyHead(previous, advance.previous) || !matchesAdmissionPolicyHead(policy, advance.next)) throw new Error('Retained policy transition differs from its signed heads');
  assertAdmissionPolicySuccessor(previous, policy);
  const conflict = retained.conflict === null ? null : parseAdmissionPolicyAdvanceCommitment(retained.conflict, context);
  if (conflict && (conflict.next.revision !== advance.next.revision || samePolicyObserverAdvance(conflict, advance))) throw new Error('Invalid retained policy conflict');
  return { version: 1, contextId: retained.contextId as string, policy, previous, advance, conflict, ...(handoff ? { handoff } : {}), ...(writerStateBytes===undefined?{}:{writerStateBytes:writerStateBytes as number}) };
}
/** Input advance must already have passed parseAdmissionPolicyAdvance. Currentness
 * is an execution check; historical replay may legitimately contain expired policies. */
export function advanceAdmissionPolicyObserverState(current: AdmissionPolicyObserverState, next: AdmissionPolicyAdvance, context: AdmissionPolicyObservers) {
  if (current.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations');
  const head = policyObserverStateHead(current, context);
  if (next.commitment.next.revision === head.revision && current.advance) {
    return samePolicyObserverAdvance(next.commitment, current.advance) ? current : { ...current, conflict: next.commitment };
  }
  if (!sameAdmissionPolicyHead(next.commitment.previous, head)) throw new Error('Policy advance skips or rolls back the retained head');
  if (current.policy.version === 3) throw new Error('Legacy observer advancement refuses v3');
  assertAdmissionPolicySuccessor(current.policy, next.policy);
  return { ...current, previous: current.policy, policy: next.policy, advance: next.commitment };
}
/** Both states must have been independently authenticated before this chain check. */
export function assertPolicyObserverStateSuccessor(before: AdmissionPolicyObserverState, after: AdmissionPolicyObserverState, context: AdmissionPolicyObservers) {
  if(before.writerStateBytes!==after.writerStateBytes)throw new Error('Observer history cannot change its pinned writer capacity');
  assertWitnessObserverTransition(before, after, context);
  if (sameObserverPolicyState(before, after)) return;
  if (before.conflict) throw new Error('Policy observer history continued after equivocation');
  if (after.conflict) {
    if (!before.advance || JSON.stringify({ ...after, conflict: null }) !== JSON.stringify(before)) throw new Error('Policy observer history lost conflict ancestry');
  } else {
    if (!after.advance || !after.previous || JSON.stringify(after.previous) !== JSON.stringify(before.policy)
      || !sameAdmissionPolicyHead(after.advance.previous, policyObserverStateHead(before, context))) throw new Error('Policy observer history skips or rolls back a head');
  }
}

/** Snapshot decoder only. A v3 snapshot becomes usable only through resolveObserverSnapshot. */
export async function parsePolicyObserverSnapshot(value: unknown, context: AdmissionPolicyObservers): Promise<AdmissionPolicyObserverState> {
  if ((value as AdmissionPolicyObserverState)?.version !== 2) return parseAdmissionPolicyObserverState(value, context);
  if (!exactWitnessFields(value, ['version','contextId','policy','previous','advance','conflict','archiveAppend', ...((value as AdmissionPolicyObserverState)?.handoff ? ['handoff'] : []), ...((value as AdmissionPolicyObserverState)?.writerStateBytes!==undefined ? ['writerStateBytes'] : [])])
    || value.contextId !== admissionPolicyObserversId(context) || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_OBSERVER_MAX_BYTES
    || !Array.isArray(value.archiveAppend) || value.archiveAppend.length > 2) throw new Error('Invalid bounded v3 observer snapshot');
  const input = structuredClone(value);
  if(input.writerStateBytes!==undefined&&(!Number.isSafeInteger(input.writerStateBytes)||(input.writerStateBytes as number)<1024*1024||(input.writerStateBytes as number)>40*1024*1024))throw new Error('Invalid protected observer capacity pin');
  const policy = await verifyAdmissionPolicyV3(input.policy, context.authority);
  const previous = (input.previous as { version?: unknown })?.version === 3
    ? await verifyAdmissionPolicyV3(input.previous, context.authority) : await verifyAdmissionPolicy(input.previous, context.authority);
  const advance = parseAdmissionPolicyAdvanceCommitment(input.advance, context);
  if (previous.revision !== advance.previous.revision || archivedAdmissionPolicyDigest(previous) !== advance.previous.digest
    || policy.revision !== advance.next.revision || archivedAdmissionPolicyDigest(policy) !== advance.next.digest) throw new Error('V3 snapshot differs from signed heads');
  const archiveAppend: NonNullable<AdmissionPolicyObserverState['archiveAppend']> = [];
  for (const raw of input.archiveAppend as unknown[]) {
    if (!exactWitnessFields(raw, ['digest','data']) || typeof raw.data !== 'string' || raw.data.length > Math.ceil(512 * 1024 * 4 / 3)) throw new Error('Invalid archive append page');
    const bytes = Buffer.from(raw.data, 'base64url');
    if (bytes.toString('base64url') !== raw.data || admissionPolicyArchivePageDigest(bytes) !== raw.digest) throw new Error('Archive append page digest differs');
    const page = await decodeAdmissionPolicyArchivePage(bytes);
    if (page.contextId !== input.contextId || archiveAppend.some(p => p.digest === raw.digest)) throw new Error('Archive append page context or duplicate differs');
    archiveAppend.push({ digest: raw.digest as string, data: raw.data });
  }
  const conflict = input.conflict === null ? null : parseAdmissionPolicyAdvanceCommitment(input.conflict, context);
  if (conflict && (conflict.next.revision !== advance.next.revision || samePolicyObserverAdvance(conflict, advance))) throw new Error('Invalid v3 retained conflict');
  return { version: 2, contextId: input.contextId as string, policy, previous, advance, conflict, archiveAppend, ...(input.handoff ? { handoff: parseWitnessObserverSeal(input.handoff, context) } : {}), ...(input.writerStateBytes===undefined?{}:{writerStateBytes:input.writerStateBytes as number}) };
}
/** Binds a snapshot to the exact resolved predecessor and verifies every required page. */
export async function resolveObserverSnapshot(stateValue: AdmissionPolicyObserverState, context: AdmissionPolicyObservers, options: {
  previous: ResolvedAdmissionPolicy; reader: AdmissionPolicyArchiveReader; limits: AdmissionPolicyArchiveLimits; signal?: AbortSignal;
}): Promise<ResolvedAdmissionPolicy> {
  const state = structuredClone(stateValue), before = inspectResolvedAdmissionPolicy(options.previous);
  if (!state.previous || !state.advance || JSON.stringify(state.previous) !== JSON.stringify(before.policy)
    || !sameAdmissionPolicyHead(state.advance.previous, before.head) || state.contextId !== admissionPolicyObserversId(context)) throw new Error('Observer snapshot lost original resolved predecessor');
  const appended = state.archiveAppend ?? [];
  if (state.policy.version === 3) {
    const prefix = before.policy.version === 3 ? before.policy.archive.pageCount : 0;
    if (appended.length !== state.policy.archive.pageCount - prefix) throw new Error('Observer snapshot omitted or added archive append pages');
    let prior = before.policy.version === 3 ? before.policy.archive.root : null;
    for (let i = 0; i < appended.length; i++) {
      const page = await decodeAdmissionPolicyArchivePage(Buffer.from(appended[i].data, 'base64url'));
      if (page.index !== prefix + i || page.previous !== prior) throw new Error('Observer archive append reordered or rewrote its prefix');
      prior = appended[i].digest;
    }
    if (prior !== state.policy.archive.root) throw new Error('Observer archive append lost signed root');
  } else if (appended.length) throw new Error('Legacy policy cannot append archive pages');
  return resolveAdmissionPolicyAdvance({ previous: options.previous, advance: { commitment: state.advance, policy: state.policy },
    selectedHead: state.advance.next, limits: options.limits, signal: options.signal,
    reader: async (digest, signal) => { const page = appended.find(p => p.digest === digest); return page ? Buffer.from(page.data, 'base64url') : options.reader(digest, signal); } });
}
export function assertPolicyObserverCurrent(policy: ArchivedAdmissionPolicy, now: number) {
  if (!Number.isSafeInteger(now) || now < policy.issuedAt || now >= policy.expiresAt) throw new Error('Community admission policy is not current; import a current signed revision');
}

/** No tokens, claims or client identifiers enter observer sealing. */
export interface WitnessObserverSeal {
  version: 1; proposal: WitnessHandoffProposal; manifest: string;
  freezes: WitnessFreezeReport[]; activation: WitnessHandoffActivation | null;
}
export function parseWitnessObserverSeal(value: unknown, context: AdmissionPolicyObservers): WitnessObserverSeal {
  if (!exactWitnessFields(value, ['version','proposal','manifest','freezes','activation']) || value.version !== 1
    || !isWitnessHandoffDigest(value.manifest) || !Array.isArray(value.freezes) || value.freezes.length !== 4) throw new Error('Invalid durable witness observer seal');
  const proposal = parseWitnessHandoffProposal(value.proposal), freezes = value.freezes.map(v => parseWitnessFreezeReport(v, proposal));
  if (admissionPolicyObserversId(proposal.context) !== admissionPolicyObserversId(context) || new Set(freezes.map(v => v.witness)).size !== 4) throw new Error('Seal differs from four original histories or observer pins');
  const activation = value.activation === null ? null : parseWitnessHandoffActivation(value.activation);
  if (activation && (witnessHandoffProposalId(activation.proposal) !== witnessHandoffProposalId(proposal) || activation.manifest !== value.manifest
    || JSON.stringify([...activation.freezes].sort((a,b) => a.witness.localeCompare(b.witness))) !== JSON.stringify([...freezes].sort((a,b) => a.witness.localeCompare(b.witness))))) throw new Error('Activation differs from durable observer seal');
  return { version: 1, proposal, manifest: value.manifest, freezes, activation };
}
export function sameObserverPolicyState(before: AdmissionPolicyObserverState, after: AdmissionPolicyObserverState) {
  const { handoff: _, ...a } = before, { handoff: __, ...b } = after;
  return JSON.stringify(a) === JSON.stringify(b);
}
export function assertWitnessObserverTransition(before: AdmissionPolicyObserverState, after: AdmissionPolicyObserverState, context: AdmissionPolicyObservers) {
  const prior = before.handoff, next = after.handoff;
  if (sameObserverPolicyState(before, after)) {
    if (JSON.stringify(prior) === JSON.stringify(next)) throw new Error('Observer history cannot add an empty witness transition');
    if (!next || next.activation || prior && !prior.activation || !sameAdmissionPolicyHead(next.proposal.previous, policyObserverStateHead(before, context))) throw new Error('Observer seal cannot be cancelled, replaced or unfenced');
    const entry = before.policy.keys.find(e => e.witnesses && admissionWitnessSetId(e.witnesses) === admissionWitnessSetId(next.proposal.oldSet));
    if (!entry || before.policy.keys.some(e => e.witnesses?.version !== 2 || e.witnesses.observerContext !== witnessHandoffObserverPins(context))) throw new Error('Every predecessor authorization path must be explicitly protected');
    return;
  }
  if (prior && !prior.activation) {
    if (!next?.activation || witnessHandoffProposalId(prior.proposal) !== witnessHandoffProposalId(next.proposal)
      || prior.manifest !== next.manifest || !sameAdmissionPolicyHead(prior.proposal.previous, policyObserverStateHead(before, context))) throw new Error('Sealed observer requires the exact drained activation');
    const entry = after.policy.keys.find(e => e.witnesses && admissionWitnessSetId(e.witnesses) === admissionWitnessSetId(next.proposal.newSet));
    if (!entry || JSON.stringify(entry.witnessHandoff) !== JSON.stringify(next.activation)) throw new Error('Activated policy omitted the exact four successor readiness proofs');
  } else {
    if (JSON.stringify(prior) !== JSON.stringify(next)) throw new Error('Policy update changed retained witness seal evidence');
    for (const entry of after.policy.keys) {
      const previous = before.policy.keys.find(e => e.profile.issuerPublicKey === entry.profile.issuerPublicKey);
      if (previous && JSON.stringify(previous.witnesses) !== JSON.stringify(entry.witnesses)) throw new Error('Witness replacement requires a durable observer seal and drain');
    }
  }
}
