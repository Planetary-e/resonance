import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair, sign, type SigningKeyPair } from '@resonance/core';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { admissionWitnessSetId, createAdmissionWitnessVote, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { parseAdmissionWitnessSet } from '@resonance/core/admission-witness';
import { mergeWitnessEvidence, witnessConstraint } from '../witness-handoff-state.js';
import { finiteRecoveryManifest } from './sustainable-recovery-fixture.js';
import { openSustainableRso5Arena } from '../sustainable-rso5-arena.js';
import { createSustainableRso5Replica, openSustainableRso5ProtectedArena, type Rso5StateRecord, type Rso5Transport } from '../sustainable-rso5-protected-arena.js';
import { createRso5Checkpoint, createRso5Delegation, createRso5Frame, createRso5RecipientEnrollment, generateRso5RecipientKey, openRso5Delegation, openRso5Frame, parseRso5Checkpoint, parseRso5Delegation, parseRso5Frame, rso5Digest, rso5ScopeId, RSO5_ZERO_HEAD, type Rso5FrameIdentity, type Rso5OriginalBinding } from '../sustainable-rso5-opaque.js';
import { rso5PhysicalClosure, preflightRso5Manifest } from '../sustainable-rso5-manifest.js';
import { assertRso5CheckpointSigners, materializeRso5Evidence, rso5BusinessProofRoot, type RecoveryBusinessCommand, type RecoveryBusinessState, type RecoveryTransfer } from '../sustainable-rso5-runtime.js';
import { rso5ProofRoot } from '../sustainable-rso5-codec.js';
import { encodeRecoveryCommand } from '../sustainable-recovery-codec.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryWorkUsage, withDiagnosticUnboundedRecoveryWork, withSustainableRecoveryWork } from '../sustainable-recovery-work.js';

const cleanup: Array<() => unknown> = []; afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'rso5-manifest-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authority = openStorageReservationAuthority({ directory: join(directory, 'funding'), mode: 'create-new', limitBytes: 2 * 1024 ** 3 }); cleanup.push(authority.close);
  return { directory, authority, manifest: finiteRecoveryManifest(join(directory, 'arenas')) };
}
const binding: Rso5OriginalBinding = { genesis: rso5Digest(Buffer.from('rso5 genesis')), configuration: rso5Digest(Buffer.from('rso5 configuration')), context: rso5Digest(Buffer.from('rso5 context')) };
async function node(f: ReturnType<typeof setup>, ownerName: string, signingKey: SigningKeyPair) {
  const recipientKey = await generateRso5RecipientKey(), scope = rso5Digest(Buffer.from(`endpoint:${ownerName}`)), localOptions = { authority: f.authority, manifest: f.manifest, owner: ownerName, copy: 0, key: randomBytes(32) };
  const local = openSustainableRso5Arena({ ...localOptions, mode: 'new' }), replicaKeys = Array.from({ length: 5 }, generateSigningKeyPair);
  const arenas = replicaKeys.map((_, index) => openSustainableRso5Arena({ authority: f.authority, manifest: f.manifest, owner: ownerName, copy: index + 1, key: randomBytes(32), mode: 'new' })); arenas.forEach(arena => cleanup.push(arena.close));
  const replicas = replicaKeys.map((key, index) => createSustainableRso5Replica({ arena: arenas[index], scope, owner: pub(signingKey), signingKey: key })), control = { prepareFailures: 5 };
  const transport: Rso5Transport = async (replica, request) => request.action === 'prepare-checkpoint' && replicas.findIndex(item => item.replica === replica) >= control.prepareFailures ? Promise.reject(new Error('offline')) : replicas.find(item => item.replica === replica)!.exchange(request);
  const storage = openSustainableRso5ProtectedArena({ arena: local, scope, signingKey, recipientKey, replicas: replicas.map(replica => replica.replica), transport }); cleanup.push(storage.close); storage.configureOriginal(binding);
  return { storage, localOptions, replicas, replicaKeys, arenas, signingKey, recipientKey, scope, transport, control };
}
async function reopen(value: Awaited<ReturnType<typeof node>>) {
  value.storage.close(); const local = openSustainableRso5Arena({ ...value.localOptions, mode: 'existing' });
  value.storage = openSustainableRso5ProtectedArena({ arena: local, scope: value.scope, signingKey: value.signingKey, recipientKey: value.recipientKey, replicas: value.replicas.map(replica => replica.replica), transport: value.transport });
  value.storage.configureOriginal(binding); await value.storage.startup();
}
function identityFor(value: Awaited<ReturnType<typeof node>>, id: string) { return value.storage.references([id])[0]; }
function readState(value: Awaited<ReturnType<typeof node>>, index: number) { return JSON.parse(value.arenas[index].read('state')!.bytes.toString('utf8')) as Rso5StateRecord; }
function resignState(value: Awaited<ReturnType<typeof node>>, record: Rso5StateRecord): Rso5StateRecord {
  const body = Buffer.from(`resonance:rso5:state:v1\n${JSON.stringify([record.scope, record.owner, record.revision, record.ciphertext])}`);
  return { ...record, signature: Buffer.from(sign(body, value.signingKey.secretKey)).toString('base64url') };
}
function writeReplicaState(value: Awaited<ReturnType<typeof node>>, index: number, record: Rso5StateRecord) { value.arenas[index].write('state', Buffer.from(JSON.stringify(record))); }
type ReplicaReply = Awaited<ReturnType<ReturnType<typeof createSustainableRso5Replica>['exchange']>>;
function signReply(key: SigningKeyPair, reply: ReplicaReply): ReplicaReply {
  const body = Buffer.concat([Buffer.from('resonance:rso5:reply:v1\n'), Buffer.from(JSON.stringify([reply.scope, reply.challenge, reply.replica, reply.digest ?? null, reply.bytes ?? null, reply.payload ?? null, reply.record ?? null, reply.checkpointHead ?? null, reply.checkpointSequence ?? null]))]);
  return { ...reply, signature: Buffer.from(sign(body, key.secretKey)).toString('base64url') };
}

