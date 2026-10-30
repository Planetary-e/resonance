import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryParse, sustainableRecoveryConcat, sustainableRecoveryView, withSustainableRecoveryWork } from './sustainable-recovery-work.js';
import { SUSTAINABLE_RECOVERY_LIMITS } from './sustainable-recovery-manifest.js';
import { recoveryDigest } from './sustainable-recovery-protected-arena.js';
import { parseAdmissionWitnessSet, admissionWitnessSetId, type AdmissionWitnessSet } from '@resonance/core/admission-witness';
import { parseWitnessHandoffActivation, type WitnessHandoffProposal } from '@resonance/core/admission-witness-handoff';
import type { SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import type { RecoveryBusinessState, RecoveryBusinessCommand, RecoveryCertificate, RecoveryHeader, RecoveryJournal, RecoveryProposal, RecoveryViewChange } from './sustainable-recovery-runtime.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const textBytes = (value: string) => Buffer.byteLength(value);
const optionalSize = (present: boolean, size: number) => 1 + (present ? size : 0);
const certificateSize = () => 4 + 1 + 4 + 1024 + 4 + 4 * 96;
const commandSize = (command: RecoveryBusinessCommand) => 4 + 4 + 1 + (command.kind === 'cut' ? 0 : 4) + (command.kind === 'cut' ? 0
  : command.kind === 'reconfigure' ? textBytes(JSON.stringify(command.proposal))
  : command.kind === 'vote' ? textBytes(JSON.stringify(command.vote))
  : command.kind === 'certificate' ? textBytes(JSON.stringify(command.certificate))
  : textBytes(JSON.stringify(command.request)) + 4 + textBytes(JSON.stringify(command.certificate)));
const proposalSize = (proposal: RecoveryProposal) => 4 + 4 + 1024 + 32 + 64 + commandSize(proposal.command);
const preparedSize = (prepared: { proposal: RecoveryProposal; certificate: RecoveryCertificate | null }) =>
  proposalSize(prepared.proposal) + optionalSize(!!prepared.certificate, certificateSize());
const viewChangeSize = (record: RecoveryViewChange) =>
  4 + 4 + 8 + 32 + certificateSize() + 32 + 8 + 32 + optionalSize(!!record.prepared, record.prepared ? preparedSize(record.prepared) : 0) + 64;

class Writer {
  readonly bytes: Buffer;
  offset = 0;
  constructor(size: number) {
    this.bytes = Buffer.alloc(size);
    chargeSustainableRecoveryWork(size, 'V', 'allocate');
  }
  u8(value: number) { this.bytes.writeUInt8(value, this.offset); this.offset += 1; }
  u32(value: number) { this.bytes.writeUInt32BE(value, this.offset); this.offset += 4; }
  u64(value: number) { this.bytes.writeBigUInt64BE(BigInt(value), this.offset); this.offset += 8; }
  raw(value: Uint8Array) { Buffer.from(value).copy(this.bytes, this.offset); this.offset += value.length; }
  digest(value: string) { this.raw(Buffer.from(value.slice(7), 'hex')); }
  text(value: string) { this.u32(textBytes(value)); this.raw(Buffer.from(value)); }
  json(value: unknown) { this.text(JSON.stringify(value)); }
  optional<T>(value: T | null | undefined, write: (value: T) => void) { this.u8(value ? 1 : 0); if (value) write(value); }
  done() { if (this.offset !== this.bytes.length) throw new Error('Binary recovery writer length mismatch'); return this.bytes; }
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new Error(`Binary recovery input overflow: offset=${this.offset} take=${length} total=${this.bytes.length}`);
    const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value;
  }
  u8() { return this.take(1).readUInt8(0); }
  u32() { return this.take(4).readUInt32BE(0); }
  u64() { const value = Number(this.take(8).readBigUInt64BE(0)); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Binary recovery integer overflow'); return value; }
  digest() { return `sha256:${this.take(32).toString('hex')}`; }
  text() { const bytes = this.take(this.u32()); return decoder.decode(bytes); }
  json<T>() { return sustainableRecoveryParse(this.text(), 'V') as T; }
  optional<T>(read: () => T): T | undefined { const start=this.offset,present = this.u8(); if (present > 1) throw new Error(`Invalid binary optional tag at ${start}: ${present}`); if(!present)return undefined;try{return read();}catch(error){throw new Error(`Binary optional at ${start}: ${error instanceof Error?error.message:String(error)}`);} }
  done() { if (this.offset !== this.bytes.length) throw new Error('Binary recovery trailing data'); }
}

function writeHeader(writer: Writer, header: RecoveryHeader) {
  writer.u64(header.view); writer.u64(header.sequence);
  for (const name of ['configuration','previous','command','state','proofRoot','policy','previousCut','terminal','funding','genesis','context'] as const) writer.digest(header[name]);
  writer.raw(new Uint8Array(1024-(16+11*32)));
}
function readHeader(reader: Reader, version: number): RecoveryHeader {
  if (version !== 1) throw new Error('Recovery header version differs');
  const view = reader.u64(), sequence = reader.u64(), configuration=reader.digest(), previous=reader.digest(), command=reader.digest(), state=reader.digest(),
    proofRoot=reader.digest(), policy=reader.digest(), previousCut=reader.digest(), terminal=reader.digest(),
    funding=reader.digest(), genesis=reader.digest(), context=reader.digest();
  reader.take(1024-(16+11*32));
  return { version: 1, view, sequence, configuration, previous, command, state, proofRoot, policy, previousCut, terminal, funding, genesis, context };
}

export function encodeRecoveryCertificate(certificate: RecoveryCertificate): Buffer {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  const writer = new Writer(certificateSize());
  writer.text('RCC1'); writer.u8(certificate.phase === 'prepare' ? 1 : certificate.phase === 'commit' ? 2 : 3);
  writeHeader(writer, certificate.header); writer.u32(certificate.signatures.length);
  if (certificate.signatures.length !== 4) throw new Error('Recovery certificate requires four signatures');
  for (const signature of certificate.signatures) { writer.raw(Buffer.from(signature.signer, 'base64url')); writer.raw(Buffer.from(signature.signature, 'base64url')); }
  return writer.done();
});}
export function decodeRecoveryCertificate(bytes: Uint8Array): RecoveryCertificate {
  const reader = new Reader(sustainableRecoveryView(bytes));
  if (reader.text() !== 'RCC1') throw new Error('Recovery certificate version differs');
  const phaseNumber = reader.u8(), phase = phaseNumber === 1 ? 'prepare' : phaseNumber === 2 ? 'commit' : phaseNumber === 3 ? 'cut' : undefined;
  if (!phase) throw new Error('Recovery certificate phase differs');
  const header = readHeader(reader, 1), count = reader.u32();
  if (count !== 4) throw new Error('Recovery certificate signer count differs');
  const signatures = Array.from({ length: count }, () => ({ signer: reader.take(32).toString('base64url'), signature: reader.take(64).toString('base64url') }));
  reader.done(); return { phase, header, signatures };
}

