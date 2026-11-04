import { randomBytes } from 'node:crypto';
import { sign, verify, type SigningKeyPair } from '@resonance/core';
import type { RecoveryProofKind } from './sustainable-recovery-manifest.js';
import type { SustainableRso5Arena } from './sustainable-rso5-arena.js';
import { createRso5Checkpoint, createRso5Delegation, createRso5Frame, createRso5RecipientEnrollment, openRso5Delegation, openRso5Frame, parseRso5Checkpoint, parseRso5Delegation, parseRso5Frame, rso5Digest, rso5ScopeId, RSO5_ZERO_HEAD, type Rso5CheckpointEntry, type Rso5Delegation, type Rso5FrameIdentity, type Rso5FrameMetadata, type Rso5OriginalBinding, type Rso5RecipientEnrollment, type Rso5RecipientKeyMaterial, type Rso5ScopeKeyEntry } from './sustainable-rso5-opaque.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryJson, sustainableRecoveryParse, withSustainableRecoveryWork, type RecoveryWorkCategory } from './sustainable-recovery-work.js';

const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
const json = (value: unknown) => sustainableRecoveryJson(value, 'V');
const parse = (value: string | Uint8Array) => sustainableRecoveryParse(value, 'V');
const fromBase64 = (value: string, category: RecoveryWorkCategory = 'V') => sustainableRecoveryBytes(value, 'base64url', category, 'base64');
function toBase64(value: Uint8Array, category: RecoveryWorkCategory = 'V') { const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url'); chargeSustainableRecoveryWork(Buffer.byteLength(text), category, 'base64'); return text; }
export interface Rso5StateRecord { scope: string; owner: string; revision: number; ciphertext: string; signature: string }
export interface Rso5TransferObject { id: string; frame: string; kind: RecoveryProofKind }
export interface Rso5TransferBundle { objects: Rso5TransferObject[]; delegation: string; checkpoints: string[] }
export interface Rso5ImportImages { stateBytes: number; pendingBytes: number; suffixBytes: number }
export interface Rso5PreparedProof { frame: Buffer; metadata: Rso5FrameMetadata; dek?: Buffer }
interface Request { action: string; scope: string; challenge: string; payload?: string; identity?: Rso5FrameIdentity; proposal?: string; exporter?: string; recipient?: string; head?: string; frames?: string[]; delegations?: string[]; checkpoints?: string[]; commitCheckpoints?: string[]; record?: Rso5StateRecord; commit?: boolean }
interface Reply { scope: string; challenge: string; replica: string; digest?: string; bytes?: number; payload?: string; record?: Rso5StateRecord | null; checkpointHead?: string; checkpointSequence?: number; signature: string }
function stateBytes(record: Rso5StateRecord) { return json([record.scope, record.owner, record.revision, record.ciphertext]); }
function recordBytes(record: Rso5StateRecord) { return json(record); }
function replyBytes(reply: Reply) { return sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:reply:v1\n', 'utf8', 'V'), json([reply.scope, reply.challenge, reply.replica, reply.digest ?? null, reply.bytes ?? null, reply.payload ?? null, reply.record ?? null, reply.checkpointHead ?? null, reply.checkpointSequence ?? null])], 'V'); }
function validState(record: Rso5StateRecord, scope: string, owner: string, publicKey: Uint8Array) {
  return record.scope === scope && record.owner === owner && Number.isSafeInteger(record.revision) && record.revision >= 0
    && verify(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:state:v1\n', 'utf8', 'V'), stateBytes(record)], 'V'), fromBase64(record.signature), publicKey);
}

export function createSustainableRso5Replica(options: { arena: SustainableRso5Arena; scope: string; owner: string; signingKey: SigningKeyPair }) {
  const replica = pub(options.signingKey), meter = <T>(work: () => T) => withSustainableRecoveryWork(options.arena.maximumWork, work);
  function current() { const image = options.arena.read('state'); return image ? parse(image.bytes) as Rso5StateRecord : null; }
  async function exchange(request: Request): Promise<Reply> {
    if (request.scope !== options.scope || !/^[A-Za-z0-9_-]{43}$/.test(request.challenge)) throw new Error('Wrong RSO5 replica scope/challenge');
    let digest: string | undefined, bytes: number | undefined, payload: string | undefined, record: Rso5StateRecord | null = null, checkpointHead: string | undefined, checkpointSequence: number | undefined;
    if (request.action === 'preflight') {
      options.arena.preflight({ frames: (request.frames ?? []).map(value => fromBase64(value)),
        delegations: (request.delegations ?? []).map(value => fromBase64(value)),
        checkpoints: (request.checkpoints ?? []).map(value => fromBase64(value)), commitCheckpoints: (request.commitCheckpoints ?? []).map(value => fromBase64(value)) });
    } else if (request.action === 'put-frame') {
      if (!request.payload || !request.identity) throw new Error('Missing RSO5 frame');
      const metadata = options.arena.appendFrame(fromBase64(request.payload));
      if (metadata.frameDigest !== request.identity.frameDigest) throw new Error('RSO5 frame identity differs'); digest = metadata.frameDigest; bytes = metadata.frameBytes;
    } else if (request.action === 'put-delegation') {
      if (!request.payload || !request.proposal || !request.exporter || !request.recipient) throw new Error('Missing RSO5 delegation');
      const delegation = options.arena.appendDelegation(fromBase64(request.payload)); digest = delegation.digest; bytes = delegation.bytes.length;
    } else if (request.action === 'prepare-checkpoint' || request.action === 'commit-checkpoint') {
      if (!request.payload) throw new Error('Missing RSO5 checkpoint');
      const checkpoint = request.action === 'prepare-checkpoint' ? options.arena.prepareCheckpoint(fromBase64(request.payload)) : options.arena.commitCheckpoint(fromBase64(request.payload));
      digest = checkpoint.head; bytes = checkpoint.bytes.length;
    } else if (request.action === 'status') {
      if (request.identity) { const status = options.arena.frameStatus(request.identity); digest = status.digest; bytes = status.bytes; }
      else if (request.proposal && request.exporter && request.recipient) { const status = options.arena.delegationStatus(request.proposal, request.exporter, request.recipient); digest = status.digest; bytes = status.bytes; }
      else if (request.head) { const status = options.arena.checkpointStatus(request.head); digest = status.digest; bytes = status.bytes; }
      else throw new Error('Missing RSO5 status identity');
    } else if (request.action === 'read-frame') {
      if (!request.identity) throw new Error('Missing RSO5 frame identity'); const frame = options.arena.getFrame(request.identity); digest = request.identity.frameDigest; bytes = frame.length;
      payload = toBase64(frame);
    } else if (request.action === 'read-delegation') {
      if (!request.proposal || !request.exporter || !request.recipient) throw new Error('Missing RSO5 delegation identity');
      const delegation = options.arena.getDelegation(request.proposal, request.exporter, request.recipient); digest = rso5Digest(delegation); bytes = delegation.length;
      payload = toBase64(delegation);
    } else if (request.action === 'read-checkpoint') {
      if (!request.head) throw new Error('Missing RSO5 checkpoint identity'); const checkpoint = options.arena.getCheckpoint(request.head); digest = checkpoint.head; bytes = checkpoint.bytes.length;
      payload = toBase64(checkpoint.bytes);
    } else if (request.action === 'list-delegations' || request.action === 'list-checkpoints') {
      const values = request.action === 'list-delegations' ? options.arena.listDelegations().map(delegation => delegation.bytes) : options.arena.checkpointLog().map(checkpoint => checkpoint.bytes);
      const encoded = json(values.map(value => toBase64(value))); digest = rso5Digest(encoded); bytes = encoded.length; payload = encoded.toString('utf8'); chargeSustainableRecoveryWork(encoded.length, 'V', 'serialize');
    } else if (request.action === 'state') {
      if (!request.record || !validState(request.record, options.scope, options.owner, fromBase64(options.owner))) throw new Error('Unauthenticated RSO5 state');
      const previous = current();
      if (previous && recordBytes(previous).equals(recordBytes(request.record))) record = previous;
      else {
        if (previous && request.record.revision <= previous.revision) throw new Error(previous && request.record.revision === previous.revision ? 'RSO5 same-revision state conflict' : 'RSO5 state revision regresses');
        options.arena.write('state', recordBytes(request.record)); record = current();
      }
    } else if (request.action === 'head') {
      record = current(); const checkpoint = options.arena.currentHead(); checkpointHead = checkpoint.head; checkpointSequence = checkpoint.sequence;
    } else throw new Error('Unknown RSO5 replica action');
    const reply: Reply = { scope: options.scope, challenge: request.challenge, replica, ...(digest ? { digest } : {}), ...(bytes !== undefined ? { bytes } : {}), ...(payload ? { payload } : {}), record, ...(checkpointHead ? { checkpointHead, checkpointSequence } : {}), signature: '' };
    reply.signature = toBase64(sign(replyBytes(reply), options.signingKey.secretKey)); return reply;
  }
  return { replica, exchange: (request: Request) => meter(() => exchange(request)) };
}
export type Rso5Transport = (replica: string, request: Request) => Promise<Reply>;

export function openSustainableRso5ProtectedArena(options: {
  arena: SustainableRso5Arena; scope: string; signingKey: SigningKeyPair; recipientKey: Rso5RecipientKeyMaterial;
  replicas: string[]; transport: Rso5Transport; role?: string;
}) {
  const owner = pub(options.signingKey), role = options.role ?? 'witness', meter = <T>(work: () => T) => withSustainableRecoveryWork(options.arena.maximumWork, work);
  if (options.replicas.length !== 5 || new Set(options.replicas).size !== 5 || !/^sha256:[a-f0-9]{64}$/.test(options.scope)) throw new Error('RSO5 requires five replicas');
  let original: Rso5OriginalBinding | undefined, closed = false, ready = false;
  const scopeKeys = new Map<string, Map<number, Buffer>>(), currentVersions = new Map<string, number>();
  function live() { if (closed) throw new Error('RSO5 protected arena closed'); }
  function binding() { if (!original) throw new Error('RSO5 original binding is not configured'); return original; }
  function enrollmentFor(value = binding()) { return createRso5RecipientEnrollment({ material: options.recipientKey, signingKey: options.signingKey, role, genesis: value.genesis, context: value.context }); }
  function putScopeKey(entry: Rso5ScopeKeyEntry) {
    const versions = scopeKeys.get(entry.scopeId) ?? new Map<number, Buffer>(); if (versions.has(entry.scopeKeyVersion)) return;
    const key = sustainableRecoveryBytes(entry.scopeKey, undefined, 'V'); versions.set(entry.scopeKeyVersion, key); scopeKeys.set(entry.scopeId, versions); currentVersions.set(entry.scopeId, entry.scopeKeyVersion);
  }
  async function loadPrivate() {
    if (!original) return;
    for (const delegation of options.arena.listDelegations()) {
      if (delegation.recipient !== owner) continue;
      const entries = await openRso5Delegation({ delegation: delegation.bytes, material: options.recipientKey, enrollment: enrollmentFor() }); for (const entry of entries) putScopeKey(entry);
    }
  }
  async function exchange(action: string, value?: { payload?: Buffer; identity?: Rso5FrameIdentity; proposal?: string; exporter?: string; recipient?: string; head?: string; record?: Rso5StateRecord; frames?: Buffer[]; delegations?: Buffer[]; checkpoints?: Buffer[]; commitCheckpoints?: Buffer[]; commit?: boolean }, required = 4) {
    live(); const challenge = toBase64(randomBytes(32)), payload = value?.payload ? toBase64(value.payload) : undefined;
    const request: Request = { action, scope: options.scope, challenge, ...(payload ? { payload } : {}), ...(value?.identity ? { identity: value.identity } : {}),
      ...(value?.proposal ? { proposal: value.proposal } : {}), ...(value?.exporter ? { exporter: value.exporter } : {}), ...(value?.recipient ? { recipient: value.recipient } : {}),
      ...(value?.head ? { head: value.head } : {}), ...(value?.record ? { record: value.record } : {}),
      ...(value?.frames ? { frames: value.frames.map(frame => toBase64(frame)) } : {}),
      ...(value?.delegations ? { delegations: value.delegations.map(delegation => toBase64(delegation)) } : {}),
      ...(value?.checkpoints ? { checkpoints: value.checkpoints.map(checkpoint => toBase64(checkpoint)) } : {}),
      ...(value?.commitCheckpoints ? { commitCheckpoints: value.commitCheckpoints.map(checkpoint => toBase64(checkpoint)) } : {}), ...(value?.commit ? { commit: true } : {}) };
    const responses = await Promise.allSettled(options.replicas.map(async replica => {
      const reply = await options.transport(replica, request); live();
      if (reply.scope !== options.scope || reply.challenge !== challenge || reply.replica !== replica || !verify(replyBytes(reply), fromBase64(reply.signature), fromBase64(replica))) throw new Error('Unauthenticated RSO5 acknowledgment');
      if (value?.identity && action !== 'read-frame' && reply.digest !== value.identity.frameDigest || value?.head && reply.digest !== value.head || value?.payload && !reply.digest) throw new Error('RSO5 acknowledgment digest differs');
      if (value?.record && (!reply.record || !validState(reply.record, options.scope, owner, options.signingKey.publicKey) || !recordBytes(reply.record).equals(recordBytes(value.record)))) throw new Error('RSO5 state acknowledgment differs'); return reply;
    }));
    const replies = responses.flatMap(response => response.status === 'fulfilled' ? [response.value] : []);
    if (replies.length < required) throw new Error(`${required} RSO5 acknowledgments unavailable: ${[...new Set(responses.flatMap(response => response.status === 'rejected' ? [response.reason instanceof Error ? response.reason.message : String(response.reason)] : []))].join('; ')}`); return replies;
  }
  async function appendDelegation(delegation: Rso5Delegation) {
    options.arena.appendDelegation(delegation.bytes);
    await exchange('put-delegation', { payload: delegation.bytes, proposal: delegation.proposal, exporter: delegation.exporter, recipient: delegation.recipient }); return delegation;
  }
  async function ensureInitial() {
    const originalBinding = binding(), scopeId = rso5ScopeId(originalBinding, owner);
    if (scopeKeys.has(scopeId)) return { scopeId, version: currentVersions.get(scopeId)!, key: scopeKeys.get(scopeId)!.get(currentVersions.get(scopeId)!)! };
    const scopeKey = randomBytes(32), version = 0, enrollment = enrollmentFor(originalBinding), proposal = rso5Digest(sustainableRecoveryBytes(`resonance:rso5:initial:${scopeId}`, 'utf8', 'V'));
    const delegation = await createRso5Delegation({ proposal, exporter: options.signingKey, enrollment, entries: [{ scopeId, scopeKeyVersion: version, scopeKey }] });
    putScopeKey({ scopeId, scopeKeyVersion: version, scopeKey }); await appendDelegation(delegation);
    return { scopeId, version, key: scopeKey };
  }
  async function prepareProof(bytes: Uint8Array, kind: RecoveryProofKind): Promise<Rso5PreparedProof> {
    const { scopeId, version, key } = await ensureInitial();
    try {
      const existing = options.arena.references([rso5Digest(bytes)])[0];
      if (existing.scopeId === scopeId) return { frame: options.arena.getFrame(existing), metadata: { ...existing, originalOwner: owner, scopeKeyVersion: version } };
    } catch { /* No retained exact proof. */ }
    const created = createRso5Frame({ plaintext: bytes, kind, original: binding(), scopeKeyVersion: version, scopeKey: key, signingKey: options.signingKey });
    return { frame: created.frame, metadata: created.metadata, dek: created.dek };
  }
  async function appendPrepared(prepared: Rso5PreparedProof) {
    options.arena.preflight({ frames: [prepared.frame] }); options.arena.appendFrame(prepared.frame);
    await exchange('put-frame', { payload: prepared.frame, identity: prepared.metadata }); prepared.dek?.fill(0); prepared.dek = undefined; return prepared.metadata;
  }
  async function publishCheckpoint(entries: Rso5CheckpointEntry[], configuration = binding().configuration) {
    const covered = new Set(options.arena.checkpointLog().flatMap(checkpoint => checkpoint.entries.map(entry => `${entry.scopeId}:${entry.proofId}:${entry.frameDigest}`)));
    const incremental = entries.filter(entry => !covered.has(`${entry.scopeId}:${entry.proofId}:${entry.frameDigest}`));
    const current = options.arena.currentHead(), checkpoint = createRso5Checkpoint({ sequence: current.sequence + 1, previousHead: current.head, configuration, entries: incremental, signingKey: options.signingKey });
    options.arena.preflight({ checkpoints: [checkpoint.bytes], commitCheckpoints: [checkpoint.bytes] }); options.arena.prepareCheckpoint(checkpoint.bytes);
    await exchange('prepare-checkpoint', { payload: checkpoint.bytes, head: checkpoint.head });
    await exchange('commit-checkpoint', { payload: checkpoint.bytes, head: checkpoint.head, commit: true });
    options.arena.commitCheckpoint(checkpoint.bytes); return checkpoint;
  }
  function localPlaintext(id: string, kind?: RecoveryProofKind): Buffer {
    const identity = options.arena.references([id])[0], frame = options.arena.getFrame(identity), metadata = parseRso5Frame(frame);
    if (kind && metadata.kind !== kind) throw new Error('RSO5 proof kind differs');
    const entry = scopeKeys.get(metadata.scopeId)?.get(metadata.scopeKeyVersion); if (!entry) throw new Error('RSO5 scope key version unavailable');
    return openRso5Frame({ frame, scopeId: metadata.scopeId, scopeKeyVersion: metadata.scopeKeyVersion, scopeKey: entry });
  }
  function exactFrame(frame: Buffer, identity: Rso5FrameIdentity, id: string, kind?: RecoveryProofKind) {
    const metadata = parseRso5Frame(frame);
    if (identity.proofId !== id || metadata.scopeId !== identity.scopeId || metadata.proofId !== id || metadata.kind !== identity.kind || metadata.frameDigest !== identity.frameDigest || metadata.frameBytes !== identity.frameBytes
      || frame.length !== identity.frameBytes || rso5Digest(frame) !== identity.frameDigest || kind && metadata.kind !== kind) throw new Error('RSO5 recovered frame identity differs');
    return metadata;
  }
  async function recoverProof(id: string, kind?: RecoveryProofKind, supplied?: Rso5FrameIdentity): Promise<Buffer> {
    const identity = supplied ?? options.arena.references([id])[0]; if (identity.proofId !== id || kind && identity.kind !== kind) throw new Error('RSO5 requested proof identity differs');
    let frame: Buffer;
    try { frame = options.arena.getFrame(identity); exactFrame(frame, identity, id, kind); }
    catch {
      const replies = await exchange('read-frame', { identity }, 4), groups = new Map<string, Buffer[]>();
      for (const reply of replies) {
        if (!reply.payload) continue;
        try { const candidate = fromBase64(reply.payload); exactFrame(candidate, identity, id, kind); const group = groups.get(rso5Digest(candidate)) ?? []; group.push(candidate); groups.set(rso5Digest(candidate), group); }
        catch { /* Byzantine or malformed candidates never enter the local arena. */ }
      }
      const matching = groups.get(identity.frameDigest); if (!matching || matching.length < 4) throw new Error('Four exact RSO5 recovery frames unavailable');
      frame = matching[0]; options.arena.appendFrame(frame);
    }
    const metadata = exactFrame(frame, identity, id, kind);
    const delegation = await currentDelegation(metadata.scopeId, metadata.scopeKeyVersion), entries = await openRso5Delegation({ delegation: delegation.bytes, material: options.recipientKey, enrollment: enrollmentFor() });
    const entry = entries.find(item => item.scopeId === metadata.scopeId && item.scopeKeyVersion === metadata.scopeKeyVersion);
    if (!entry) throw new Error('RSO5 scope key version unavailable'); putScopeKey(entry);
    return openRso5Frame({ frame, scopeId: metadata.scopeId, scopeKeyVersion: metadata.scopeKeyVersion, scopeKey: entry.scopeKey });
  }
  async function remoteList(action: 'list-delegations' | 'list-checkpoints') {
    const replies = await exchange(action, undefined, 4), groups = new Map<string, { payload: string; count: number }>();
    for (const reply of replies) {
      if (!reply.payload) continue; const bytes = sustainableRecoveryBytes(reply.payload, 'utf8', 'V'), digest = rso5Digest(bytes); if (reply.digest !== digest) continue;
      const group = groups.get(digest) ?? { payload: reply.payload, count: 0 }; group.count++; groups.set(digest, group);
    }
    const selected = [...groups.values()].find(group => group.count >= 4); if (!selected) throw new Error(`Four matching RSO5 ${action} replies unavailable`);
    const values = parse(selected.payload); if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('Invalid RSO5 remote list'); return values as string[];
  }
  async function remoteDelegations(): Promise<Rso5Delegation[]> {
    const values = await remoteList('list-delegations'); return values.map(value => parseRso5Delegation(fromBase64(value)));
  }
  async function currentDelegation(scopeId: string, version: number) {
    const local = options.arena.listDelegations(), candidates = local.length ? local : await remoteDelegations();
    for (const delegation of candidates.filter(delegation => delegation.recipient === owner).reverse()) {
      const entries = await openRso5Delegation({ delegation: delegation.bytes, material: options.recipientKey, enrollment: enrollmentFor() });
      if (entries.some(entry => entry.scopeId === scopeId && entry.scopeKeyVersion === version)) return delegation;
    }
    throw new Error('RSO5 delegation unavailable');
  }
  async function appendCheckpointChain(values: Buffer[], replicate: boolean) {
    const checkpoints = values.map(value => parseRso5Checkpoint(value)).sort((a, b) => a.sequence - b.sequence), initial = options.arena.currentHead();
    for (const checkpoint of checkpoints) {
      const current = options.arena.currentHead(); if (checkpoint.sequence <= current.sequence) continue;
      if (checkpoint.sequence !== current.sequence + 1 || checkpoint.previousHead !== current.head) { if (initial.sequence >= 0) break; throw new Error('RSO5 checkpoint branch does not extend cold recovery floor'); }
      options.arena.prepareCheckpoint(checkpoint.bytes);
      if (replicate) await exchange('prepare-checkpoint', { payload: checkpoint.bytes, head: checkpoint.head });
      if (replicate) await exchange('commit-checkpoint', { payload: checkpoint.bytes, head: checkpoint.head, commit: true });
      options.arena.commitCheckpoint(checkpoint.bytes);
    }
  }
  async function reconcileRemoteCheckpoints(selectedHead: string, selectedSequence: number) {
    const local = options.arena.currentHead();
    if (local.sequence > selectedSequence || local.sequence === selectedSequence && local.head !== selectedHead) throw new Error('RSO5 local checkpoint floor conflicts with completed replicas');
    if (local.sequence === selectedSequence) return;
    const values = (await remoteList('list-checkpoints')).map(value => fromBase64(value));
    options.arena.preflight({ checkpoints: values, commitCheckpoints: values }); await appendCheckpointChain(values, false);
    const current = options.arena.currentHead(); if (current.head !== selectedHead || current.sequence !== selectedSequence) throw new Error('RSO5 recovered checkpoint floor differs');
  }
  return {
    arena: options.arena, owner, scope: options.scope,
    configureOriginal(value: Rso5OriginalBinding) { original = { ...value }; },
    recipientEnrollment(genesis: string, context: string) { return createRso5RecipientEnrollment({ material: options.recipientKey, signingKey: options.signingKey, role, genesis, context }); },
    async startup(reconcileCheckpoints = true) { return meter(async () => {
      live(); await loadPrivate(); const replies = await exchange('head', undefined, 4), records = new Map<string, { record: Rso5StateRecord; count: number }>(), revisions = new Map<number, string>(), floors = new Map<string, { head: string; sequence: number; count: number }>();
      for (const reply of replies) {
        if (reply.record) {
          if (!validState(reply.record, options.scope, owner, options.signingKey.publicKey)) throw new Error('Unauthenticated RSO5 startup state');
          const encoded = toBase64(recordBytes(reply.record));
          const prior = revisions.get(reply.record.revision); if (prior && prior !== encoded) throw new Error('RSO5 same-revision startup state conflict'); revisions.set(reply.record.revision, encoded);
          const group = records.get(encoded) ?? { record: reply.record, count: 0 }; group.count++; records.set(encoded, group);
        }
        if (reply.checkpointHead === undefined || reply.checkpointSequence === undefined) throw new Error('Missing RSO5 startup checkpoint floor');
        const key = `${reply.checkpointSequence}:${reply.checkpointHead}`, group = floors.get(key) ?? { head: reply.checkpointHead, sequence: reply.checkpointSequence, count: 0 }; group.count++; floors.set(key, group);
      }
      for (const floor of floors.values()) if ([...floors.values()].some(other => other.sequence === floor.sequence && other.head !== floor.head)) throw new Error('RSO5 startup checkpoint fork');
      const selected = [...records.values()].filter(group => group.count >= 4).sort((a, b) => b.record.revision - a.record.revision)[0]?.record;
      const floor = [...floors.values()].filter(group => group.count >= 4).sort((a, b) => b.sequence - a.sequence)[0]; if (!floor) throw new Error('Four matching RSO5 checkpoint floors unavailable');
      const previous = options.arena.read('state'), previousRecord = previous ? parse(previous.bytes) as Rso5StateRecord : undefined;
      if (previousRecord && (!validState(previousRecord, options.scope, owner, options.signingKey.publicKey) || !selected || previousRecord.revision > selected.revision)) throw new Error('RSO5 local state lacks four completed copies');
      if (previousRecord && selected && previousRecord.revision === selected.revision && !recordBytes(previousRecord).equals(recordBytes(selected))) throw new Error('RSO5 same-revision local startup conflict');
      if (selected && (!previous || !previous.bytes.equals(recordBytes(selected)))) options.arena.write('state', recordBytes(selected));
      if (reconcileCheckpoints) await reconcileRemoteCheckpoints(floor.head, floor.sequence); ready = true; return selected ? options.arena.unseal(fromBase64(selected.ciphertext, 'L')) : undefined;
    }); },
    preflight: (items: Array<{ bytes: Uint8Array; kind: RecoveryProofKind }>, stateBytes = 0) => meter(async () => {
      const prepared: Rso5PreparedProof[] = []; for (const item of items) prepared.push(await prepareProof(item.bytes, item.kind));
      options.arena.preflight({ frames: prepared.map(item => item.frame) }); options.arena.assertImageSize('state', stateBytes);
      await exchange('preflight', { frames: prepared.map(item => item.frame) }); return prepared;
    }),
    put: (bytes: Uint8Array, kind: RecoveryProofKind = 'original', prepared?: Rso5PreparedProof) => meter(async () => {
      const current = prepared ?? await prepareProof(bytes, kind); if (current.metadata.proofId !== rso5Digest(bytes)) throw new Error('RSO5 prepared plaintext differs'); return (await appendPrepared(current)).proofId;
    }),
    publishCheckpoint: (entries: Rso5CheckpointEntry[], configuration?: string) => meter(() => publishCheckpoint(entries, configuration)),
    references: (ids: string[]) => options.arena.references(ids),
    get: (id: string, kind?: RecoveryProofKind) => meter(() => localPlaintext(id, kind)),
    recoverProof: (id: string, kind?: RecoveryProofKind, identity?: Rso5FrameIdentity) => meter(() => recoverProof(id, kind, identity)),
    recoverSelected: (ids: string[], identities?: Map<string, Rso5FrameIdentity>) => meter(async () => { const result = new Map<string, Buffer>(); for (const id of ids) result.set(id, await recoverProof(id, undefined, identities?.get(id))); return result; }),
    async rotateScope() { return meter(async () => {
      const { scopeId, version, key: oldKey } = await ensureInitial(), scopeKey = randomBytes(32), next = version + 1;
      const enrollment = enrollmentFor(), proposal = rso5Digest(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:rotation:v1\n', 'utf8', 'V'), sustainableRecoveryBytes(scopeId), sustainableRecoveryBytes(Uint8Array.of(next))], 'V'));
      const delegation = await createRso5Delegation({ proposal, exporter: options.signingKey, enrollment, entries: [{ scopeId, scopeKeyVersion: version, scopeKey: oldKey }, { scopeId, scopeKeyVersion: next, scopeKey }] });
      putScopeKey({ scopeId, scopeKeyVersion: next, scopeKey }); await appendDelegation(delegation); return next;
    }); },
    async exportBundle(ids: string[], proposal: string, enrollment: Rso5RecipientEnrollment) { return meter(async () => {
      const entries: Rso5ScopeKeyEntry[] = []; for (const [scopeId, versions] of scopeKeys) for (const [scopeKeyVersion, scopeKey] of versions) entries.push({ scopeId, scopeKeyVersion, scopeKey });
      const delegation = await createRso5Delegation({ proposal, exporter: options.signingKey, enrollment, entries });
      const objects = ids.map(id => { const identity = options.arena.references([id])[0], frame = options.arena.getFrame(identity); return { id, frame: toBase64(frame), kind: identity.kind }; });
      const checkpoints = options.arena.checkpointLog().map(checkpoint => toBase64(checkpoint.bytes));
      return { objects, delegation: toBase64(delegation.bytes), checkpoints } satisfies Rso5TransferBundle;
    }); },
    discardPrepared(prepared: Rso5PreparedProof) { prepared.dek?.fill(0); prepared.dek = undefined; },
    async prepareTransfer(object: Rso5TransferObject, delegationBytes: Uint8Array) { return meter(async () => {
      const frame = fromBase64(object.frame), metadata = parseRso5Frame(frame);
      if (metadata.proofId !== object.id || metadata.kind !== object.kind) throw new Error('RSO5 transferred proof identity differs');
      const delegation = parseRso5Delegation(delegationBytes), entries = await openRso5Delegation({ delegation: delegationBytes, material: options.recipientKey, enrollment: enrollmentFor() });
      const entry = entries.find(item => item.scopeId === metadata.scopeId && item.scopeKeyVersion === metadata.scopeKeyVersion);
      if (!entry) throw new Error('RSO5 transferred scope key unavailable');
      return openRso5Frame({ frame, scopeId: metadata.scopeId, scopeKeyVersion: metadata.scopeKeyVersion, scopeKey: entry.scopeKey });
    }); },
    async importBundle(bundle: Rso5TransferBundle, enrollment: Rso5RecipientEnrollment, images: Rso5ImportImages) { return meter(async () => {
      if (![images.stateBytes, images.pendingBytes, images.suffixBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid RSO5 import image preflight');
      const delegationBytes = fromBase64(bundle.delegation), delegation = parseRso5Delegation(delegationBytes);
      if (delegation.recipient !== owner || delegation.wrappingKeyId !== enrollment.keyId) throw new Error('Unauthorized RSO5 import recipient');
      const entries = await openRso5Delegation({ delegation: delegationBytes, material: options.recipientKey, enrollment });
      const missing: Buffer[] = [], incoming = new Map<string, Rso5FrameMetadata>(), retained = new Set(options.arena.ids());
      for (const object of bundle.objects) {
        const frame = fromBase64(object.frame), metadata = parseRso5Frame(frame);
        if (metadata.proofId !== object.id || metadata.kind !== object.kind || metadata.frameBytes !== frame.length || rso5Digest(frame) !== metadata.frameDigest) throw new Error('RSO5 import frame identity differs');
        if (retained.has(object.id)) continue;
        incoming.set(`${metadata.scopeId}:${metadata.proofId}`, metadata); missing.push(frame);
      }
      const checkpoints = bundle.checkpoints.map(value => fromBase64(value)), parsed = checkpoints.map(value => parseRso5Checkpoint(value)).sort((a, b) => a.sequence - b.sequence), initial = options.arena.currentHead();
      let head = initial.head, sequence = initial.sequence;
      for (const checkpoint of parsed) {
        if (checkpoint.sequence <= initial.sequence) continue;
        if (checkpoint.sequence !== sequence + 1 || checkpoint.previousHead !== head) { if (initial.sequence >= 0) break; throw new Error('RSO5 import checkpoint chain differs'); }
        for (const entry of checkpoint.entries) {
          const candidate = incoming.get(`${entry.scopeId}:${entry.proofId}`);
          try { options.arena.frameStatus(entry); }
          catch { if (!candidate || candidate.frameDigest !== entry.frameDigest || candidate.frameBytes !== entry.frameBytes || candidate.kind !== entry.kind) throw new Error('RSO5 import checkpoint frame floor differs'); }
        }
        head = checkpoint.head; sequence = checkpoint.sequence;
      }
      options.arena.assertImageSize('state', images.stateBytes); options.arena.assertImageSize('pending', images.pendingBytes); options.arena.assertImageSize('suffix', images.suffixBytes);
      options.arena.preflight({ delegations: [delegationBytes], frames: missing, checkpoints, commitCheckpoints: checkpoints });
      await exchange('preflight', { delegations: [delegationBytes], frames: missing, checkpoints, commitCheckpoints: checkpoints });
      for (const entry of entries) putScopeKey(entry);
      await appendDelegation(delegation);
      for (const frame of missing) { const metadata = parseRso5Frame(frame); options.arena.appendFrame(frame); await exchange('put-frame', { payload: frame, identity: metadata }); }
      await appendCheckpointChain(checkpoints, true);
    }); },
    async write(bytes: Uint8Array) { return meter(async () => {
      const previous = options.arena.read('state'), ciphertextBytes = options.arena.seal(bytes), ciphertext = toBase64(ciphertextBytes, 'L');
      const record: Rso5StateRecord = { scope: options.scope, owner, revision: (previous ? (parse(previous.bytes) as Rso5StateRecord).revision + 1 : 0), ciphertext, signature: '' };
      record.signature = toBase64(sign(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:state:v1\n', 'utf8', 'V'), stateBytes(record)], 'V'), options.signingKey.secretKey));
      options.arena.write('state', recordBytes(record)); await exchange('state', { record }); ready = true;
    }); },
    read() { return meter(() => { const image = options.arena.read('state'); return image ? options.arena.unseal(fromBase64((parse(image.bytes) as Rso5StateRecord).ciphertext, 'L')) : undefined; }); },
    assertJournalFloor(ids: string[], authorizedSigners: ReadonlyMap<string, readonly string[]>) { return meter(() => {
      const checkpoints = options.arena.checkpointLog(), covered = new Set<string>();
      for (const checkpoint of checkpoints) {
        const allowed = authorizedSigners.get(checkpoint.configuration); if (!allowed?.includes(checkpoint.signer)) throw new Error('Unauthorized RSO5 journal checkpoint signer for executed configuration');
        for (const entry of checkpoint.entries) covered.add(`${entry.scopeId}:${entry.proofId}:${entry.frameDigest}`);
      }
      for (const identity of options.arena.references(ids)) if (!covered.has(`${identity.scopeId}:${identity.proofId}:${identity.frameDigest}`)) throw new Error('RSO5 journal exceeds completed checkpoint floor');
    }); },
    assertReady() { if (!ready) throw new Error('RSO5 protected endpoint is not ready'); },
    close() { closed = true; for (const versions of scopeKeys.values()) for (const key of versions.values()) key.fill(0); options.arena.close(); },
  };
}
export type SustainableRso5ProtectedArena = ReturnType<typeof openSustainableRso5ProtectedArena>;
export const recoveryDigest = rso5Digest;
export type PreparedOpaqueProof = Rso5PreparedProof;
export type RecoveryProofTransferObject = Rso5TransferObject;
export type RecoveryRecipientEnrollment = Rso5RecipientEnrollment;
export type RecoveryOriginalBinding = Rso5OriginalBinding;
export type SustainableProtectedArena = SustainableRso5ProtectedArena;