it('RSO5 closes physical inventory and rejects invalid frame/delegation/checkpoint authentication', async () => {
  const f = setup(); expect(rso5PhysicalClosure()).toEqual({ frames: 234424, archiveHeaders: 18432, delegations: 5739, total: 258595, headroom: 3549 });
  expect(preflightRso5Manifest(f.authority, f.manifest, 'new').rso5Closure.total).toBe(258595);
  const signingKey = generateSigningKeyPair(), scopeKey = randomBytes(32), plaintext = Buffer.from('exact original business object'), created = createRso5Frame({ plaintext, kind: 'original', original: binding, scopeKeyVersion: 0, scopeKey, signingKey });
  const metadata = parseRso5Frame(created.frame); expect(metadata.frameBytes).toBe(plaintext.length + 265); expect(openRso5Frame({ frame: created.frame, scopeId: metadata.scopeId, scopeKeyVersion: 0, scopeKey })).toEqual(plaintext);
  expect(() => openRso5Frame({ frame: created.frame, scopeId: metadata.scopeId, scopeKeyVersion: 1, scopeKey })).toThrow('version');
  const damaged = Buffer.from(created.frame); damaged[damaged.length - 1] ^= 1; expect(() => parseRso5Frame(damaged)).toThrow('Unauthenticated');
  const material = await generateRso5RecipientKey(), enrollment = createRso5RecipientEnrollment({ material, signingKey, role: 'witness', genesis: binding.genesis, context: binding.context });
  const delegation = await createRso5Delegation({ proposal: rso5Digest(Buffer.from('handoff')), exporter: signingKey, enrollment, entries: [{ scopeId: metadata.scopeId, scopeKeyVersion: 0, scopeKey }] });
  expect(parseRso5Delegation(delegation.bytes).digest).toBe(delegation.digest);
  const opened = await openRso5Delegation({ delegation: delegation.bytes, material, enrollment }); expect(opened).toHaveLength(1); expect(opened[0].scopeKey).toEqual(scopeKey);
  const wrongMaterial = await generateRso5RecipientKey(); await expect(openRso5Delegation({ delegation: delegation.bytes, material: wrongMaterial, enrollment })).rejects.toThrow();
});