export function encodeRecoveryCommand(command: RecoveryBusinessCommand): Buffer {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  const writer = new Writer(commandSize(command));
  writer.text('RCM1'); writer.u8(command.kind === 'cut' ? 0 : command.kind === 'reconfigure' ? 1 : command.kind === 'vote' ? 2 : command.kind === 'certificate' ? 3 : 4);
  if (command.kind === 'reconfigure') writer.json(command.proposal);
  else if (command.kind === 'vote') writer.json(command.vote);
  else if (command.kind === 'certificate') writer.json(command.certificate);
  else if (command.kind === 'accept') { writer.json(command.request); writer.json(command.certificate); }
  else if (command.kind !== 'cut') throw new Error('Unknown recovery command');
  return writer.done();
});}
export function decodeRecoveryCommand(bytes: Uint8Array): RecoveryBusinessCommand {
  const reader = new Reader(sustainableRecoveryView(bytes));
  if (reader.text() !== 'RCM1') throw new Error('Recovery command version differs');
  const kind = reader.u8();
  if (kind === 0) { reader.done(); return { kind: 'cut' }; }
  if (kind === 1) { const proposal = reader.json<WitnessHandoffProposal>(); reader.done(); return { kind: 'reconfigure', proposal }; }
  if (kind === 2) { const vote = reader.json<Extract<RecoveryBusinessCommand, { kind: 'vote' }>['vote']>(); reader.done(); return { kind: 'vote', vote }; }
  if (kind === 3) { const certificate = reader.json<Extract<RecoveryBusinessCommand, { kind: 'certificate' }>['certificate']>(); reader.done(); return { kind: 'certificate', certificate }; }
  if (kind === 4) { const request = reader.json<Extract<RecoveryBusinessCommand, { kind: 'accept' }>['request']>(); const certificate = reader.json<Extract<RecoveryBusinessCommand, { kind: 'accept' }>['certificate']>(); reader.done(); return { kind: 'accept', request, certificate }; }
  throw new Error('Recovery command kind differs');
}