it('RSO5 replicates exact frames and recovers privately after local C loss and rotation', async () => {
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), plaintext = Buffer.from('owner-only exact proof');
  const id = await value.storage.put(plaintext), identity = identityFor(value, id), before = value.storage.arena.usage().archiveBytes;
  for (const arena of value.arenas) expect(arena.frameStatus(identity).digest).toBe(identity.frameDigest);
  expect(value.arenas[0].getFrame(identity).equals(plaintext)).toBe(false);
  expect(await value.storage.put(plaintext)).toBe(id); expect(value.storage.arena.usage().archiveBytes).toBe(before);
  await expect(value.replicas[0].exchange({ action: 'status', scope: value.scope, challenge: randomBytes(32).toString('base64url'), identity })).resolves.toMatchObject({ digest: identity.frameDigest });
  expect(await value.storage.rotateScope()).toBe(1); const second = Buffer.from('post-rotation proof'), secondId = await value.storage.put(second), secondIdentity = identityFor(value, secondId);
  expect(parseRso5Frame(value.storage.arena.getFrame(secondIdentity)).scopeKeyVersion).toBe(1);
  const afterSecond = value.storage.arena.usage().archiveBytes, alternate = createRso5Frame({ plaintext, kind: 'original', original: binding, scopeKeyVersion: 0, scopeKey: randomBytes(32), signingKey: value.signingKey });
  expect(() => value.storage.arena.appendFrame(alternate.frame)).toThrow('Conflicting');
  await expect(value.storage.put(Buffer.alloc(262144))).rejects.toThrow(); expect(value.storage.arena.usage().archiveBytes).toBe(afterSecond);
  value.storage.close(); writeFileSync(join(f.manifest.root, 'witness-0', 'local', 'frames.bin'), Buffer.alloc(0));
  await reopen(value); expect(await value.storage.recoverProof(id, 'original', identity)).toEqual(plaintext); expect(await value.storage.recoverProof(secondId, 'original', secondIdentity)).toEqual(second);
});

it('RSO5 preserves previous checkpoints at 0/1/3/4 copies and refuses forks/tails', async () => {
  for (const copies of [0, 1, 3, 4]) {
    const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), id = await value.storage.put(Buffer.from(`checkpoint-${copies}`)), identity = identityFor(value, id), first = await value.storage.publishCheckpoint([identity]);
    const nextId = await value.storage.put(Buffer.from(`next-${copies}`)), nextIdentity = identityFor(value, nextId);
    value.control.prepareFailures = copies;
    const pending = value.storage.publishCheckpoint([identity, nextIdentity]);
    if (copies < 4) { await expect(pending).rejects.toThrow('acknowledgments'); expect(value.storage.arena.currentHead().head).toBe(first.head); }
    else { await pending; expect(value.storage.arena.currentHead().head).not.toBe(first.head); }
    const fork = createRso5Checkpoint({ sequence: 1, previousHead: first.head, configuration: binding.configuration, entries: [identity, nextIdentity], signingKey: value.signingKey });
    if (copies < 4) expect(() => value.storage.arena.prepareCheckpoint(fork.bytes)).toThrow('fork');
    value.storage.close();
  }
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), id = await value.storage.put(Buffer.from('tail proof')), identity = identityFor(value, id), checkpoint = await value.storage.publishCheckpoint([identity]);
  const file = join(f.manifest.root, 'witness-0', 'local', 'frames.bin'), failed = join(f.manifest.root, 'witness-0', 'local', 'failed.bin');
  value.storage.close(); writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('partial tail')]));
  await reopen(value); expect(value.storage.arena.usage().failedBytes).toBeGreaterThan(0); expect(await value.storage.recoverProof(id, 'original', identity)).toEqual(Buffer.from('tail proof'));
  value.storage.close(); writeFileSync(failed, randomBytes(32768)); writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('more tail')]));
  await expect(reopen(value)).rejects.toThrow('F allowance');
  const other = createRso5Checkpoint({ sequence: checkpoint.sequence + 1, previousHead: RSO5_ZERO_HEAD, configuration: binding.configuration, entries: [identity], signingKey: generateSigningKeyPair() });
  await expect(value.replicas[0].exchange({ action: 'prepare-checkpoint', scope: value.scope, challenge: randomBytes(32).toString('base64url'), payload: other.bytes.toString('base64url') })).rejects.toThrow();
});

it('RSO5 transfers cold, returning and new-view suffixes with exact references', async () => {
  const f = setup(), source = await node(f, 'witness-0', generateSigningKeyPair()), destination = await node(f, 'witness-5', generateSigningKeyPair());
  const first = Buffer.from('first transfer proof'), firstId = await source.storage.put(first), firstIdentity = identityFor(source, firstId); await source.storage.publishCheckpoint([firstIdentity]);
  const enrollment = createRso5RecipientEnrollment({ material: destination.recipientKey, signingKey: destination.signingKey, role: 'witness', genesis: binding.genesis, context: binding.context });
  const images = { stateBytes: 1024, pendingBytes: 512, suffixBytes: 1024 };
  const cold = await source.storage.exportBundle([firstId], rso5Digest(Buffer.from('cold proposal')), enrollment); await destination.storage.importBundle(cold, enrollment, images);
  expect(await destination.storage.recoverProof(firstId, 'original', firstIdentity)).toEqual(first);
  const second = Buffer.from('returning suffix proof'), secondId = await destination.storage.put(second), secondIdentity = identityFor(destination, secondId); await destination.storage.publishCheckpoint([firstIdentity, secondIdentity]);
  const returningEnrollment = createRso5RecipientEnrollment({ material: source.recipientKey, signingKey: source.signingKey, role: 'witness', genesis: binding.genesis, context: binding.context });
  const returning = await destination.storage.exportBundle([firstId, secondId], rso5Digest(Buffer.from('returning proposal')), returningEnrollment);
  await source.storage.importBundle(returning, returningEnrollment, images);
  const newView = await source.storage.exportBundle([firstId, secondId], rso5Digest(Buffer.from('new view proposal')), enrollment);
  await destination.storage.importBundle(newView, enrollment, images); expect(await destination.storage.recoverProof(secondId, 'original', secondIdentity)).toEqual(second);
  expect(rso5ProofRoot(destination.storage.references([firstId, secondId]))).toBe(rso5ProofRoot(source.storage.references([firstId, secondId])));
});

it('RSO5 import keeps divergent local checkpoint history below its committed floor', async () => {
  const f = setup(), source = await node(f, 'witness-0', generateSigningKeyPair()), destination = await node(f, 'witness-5', generateSigningKeyPair());
  const sourceId = await source.storage.put(Buffer.from('source floor')), sourceIdentity = identityFor(source, sourceId), destinationId = await destination.storage.put(Buffer.from('destination floor')), destinationIdentity = identityFor(destination, destinationId);
  await source.storage.publishCheckpoint([sourceIdentity]); const destinationCheckpoint = await destination.storage.publishCheckpoint([destinationIdentity]);
  const sourceSuffixId = await source.storage.put(Buffer.from('source suffix')), sourceSuffixIdentity = identityFor(source, sourceSuffixId); await source.storage.publishCheckpoint([sourceIdentity, sourceSuffixIdentity]);
  const enrollment = createRso5RecipientEnrollment({ material: destination.recipientKey, signingKey: destination.signingKey, role: 'witness', genesis: binding.genesis, context: binding.context }), bundle = await source.storage.exportBundle([sourceId, sourceSuffixId], rso5Digest(Buffer.from('divergent floor')), enrollment);
  await destination.storage.importBundle(bundle, enrollment, { stateBytes: 1024, pendingBytes: 512, suffixBytes: 1024 });
  expect(destination.storage.arena.currentHead().head).toBe(destinationCheckpoint.head); expect(destination.storage.arena.checkpointLog()).toHaveLength(1);
});

it('RSO5 import does not duplicate retained proof IDs into physical exhaustion', async () => {
  const f = setup(), source = await node(f, 'witness-0', generateSigningKeyPair()), destination = await node(f, 'witness-5', generateSigningKeyPair()), plaintext = Buffer.from('already retained');
  const sourceId = await source.storage.put(plaintext), sourceIdentity = identityFor(source, sourceId), destinationId = await destination.storage.put(plaintext), destinationIdentity = identityFor(destination, destinationId);
  await source.storage.publishCheckpoint([sourceIdentity]); const destinationCheckpoint = await destination.storage.publishCheckpoint([destinationIdentity]), before = destination.storage.arena.usage().archiveBytes;
  const enrollment = createRso5RecipientEnrollment({ material: destination.recipientKey, signingKey: destination.signingKey, role: 'witness', genesis: binding.genesis, context: binding.context }), bundle = await source.storage.exportBundle([sourceId], rso5Digest(Buffer.from('retained proof')), enrollment);
  await destination.storage.importBundle(bundle, enrollment, { stateBytes: 1024, pendingBytes: 512, suffixBytes: 1024 });
  expect(destinationId).toBe(sourceId); expect(destination.storage.arena.currentHead().head).toBe(destinationCheckpoint.head); expect(destination.storage.arena.usage().archiveBytes).toBe(before + 256 + Buffer.from(bundle.delegation, 'base64url').length);
});

it('RSO5 business proof roots agree across distinct local availability scopes', async () => {
  const f = setup(), first = await node(f, 'witness-0', generateSigningKeyPair()), second = await node(f, 'witness-5', generateSigningKeyPair()), plaintext = Buffer.from('same business proof');
  const firstId = await first.storage.put(plaintext), secondId = await second.storage.put(plaintext), firstReferences = first.storage.references([firstId]), secondReferences = second.storage.references([secondId]);
  expect(firstId).toBe(secondId); expect(firstReferences[0].scopeId).not.toBe(secondReferences[0].scopeId); expect(rso5ProofRoot(firstReferences)).not.toBe(rso5ProofRoot(secondReferences));
  expect(rso5BusinessProofRoot([firstId])).toBe(rso5BusinessProofRoot([secondId]));
});