export function encodeRecoveryProposal(proposal: RecoveryProposal): Buffer {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  const writer = new Writer(proposalSize(proposal));
  writer.text('RCP1'); writeHeader(writer, proposal.header); writer.raw(Buffer.from(proposal.leader, 'base64url'));
  writer.raw(Buffer.from(proposal.signature, 'base64url')); writer.raw(encodeRecoveryCommand(proposal.command)); return writer.done();
});}
export function decodeRecoveryProposal(bytes: Uint8Array): RecoveryProposal {
  const reader = new Reader(sustainableRecoveryView(bytes));
  if (reader.text() !== 'RCP1') throw new Error('Recovery proposal version differs');
  const header = readHeader(reader, 1), leader = reader.take(32).toString('base64url'), signature = reader.take(64).toString('base64url'), command = decodeRecoveryCommand(reader.take(reader.bytes.length - reader.offset));
  reader.done(); return { header, leader, signature, command };
}

function proposalByteLength(reader: Reader) {
  const probe = new Reader(reader.bytes); probe.offset = reader.offset;
  probe.text(); probe.take(1024 + 32 + 64); probe.text(); const kind = probe.u8();
  if (kind === 1 || kind === 2 || kind === 3) probe.json();
  else if (kind === 4) { probe.json(); probe.json(); }
  else if (kind !== 0) throw new Error('Recovery command kind differs');
  return probe.offset - reader.offset;
}
function preparedByteLength(reader: Reader) {
  const probe = new Reader(reader.bytes); probe.offset = reader.offset;
  probe.take(proposalByteLength(probe)); const present = probe.u8();
  if (present > 1) throw new Error('Invalid binary optional tag'); if (present) probe.take(certificateSize());
  return probe.offset - reader.offset;
}
function viewChangeByteLength(reader: Reader) {
  const probe = new Reader(reader.bytes); probe.offset = reader.offset;
  probe.text(); probe.u64(); probe.take(32); probe.take(certificateSize()); probe.take(32 + 8 + 32);
  const present = probe.u8(); if (present > 1) throw new Error('Invalid binary optional tag'); if (present) probe.take(preparedByteLength(probe));
  probe.take(64); return probe.offset - reader.offset;
}
function encodePrepared(writer: Writer, prepared: { proposal: RecoveryProposal; certificate: RecoveryCertificate | null }) {
  writer.raw(encodeRecoveryProposal(prepared.proposal)); writer.optional(prepared.certificate, value => writer.raw(encodeRecoveryCertificate(value)));
}
function readPrepared(reader: Reader) {
  const proposal = decodeRecoveryProposal(reader.take(proposalByteLength(reader)));
  const certificate = reader.optional(() => decodeRecoveryCertificate(reader.take(certificateSize())));
  return { proposal, certificate: certificate ?? null };
}

export function encodeRecoveryViewChange(record: RecoveryViewChange): Buffer {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  const writer = new Writer(viewChangeSize(record));
  writer.text('RCV1'); writer.u64(record.view); writer.raw(Buffer.from(record.signer, 'base64url')); writer.raw(encodeRecoveryCertificate(record.base));
  writer.digest(record.floor.configuration); writer.u64(record.floor.sequence); writer.digest(record.floor.digest);
  writer.optional(record.prepared, value => encodePrepared(writer, value)); writer.raw(Buffer.from(record.signature, 'base64url')); return writer.done();
});}
export function decodeRecoveryViewChange(bytes: Uint8Array): RecoveryViewChange {
  const reader = new Reader(sustainableRecoveryView(bytes));
  if (reader.text() !== 'RCV1') throw new Error('Recovery view-change version differs');
  const view = reader.u64(), signer = reader.take(32).toString('base64url'), base = decodeRecoveryCertificate(reader.take(certificateSize()));
  const floor = { configuration: reader.digest(), sequence: reader.u64(), digest: reader.digest() };
  const prepared = reader.optional(() => readPrepared(reader)) ?? null, signature = reader.take(64).toString('base64url');
  reader.done(); return { view, signer, base, floor, prepared, signature };
}