it('RSO5 incremental evidence matches full original reducers', () => {
  const keys = Array.from({ length: 5 }, generateSigningKeyPair), set = parseAdmissionWitnessSet({ version: 1, quorum: 4, members: keys.map((key, index) => ({ publicKey: pub(key), endpoint: `ws://127.0.0.1:${45000 + index}/` })), coordinators: [pub(keys[0])] });
  const claim: AdmissionSpendClaim = { setId: admissionWitnessSetId(set), issuerKey: 'issuer-one', spend: 'spend-one', action: 'search', requestBinding: `admreq_${'a'.repeat(86)}` };
  const commandFor = (value: AdmissionSpendClaim): RecoveryBusinessCommand => ({ kind: 'vote', vote: createAdmissionWitnessVote(value, keys[0]) });
  const alternateClaim = { ...claim, requestBinding: `admreq_${'b'.repeat(86)}` }, command = commandFor(claim), alternate = commandFor(alternateClaim);
  const commands = new Map([[rso5Digest(encodeRecoveryCommand(command)), command], [rso5Digest(encodeRecoveryCommand(alternate)), alternate]]);
  const state: RecoveryBusinessState = { evidence: { sets: [set], activations: [], votes: [], certificates: [], accepted: [], denials: [] }, proofs: [...commands.keys()], voteProofs: [...commands.keys()], certificateProofs: [], originalGenesis: rso5Digest(Buffer.from('genesis')), context: rso5Digest(Buffer.from('context')), policy: { reserved: true } as never };
  const getCommand = (id: string) => commands.get(id)!, lookup = { setId: claim.setId, issuerKey: claim.issuerKey, spend: claim.spend };
  const full = materializeRso5Evidence(state, getCommand), incremental = materializeRso5Evidence(state, getCommand, lookup);
  expect(JSON.stringify(incremental)).toBe(JSON.stringify(full)); expect(witnessConstraint(incremental, claim)).toBe('split');
  const successorLookup = materializeRso5Evidence(state, getCommand, { ...lookup, setId: rso5Digest(Buffer.from('successor epoch')) });
  expect(JSON.stringify(successorLookup)).toBe(JSON.stringify(full)); expect(witnessConstraint(successorLookup, claim)).toBe('split');
  expect(witnessConstraint(incremental, { ...claim, spend: 'other-spend' })).toBe('fresh');
  expect(witnessConstraint({ ...incremental, certificates: [{ version: 1, votes: [createAdmissionWitnessVote(claim, keys[0]), createAdmissionWitnessVote(claim, keys[1]), createAdmissionWitnessVote(claim, keys[2]), createAdmissionWitnessVote(claim, keys[3])] }, { version: 1, votes: [createAdmissionWitnessVote(alternateClaim, keys[0]), createAdmissionWitnessVote(alternateClaim, keys[1]), createAdmissionWitnessVote(alternateClaim, keys[2]), createAdmissionWitnessVote(alternateClaim, keys[3])] }] }, claim)).toBe('conflict');
  expect(witnessConstraint({ ...incremental, denials: [claim.issuerKey] }, claim)).toBe('denied');
  if (command.kind !== 'vote') throw new Error('Expected vote command');
  const accepted = { ...incremental, votes: [command.vote], accepted: [{ owner: 'original-owner', issuerKey: claim.issuerKey, spend: claim.spend, action: claim.action, binding: claim.requestBinding }] };
  expect(witnessConstraint(accepted, claim)).toBe('bound');
});

it('RSO5 import preflights every physical and image effect before appends', async () => {
  const f = setup(), source = await node(f, 'witness-0', generateSigningKeyPair()), destination = await node(f, 'witness-5', generateSigningKeyPair());
  const id = await source.storage.put(Buffer.from('atomic import')), identity = identityFor(source, id); await source.storage.publishCheckpoint([identity]);
  const enrollment = createRso5RecipientEnrollment({ material: destination.recipientKey, signingKey: destination.signingKey, role: 'witness', genesis: binding.genesis, context: binding.context });
  const bundle = await source.storage.exportBundle([id], rso5Digest(Buffer.from('atomic proposal')), enrollment), before = [destination.storage.arena, ...destination.arenas].map(arena => ({ archive: arena.usage().archiveBytes, checkpoints: arena.usage().checkpointBytes }));
  await expect(destination.storage.importBundle(bundle, enrollment, { stateBytes: 65536, pendingBytes: 512, suffixBytes: 1024 })).rejects.toThrow('prospective image');
  expect([destination.storage.arena, ...destination.arenas].map(arena => ({ archive: arena.usage().archiveBytes, checkpoints: arena.usage().checkpointBytes }))).toEqual(before);
  const broken = createRso5Checkpoint({ sequence: 1, previousHead: RSO5_ZERO_HEAD, configuration: binding.configuration, entries: [identity], signingKey: source.signingKey });
  await expect(destination.storage.importBundle({ ...bundle, checkpoints: [...bundle.checkpoints, broken.bytes.toString('base64url')] }, enrollment, { stateBytes: 1024, pendingBytes: 512, suffixBytes: 1024 })).rejects.toThrow('chain');
  expect([destination.storage.arena, ...destination.arenas].map(arena => ({ archive: arena.usage().archiveBytes, checkpoints: arena.usage().checkpointBytes }))).toEqual(before);
});

it('RSO5 recovery selects four exact frames and ignores a Byzantine substitute', async () => {
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), plaintext = Buffer.from('exact requested proof');
  const substitute = createRso5Frame({ plaintext, kind: 'original', original: binding, scopeKeyVersion: 0, scopeKey: randomBytes(32), signingKey: value.signingKey });
  value.arenas[0].appendFrame(substitute.frame); const id = await value.storage.put(plaintext), identity = identityFor(value, id), honestTransport = value.transport;
  value.transport = async (replica, request) => {
    if (replica === value.replicas[0].replica && request.action === 'read-frame') return signReply(value.replicaKeys[0], { scope: value.scope, challenge: request.challenge, replica, digest: substitute.metadata.frameDigest, bytes: substitute.frame.length, payload: substitute.frame.toString('base64url'), record: null, signature: '' });
    return honestTransport(replica, request);
  };
  value.storage.close(); writeFileSync(join(f.manifest.root, 'witness-0', 'local', 'frames.bin'), Buffer.alloc(0)); await reopen(value);
  await expect(value.storage.recoverProof(id, 'original', identity)).resolves.toEqual(plaintext);
  await expect(value.storage.recoverProof(id, 'frame', identity)).rejects.toThrow('identity');
});

it('RSO5 state replay is idempotent and startup refuses conflicts or incomplete copies', async () => {
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()); await value.storage.write(Buffer.from('journal zero'));
  const record0 = readState(value, 0), request = { action: 'state', scope: value.scope, challenge: randomBytes(32).toString('base64url'), record: record0 }, generation = value.arenas[0].read('state')!.generation;
  await expect(value.replicas[0].exchange(request)).resolves.toMatchObject({ record: record0 }); expect(value.arenas[0].read('state')!.generation).toBe(generation);
  const conflict0 = resignState(value, { ...record0, ciphertext: randomBytes(48).toString('base64url') });
  await expect(value.replicas[0].exchange({ ...request, record: conflict0 })).rejects.toThrow('same-revision');
  await value.storage.write(Buffer.from('journal one')); const record1 = readState(value, 0), honestTransport = value.transport;
  value.storage.close(); const local = openSustainableRso5Arena({ ...value.localOptions, mode: 'existing' });
  value.transport = async (replica, request) => {
    const reply = await honestTransport(replica, request), index = value.replicas.findIndex(item => item.replica === replica);
    return index <= 1 && request.action === 'state' ? signReply(value.replicaKeys[index], { ...reply, record: record0 }) : reply;
  };
  value.storage = openSustainableRso5ProtectedArena({ arena: local, scope: value.scope, signingKey: value.signingKey, recipientKey: value.recipientKey, replicas: value.replicas.map(replica => replica.replica), transport: value.transport }); value.storage.configureOriginal(binding);
  await expect(value.storage.write(Buffer.from('journal two'))).rejects.toThrow('acknowledgment differs');
  const record2 = readState(value, 1); writeReplicaState(value, 0, resignState(value, { ...record2, ciphertext: record1.ciphertext }));
  await expect(value.storage.startup()).rejects.toThrow('same-revision');
  writeReplicaState(value, 0, record2); writeReplicaState(value, 3, record1); writeReplicaState(value, 4, record1);
  await expect(value.storage.startup()).rejects.toThrow('completed copies');
});