function acceptedSize(state: RecoveryBusinessState) {
  return 4 + state.evidence.accepted.reduce((n, row) => n + 1 + [row.owner,row.spend,row.action,row.binding].reduce((m,v) => m + 4 + textBytes(v), row.issuerKey === null ? 0 : 4 + textBytes(row.issuerKey)), 0);
}
function stateSize(state: RecoveryBusinessState) {
  return 4 + 4 + 32 + 32 + 32 + 4 + state.proofs.length * 32 + 4 + (state.voteProofs?.length ?? 0) * 32 + 4 + (state.certificateProofs?.length ?? 0) * 32
    + 4 + state.evidence.activations.length * 32 + acceptedSize(state) + 4 + state.evidence.denials.reduce((n,v) => n + 4 + textBytes(v), 0) + optionalSize(!!state.transition, 32);
}
export function encodeRecoveryBusinessState(state: RecoveryBusinessState): Buffer {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  const writer = new Writer(stateSize(state));
  writer.text('RBS1'); writer.digest(state.originalGenesis); writer.digest(state.context); writer.digest(recoveryDigest(Buffer.from(JSON.stringify(state.policy))));
  writer.u32(state.proofs.length); for (const id of state.proofs) writer.digest(id);
  writer.u32(state.voteProofs?.length ?? 0); for (const id of state.voteProofs ?? []) writer.digest(id);
  writer.u32(state.certificateProofs?.length ?? 0); for (const id of state.certificateProofs ?? []) writer.digest(id);
  writer.u32(state.evidence.activations.length); for (const activation of state.evidence.activations) writer.digest(recoveryDigest(Buffer.from(JSON.stringify(activation))));
  writer.u32(state.evidence.accepted.length); for (const row of state.evidence.accepted) {
    writer.text(row.owner); writer.optional(row.issuerKey, value => writer.text(value)); writer.text(row.spend); writer.text(row.action); writer.text(row.binding);
  }
  writer.u32(state.evidence.denials.length); for (const denial of state.evidence.denials) writer.text(denial);
  writer.optional(state.transition, transition => writer.digest(recoveryDigest(encodeRecoveryCommand({ kind: 'reconfigure', proposal: transition }))));
  return writer.done();
});}

function decodeBusinessState(reader: Reader, getProof: (id: string) => Buffer): RecoveryBusinessState {
  if (reader.text() !== 'RBS1') throw new Error('Recovery state version differs');
  const originalGenesis = reader.digest(), context = reader.digest(), policyId = reader.digest();
  const policy = sustainableRecoveryParse(getProof(policyId)) as SignedAdmissionPolicy;
  const proofs = Array.from({ length: reader.u32() }, () => reader.digest());
  const voteProofs = Array.from({ length: reader.u32() }, () => reader.digest());
  const certificateProofs = Array.from({ length: reader.u32() }, () => reader.digest());
  const activations = Array.from({ length: reader.u32() }, () => parseWitnessHandoffActivation(sustainableRecoveryParse(getProof(reader.digest()))));
  const accepted = Array.from({ length: reader.u32() }, () => ({ owner: reader.text(), issuerKey: reader.optional(() => reader.text()) ?? null, spend: reader.text(), action: reader.text(), binding: reader.text() }));
  const denials = Array.from({ length: reader.u32() }, () => reader.text());
  const transition = reader.optional(() => (decodeRecoveryCommand(getProof(reader.digest())) as { kind: 'reconfigure'; proposal: WitnessHandoffProposal }).proposal);
  const sets=[...new Map([...policy.keys.flatMap(key => key.witnesses ? [key.witnesses] : []), ...activations.flatMap(activation => [activation.proposal.oldSet,activation.proposal.newSet])].map(set=>[admissionWitnessSetId(set),set])).values()];
  return { originalGenesis, context, policy, proofs, voteProofs, certificateProofs, transition,
    evidence: { sets, activations, votes: [], certificates: [], accepted, denials } };
}

function journalSize(journal: RecoveryJournal) {
  return 4 + 4 + 32 + 4 + textBytes(JSON.stringify(journal.configuration)) + 8 + 8 + 4 + 32 + stateSize(journal.state)
    + optionalSize(!!journal.prepared, journal.prepared ? preparedSize(journal.prepared) : 0) + optionalSize(!!journal.committed, certificateSize())
    + optionalSize(!!journal.stable, certificateSize()) + optionalSize(!!journal.locked, journal.locked ? preparedSize(journal.locked) : 0)
    + optionalSize(!!journal.lastViewChange, journal.lastViewChange ? viewChangeSize(journal.lastViewChange) : 0) + optionalSize(!!journal.installedNewView, 8 + 32)
    + 1 + 1 + optionalSize(!!journal.installPolicyShape, 32);
}
export function encodeRecoveryJournal(journal: RecoveryJournal): Buffer {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  const writer = new Writer(journalSize(journal));
  writer.text('RBJ1'); writer.digest(journal.layout); writer.json(journal.configuration);
  writer.u64(journal.view); writer.u64(journal.sequence); writer.u32(journal.suffix); writer.digest(journal.head); writer.raw(encodeRecoveryBusinessState(journal.state));
  writer.optional(journal.prepared, value => encodePrepared(writer, value)); writer.optional(journal.committed, value => writer.raw(encodeRecoveryCertificate(value)));
  writer.optional(journal.stable, value => writer.raw(encodeRecoveryCertificate(value))); writer.optional(journal.locked, value => encodePrepared(writer, value));
  writer.optional(journal.lastViewChange, value => writer.raw(encodeRecoveryViewChange(value)));
  writer.optional(journal.installedNewView, value => { writer.u64(value.view); writer.digest(value.identity); });
  writer.u8(journal.fenced ? 1 : 0); writer.u8(journal.stage === 'reserved' ? 1 : journal.stage === 'ready' ? 2 : 0);
  writer.optional(journal.installPolicyShape, value => writer.digest(value)); return writer.done();
});}
export function decodeRecoveryJournal(bytes: Uint8Array, getProof: (id: string) => Buffer): RecoveryJournal {
  const reader = new Reader(sustainableRecoveryView(bytes));
  if (reader.text() !== 'RBJ1') throw new Error('Recovery journal version differs');
  const layout = reader.digest(), configuration = parseAdmissionWitnessSet(reader.json());
  const view = reader.u64(), sequence = reader.u64(), suffix = reader.u32(), head = reader.digest();
  const state = decodeBusinessState(reader, getProof);
  const prepared = reader.optional(() => readPrepared(reader)) ?? null;
  const committed = reader.optional(() => decodeRecoveryCertificate(reader.take(certificateSize()))) ?? null;
  const stable = reader.optional(() => decodeRecoveryCertificate(reader.take(certificateSize()))) ?? null;
  const locked = reader.optional(() => readPrepared(reader));
  const lastViewChange = reader.optional(() => decodeRecoveryViewChange(reader.take(viewChangeByteLength(reader))));
  const installedNewView = reader.optional(() => ({ view: reader.u64(), identity: reader.digest() }));
  const fenced = reader.u8() !== 0, stageNumber = reader.u8(), installPolicyShape = reader.optional(() => reader.digest());
  const stage = stageNumber === 1 ? 'reserved' : stageNumber === 2 ? 'ready' : undefined;
  if (stageNumber > 2) throw new Error('Recovery journal stage differs');
  reader.done();
  return { version: 1, layout, state, configuration, view, sequence, suffix, head, prepared, committed, stable, locked, lastViewChange, installedNewView, fenced, stage, installPolicyShape };
}

export function cloneRecoveryBusinessState(state: RecoveryBusinessState): RecoveryBusinessState {
  return { ...state, proofs: [...state.proofs], voteProofs: [...(state.voteProofs ?? [])], certificateProofs: [...(state.certificateProofs ?? [])],
    evidence: { ...state.evidence, sets: [...state.evidence.sets], activations: [...state.evidence.activations], votes: [...state.evidence.votes], certificates: [...state.evidence.certificates],
      accepted: state.evidence.accepted.map(row => ({ ...row })), denials: [...state.evidence.denials] } };
}

export function recoveryBusinessStateDigest(state: RecoveryBusinessState): string {
  return recoveryDigest(encodeRecoveryBusinessState(state));
}

export function recoveryProposalDigest(proposal: RecoveryProposal): string {
  return recoveryDigest(encodeRecoveryCommand(proposal.command));
}

export function recoveryJournalDigest(journal: RecoveryJournal): string {
  return recoveryDigest(encodeRecoveryJournal(journal));
}

export function recoveryConfigurationDigest(configuration: AdmissionWitnessSet): string {
  return recoveryDigest(sustainableRecoveryConcat([Buffer.from('resonance:recovery-configuration:v1\n'), Buffer.from(JSON.stringify(configuration))]));
}