it('RSO5 checkpoints are incremental, replay exactly and reconcile the journal floor', async () => {
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), firstId = await value.storage.put(Buffer.from('first')), first = identityFor(value, firstId);
  await value.storage.publishCheckpoint([first]); const secondId = await value.storage.put(Buffer.from('second')), second = identityFor(value, secondId), checkpoint = await value.storage.publishCheckpoint([first, second]);
  expect(checkpoint.previousHead).not.toBe(RSO5_ZERO_HEAD); expect(checkpoint.entries).toEqual([second]); const checkpointBytes = value.storage.arena.usage().checkpointBytes;
  value.storage.arena.prepareCheckpoint(checkpoint.bytes); value.storage.arena.commitCheckpoint(checkpoint.bytes); expect(value.storage.arena.usage().checkpointBytes).toBe(checkpointBytes);
  await value.storage.write(Buffer.from('journal after completed checkpoint')); value.storage.close(); writeFileSync(join(f.manifest.root, 'witness-0', 'local', 'checkpoints.bin'), Buffer.alloc(0)); await reopen(value);
  expect(value.storage.arena.currentHead().head).toBe(checkpoint.head); value.storage.assertJournalFloor([firstId, secondId], new Map([[binding.configuration, [pub(value.signingKey)]]]));
  const thirdId = await value.storage.put(Buffer.from('journal write not checkpointed')); expect(() => value.storage.assertJournalFloor([firstId, secondId, thirdId], new Map([[binding.configuration, [pub(value.signingKey)]]]))).toThrow('exceeds');
  expect(() => value.storage.assertJournalFloor([firstId], new Map([[binding.configuration, [pub(generateSigningKeyPair())]]]))).toThrow('executed configuration');
});

it('RSO5 full local-C recovery restores frames before checkpoint floors', async () => {
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), id = await value.storage.put(Buffer.from('full local loss')), identity = identityFor(value, id), checkpoint = await value.storage.publishCheckpoint([identity]);
  await value.storage.write(Buffer.from('journal')); value.storage.close();
  writeFileSync(join(f.manifest.root, 'witness-0', 'local', 'frames.bin'), Buffer.alloc(0)); writeFileSync(join(f.manifest.root, 'witness-0', 'local', 'checkpoints.bin'), Buffer.alloc(0));
  const local = openSustainableRso5Arena({ ...value.localOptions, mode: 'existing' }), storage = openSustainableRso5ProtectedArena({ arena: local, scope: value.scope, signingKey: value.signingKey, recipientKey: value.recipientKey, replicas: value.replicas.map(replica => replica.replica), transport: value.transport });
  cleanup.push(storage.close); storage.configureOriginal(binding); await storage.startup(false); await storage.recoverProof(id, 'original', identity); await storage.startup();
  expect(storage.arena.currentHead().head).toBe(checkpoint.head); expect(storage.read()).toEqual(Buffer.from('journal')); expect(storage.get(id, 'original')).toEqual(Buffer.from('full local loss'));
});

it('RSO5 refuses pending-to-committed archive mutation before floor advancement', async () => {
  const f = setup(), value = await node(f, 'witness-0', generateSigningKeyPair()), id = await value.storage.put(Buffer.from('authenticated pending')), identity = identityFor(value, id), checkpoint = await value.storage.publishCheckpoint([identity]);
  const file = join(f.manifest.root, 'witness-0', 'local', 'checkpoints.bin'), mutated = readFileSync(file); expect(mutated.toString('ascii', 0, 4)).toBe('R5H1'); mutated.write('R5C1', 0, 'ascii');
  value.storage.close(); writeFileSync(file, mutated); const arena = openSustainableRso5Arena({ ...value.localOptions, mode: 'existing' }); cleanup.push(arena.close);
  expect(arena.currentHead()).toMatchObject({ sequence: -1, head: RSO5_ZERO_HEAD }); expect(arena.currentHead().head).not.toBe(checkpoint.head); expect(arena.usage().failedBytes).toBeGreaterThan(0);
});

it('RSO5 checkpoint authorization follows mixed authenticated returning history and refuses wrong epochs', () => {
  const oldKeys = Array.from({ length: 5 }, generateSigningKeyPair), newKeys = Array.from({ length: 5 }, generateSigningKeyPair), makeSet = (keys: SigningKeyPair[]) => parseAdmissionWitnessSet({ version: 1, quorum: 4, members: keys.map((key, index) => ({ publicKey: pub(key), endpoint: `ws://127.0.0.1:${45000 + index}/` })), coordinators: [pub(keys[0])] });
  const oldSet = makeSet(oldKeys), newSet = makeSet(newKeys), oldConfiguration = admissionWitnessSetId(oldSet), newConfiguration = admissionWitnessSetId(newSet);
  const first = createRso5Checkpoint({ sequence: 0, previousHead: RSO5_ZERO_HEAD, configuration: oldConfiguration, entries: [], signingKey: oldKeys[0] }), second = createRso5Checkpoint({ sequence: 1, previousHead: first.head, configuration: newConfiguration, entries: [], signingKey: newKeys[0] });
  const transfer = { state: { evidence: { sets: [oldSet, newSet] } }, checkpoints: [first.bytes.toString('base64url'), second.bytes.toString('base64url')] } as RecoveryTransfer;
  expect(() => assertRso5CheckpointSigners(transfer, newSet, oldSet)).not.toThrow();
  const future = createRso5Checkpoint({ sequence: 2, previousHead: second.head, configuration: oldConfiguration, entries: [], signingKey: newKeys[0] }), retired = createRso5Checkpoint({ sequence: 2, previousHead: second.head, configuration: newConfiguration, entries: [], signingKey: oldKeys[0] }), rogue = createRso5Checkpoint({ sequence: 2, previousHead: second.head, configuration: newConfiguration, entries: [], signingKey: generateSigningKeyPair() });
  for (const checkpoint of [future, retired, rogue]) expect(() => assertRso5CheckpointSigners({ ...transfer, checkpoints: [...transfer.checkpoints, checkpoint.bytes.toString('base64url')] }, newSet, oldSet)).toThrow('executed journal configuration');
});

it('RSO5 binds image keys to the authority and meters transfer/list conversions', async () => {
  const first = setup(), second = setup(), key = randomBytes(32), a = openSustainableRso5Arena({ authority: first.authority, manifest: first.manifest, owner: 'witness-0', copy: 0, key, mode: 'new' }), b = openSustainableRso5Arena({ authority: second.authority, manifest: second.manifest, owner: 'witness-0', copy: 0, key, mode: 'new' }); cleanup.push(a.close, b.close);
  const sealed = a.seal(Buffer.from('authority bound')); expect(a.unseal(sealed)).toEqual(Buffer.from('authority bound')); expect(() => b.unseal(sealed)).toThrow();
  const imageWrites = withSustainableRecoveryWork(4718592, () => { a.write('state', Buffer.alloc(32)); a.write('state', Buffer.alloc(32)); return sustainableRecoveryWorkUsage()!; });
  expect(imageWrites.mechanisms['disk-read']).toBe(64); expect(imageWrites.categories.L).toBeGreaterThanOrEqual(64); a.close();
  const value = await node(first, 'witness-1', generateSigningKeyPair()), id = await value.storage.put(Buffer.from('metered')), identity = identityFor(value, id), enrollment = createRso5RecipientEnrollment({ material: value.recipientKey, signingKey: value.signingKey, role: 'witness', genesis: binding.genesis, context: binding.context });
  const exported = await withSustainableRecoveryWork(4718592, async () => { await value.storage.exportBundle([id], rso5Digest(Buffer.from('metered export')), enrollment); return sustainableRecoveryWorkUsage()!; });
  expect(exported.mechanisms.base64).toBeGreaterThan(0);
  const writes = await withSustainableRecoveryWork(4718592, async () => { await value.storage.put(Buffer.from('second metered proof')); await value.storage.write(Buffer.from('first journal')); await value.storage.write(Buffer.from('second journal')); return sustainableRecoveryWorkUsage()!; });
  expect(writes.mechanisms.allocate).toBeGreaterThanOrEqual(256); expect(writes.categories.L).toBeGreaterThan(0); expect(writes.mechanisms['disk-read']).toBeGreaterThan(0);
  value.storage.close(); writeFileSync(join(first.manifest.root, 'witness-1', 'local', 'frames.bin'), Buffer.alloc(0)); await reopen(value);
  const recovered = await withSustainableRecoveryWork(4718592, async () => { await value.storage.recoverProof(id, 'original', identity); return sustainableRecoveryWorkUsage()!; });
  expect(recovered.mechanisms.base64).toBeGreaterThan(0); expect(recovered.mechanisms.parse).toBeGreaterThan(0);
});

it('RSO5 diagnostic scope is explicitly unbounded and nested meters share it', () => {
  const usage = withDiagnosticUnboundedRecoveryWork(() => { withSustainableRecoveryWork(1, () => chargeSustainableRecoveryWork(4718593, 'V', 'copy')); return sustainableRecoveryWorkUsage()!; });
  expect(usage).toMatchObject({ usedBytes: 4718593, maximumBytes: null, diagnosticUnbounded: true });
  expect(() => withSustainableRecoveryWork(4718592, () => chargeSustainableRecoveryWork(4718593, 'V', 'copy'))).toThrow('work exhausted');
});
