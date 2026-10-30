/** Authenticated opaque replicas retain exact frames/capsules, never plaintext. */
import { randomBytes, createHash } from 'node:crypto';
import { sign, verify, type SigningKeyPair } from '@resonance/core';
import type { RecoveryProofKind } from './sustainable-recovery-manifest.js';
import type { SustainableRecoveryArena } from './sustainable-recovery-arena.js';
import { closeRecoveryPairValidationOperation, createRecoveryCapsule, createRecoveryRecipientEnrollment, decryptValidatedRecoveryPair, openValidatedRecoveryCapsule, prepareOpaqueRecoveryObject, recoveryInitialProposal, recoveryProofBaseScope, verifyRecoveryRecipientEnrollment, type OpaqueRecoveryCommitment, type RecoveryCapsule, type RecoveryOriginalBinding, type RecoveryPairIdentity, type RecoveryPairValidationOperation, type RecoveryProofPair, type RecoveryRecipientEnrollment, type RecoveryRecipientKeyMaterial, type ValidatedRecoveryPairView } from './sustainable-recovery-opaque.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryJson, sustainableRecoveryParse, withSustainableRecoveryWork } from './sustainable-recovery-work.js';
export { generateRecoveryRecipientKey } from './sustainable-recovery-opaque.js';

export const recoveryDigest = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
const json = (value: unknown) => sustainableRecoveryJson(value, 'V');
const parse = (bytes: Uint8Array) => sustainableRecoveryParse(bytes, 'V');
export interface OpaqueRecoveryRecord { version: 1; scope: string; owner: string; revision: number; ciphertext: string; signature: string }
interface PairValidation { view: ValidatedRecoveryPairView; operation: RecoveryPairValidationOperation }
export interface PreparedOpaqueProof extends RecoveryProofPair { dek?: Buffer; initial: boolean; opened?: boolean; validation?: PairValidation }
export interface RecoveryProofTransferObject { id: string; bytes: string; kind: RecoveryProofKind; pair: RecoveryProofPair }
export interface OpaqueRecoveryRequest {
  action: 'head' | 'write' | 'object' | 'object-read' | 'object-status' | 'preflight'; scope: string; challenge: string;
  record?: OpaqueRecoveryRecord; frame?: string; capsule?: string; commitment?: OpaqueRecoveryCommitment;
  capsuleDigest?: string; identity?: RecoveryPairIdentity;
  objects?: Array<{ commitment: OpaqueRecoveryCommitment; identity: RecoveryPairIdentity; frameBytes: number; capsuleBytes: number; initialKey: boolean }>; stateBytes?: number;
}
export interface OpaqueRecoveryReply {
  scope: string; challenge: string; replica: string; record: OpaqueRecoveryRecord | null; frame?: string; capsule?: string;
  commitment?: OpaqueRecoveryCommitment; capsuleDigest?: string; identity?: RecoveryPairIdentity;
  proof?: { digest: string; bytes: number; capsuleDigest: string; capsuleBytes: number; id: string; kind: RecoveryProofKind; proposal: string; exporter: string; recipient: string }; signature: string;
}
function recordBytes(record: OpaqueRecoveryRecord) { return json([record.version, record.scope, record.owner, record.revision, record.ciphertext]); }
function validRecord(record: OpaqueRecoveryRecord, scope: string, owner: string) {
  return !!record && Object.keys(record).sort().join(',') === 'ciphertext,owner,revision,scope,signature,version'
    && record.version === 1 && record.scope === scope && record.owner === owner && Number.isSafeInteger(record.revision) && record.revision >= 0
    && typeof record.ciphertext === 'string' && record.ciphertext.length < 1024 * 1024 && typeof record.signature === 'string'
    && sustainableRecoveryBytes(record.signature, 'base64url', 'V').length === 64
    && verify(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:recovery-opaque:v1\n', 'utf8', 'V'), recordBytes(record)], 'V'), sustainableRecoveryBytes(record.signature, 'base64url', 'V'), sustainableRecoveryBytes(owner, 'base64url', 'V'));
}
function replyBytes(reply: OpaqueRecoveryReply) { return sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:recovery-opaque-reply:v3\n', 'utf8', 'V'), json([reply.scope, reply.challenge, reply.replica, reply.record, reply.frame ?? null, reply.capsule ?? null, reply.commitment ?? null, reply.capsuleDigest ?? null, reply.identity ?? null, reply.proof ?? null])], 'V'); }
function stateRecordMaximum(scope: string, owner: string, bytes: number) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 * 1024) throw new Error('Unknown bounded state image'); return json({ version: 1, scope, owner, revision: Number.MAX_SAFE_INTEGER, ciphertext: 'x'.repeat(Math.ceil((bytes + 28) * 4 / 3)), signature: 'x'.repeat(86) }).length; }
function requestPair(request: OpaqueRecoveryRequest): RecoveryProofPair {
  if (!request.frame || !request.capsule || !request.commitment || !request.capsuleDigest || !request.identity) throw new Error('Unauthenticated recovery pair');
  const frame = sustainableRecoveryBytes(request.frame, 'base64url', 'V'), capsuleBytes = sustainableRecoveryBytes(request.capsule, 'base64url', 'V');
  const capsule = parse(capsuleBytes) as RecoveryCapsule;
  if (request.capsuleDigest !== request.identity.capsuleDigest) throw new Error('Recovery pair digest identity differs');
  return { frame, commitment: request.commitment, capsule, capsuleBytes, capsuleDigest: request.capsuleDigest, identity: request.identity };
}
export function createSustainableRecoveryReplica(options: { arena: SustainableRecoveryArena; scope: string; owner: string; signingKey: SigningKeyPair }) {
  const replica = pub(options.signingKey), meter = <T>(work: () => T) => withSustainableRecoveryWork(options.arena.maximumWork, work);
  function current() { const image = options.arena.read(); return image ? parse(image.bytes) as OpaqueRecoveryRecord : null; }
  meter(() => { options.arena.recover(); const initial = current(); if (initial && !validRecord(initial, options.scope, options.owner)) throw new Error('Wrong opaque replica scope/authentication'); });
  async function exchange(request: OpaqueRecoveryRequest): Promise<OpaqueRecoveryReply> {
    const objectRead = request.action === 'object-read', objectStatus = request.action === 'object-status';
    if (request.scope !== options.scope || !/^[A-Za-z0-9_-]{43}$/.test(request.challenge)) throw new Error('Wrong opaque recovery scope/challenge');
    let record = request.action === 'object' || objectStatus ? null : current(), frame: string | undefined, capsule: string | undefined, commitment: OpaqueRecoveryCommitment | undefined, capsuleDigest: string | undefined, proof: OpaqueRecoveryReply['proof'];
    if (request.action === 'preflight') {
      if (!Array.isArray(request.objects) || request.objects.length > Object.values(options.arena.proofClosure).reduce((n, b) => n + b.count, 0) || !Number.isSafeInteger(request.stateBytes) || request.stateBytes! < 0) throw new Error('Unknown prospective physical closure');
      options.arena.preflightPairMetadata(request.objects); options.arena.assertImageSize('state', stateRecordMaximum(options.scope, options.owner, request.stateBytes!));
    } else if (request.action === 'object') {
      const pair = requestPair(request), identity = options.arena.putPair({ pair });
      proof = options.arena.pairStatus(identity); record = null;
    } else if (objectStatus || objectRead) {
      if (!request.identity) throw new Error('Missing exact pair request identity');
      proof = options.arena.pairStatus(request.identity); record = null;
      if (objectRead) {
        const pair = options.arena.getPair(request.identity); frame = pair.frame.toString('base64url'); capsule = pair.capsuleBytes.toString('base64url');
        chargeSustainableRecoveryWork(Buffer.byteLength(frame) + Buffer.byteLength(capsule), 'V', 'base64'); commitment = pair.commitment; capsuleDigest = pair.capsuleDigest;
      }
    } else if (request.action === 'write') {
      if (!request.record || !validRecord(request.record, options.scope, options.owner)) throw new Error('Unauthenticated opaque recovery record');
      if (record && (request.record.revision < record.revision || request.record.revision === record.revision && !recordBytes(record).equals(recordBytes(request.record)))) throw new Error('Opaque recovery record regresses or equivocates');
      if (!record || request.record.revision > record.revision) options.arena.write('state', json(request.record)); record = current();
    } else if (request.action !== 'head') throw new Error('Invalid opaque recovery action');
    const reply: OpaqueRecoveryReply = { scope: options.scope, challenge: request.challenge, replica, record,
      ...(frame ? { frame, capsule, commitment, capsuleDigest, identity: request.identity } : {}), ...(proof ? { proof } : {}), signature: '' };
    reply.signature = Buffer.from(sign(replyBytes(reply), options.signingKey.secretKey)).toString('base64url'); return reply;
  }
  return { replica, exchange: (request: OpaqueRecoveryRequest) => meter(() => exchange(request)) };
}
export type OpaqueRecoveryTransport = (replica: string, request: OpaqueRecoveryRequest) => Promise<OpaqueRecoveryReply>;

export function selectInitialRecoveryPair(options: {
  candidates: RecoveryProofPair[]; original: RecoveryOriginalBinding; owner: string;
  proofId: string; kind: RecoveryProofKind; enrollment: RecoveryRecipientEnrollment;
}): RecoveryProofPair | undefined {
  const enrollment = verifyRecoveryRecipientEnrollment(options.enrollment, { owner: options.owner, genesis: options.original.genesis, context: options.original.context });
  const scope = `${recoveryProofBaseScope(options.original, options.owner)}:object:${options.kind}:${options.proofId}`;
  const proposal = recoveryInitialProposal(options.original, options.owner);
  const candidates = options.candidates.filter(pair => pair.commitment.owner === options.owner
    && pair.commitment.scope === scope && pair.commitment.proofId === options.proofId && pair.commitment.proofKind === options.kind
    && pair.commitment.originalGenesis === options.original.genesis && pair.commitment.originalConfiguration === options.original.configuration
    && pair.commitment.originalContext === options.original.context && pair.capsule.originalOwner === options.owner
    && pair.capsule.exporter === options.owner && pair.capsule.proposal === proposal && pair.capsule.recipient === options.owner
    && pair.capsule.recipientRole === enrollment.role && pair.capsule.wrappingKeyId === enrollment.keyId
    && pair.identity.scope === scope && pair.identity.proposal === proposal && pair.identity.exporter === options.owner
    && pair.identity.recipient === options.owner && pair.identity.wrappingKeyId === enrollment.keyId);
  if (!candidates.length) return undefined;
  if (candidates.length !== 1 || new Set(candidates.map(pair => pair.identity.frameDigest)).size !== 1) throw new Error('Multiple eligible initial recovery pairs');
  const pair = candidates[0];
  if (pair.identity.frameDigest !== pair.commitment.frameDigest || pair.identity.capsuleDigest !== pair.capsuleDigest
    || pair.capsule.frameDigest !== pair.commitment.frameDigest) throw new Error('Ambiguous initial recovery pair identity');
  return pair;
}

export function openSustainableProtectedArena(options: {
  arena: SustainableRecoveryArena; scope: string; signingKey: SigningKeyPair; replicas: string[]; transport: OpaqueRecoveryTransport;
  recipientKey: RecoveryRecipientKeyMaterial; role?: string;
}) {
  const owner = pub(options.signingKey), role = options.role ?? 'witness', meter = <T>(work: () => T) => withSustainableRecoveryWork(options.arena.maximumWork, work);
  if (options.replicas.length !== 5 || new Set(options.replicas).size !== 5 || !/^sha256:[a-f0-9]{64}$/.test(options.scope)) throw new Error('Protected recovery requires five pinned opaque replicas');
  let active = false, ready = false, closed = false, original: RecoveryOriginalBinding | undefined;
  const local = () => { const image = options.arena.read(); const record = image ? parse(image.bytes) as OpaqueRecoveryRecord : undefined; if (record && !validRecord(record, options.scope, owner)) throw new Error('Local recovery scope/authentication differs'); return record; };
  function live() { if (closed) throw new Error('Protected recovery closed'); }
  function binding() { if (!original) throw new Error('Original recovery binding is not configured'); return original; }
  function enrollmentFor(value: RecoveryOriginalBinding) { return createRecoveryRecipientEnrollment({ material: options.recipientKey, signingKey: options.signingKey, role, genesis: value.genesis, context: value.context }); }
  function dispose(prepared: PreparedOpaqueProof) {
    prepared.dek?.fill(0); prepared.dek = undefined;
    if (prepared.validation) closeRecoveryPairValidationOperation(prepared.validation.operation);
    prepared.validation = undefined; prepared.opened = false;
  }
  async function exchange(action: OpaqueRecoveryRequest['action'], record?: OpaqueRecoveryRecord, prepared?: PreparedOpaqueProof[], stateBytes?: number, identity?: RecoveryPairIdentity, one?: RecoveryProofPair, required = 4) {
    live(); const challenge = randomBytes(32).toString('base64url'), oneFrame = one?.frame.toString('base64url'), oneCapsule = one?.capsuleBytes.toString('base64url');
    if (oneFrame || oneCapsule) chargeSustainableRecoveryWork(Buffer.byteLength(oneFrame ?? '') + Buffer.byteLength(oneCapsule ?? ''), 'V', 'base64');
    const objects = prepared?.map(item => ({ commitment: item.commitment, identity: item.identity, frameBytes: item.frame.length,
      capsuleBytes: item.capsuleBytes.length, initialKey: false }));
    const request: OpaqueRecoveryRequest = { action, scope: options.scope, challenge, ...(record ? { record } : {}), ...(identity ? { identity } : {}),
      ...(objects ? { objects, stateBytes } : {}),
      ...(one ? { commitment: one.commitment, frame: oneFrame, capsule: oneCapsule, capsuleDigest: one.capsuleDigest, identity: one.identity } : {}) };
    const responses = await Promise.allSettled(options.replicas.map(async replica => {
      const reply = await options.transport(replica, request); live();
      if (reply.scope !== options.scope || reply.challenge !== challenge || reply.replica !== replica
        || !verify(replyBytes(reply), sustainableRecoveryBytes(reply.signature, 'base64url', 'V'), sustainableRecoveryBytes(replica, 'base64url', 'V'))
        || reply.record && !validRecord(reply.record, options.scope, owner)) throw new Error('Unauthenticated opaque recovery acknowledgment');
      if (action === 'object') {
        const expected = identity!, proof = reply.proof;
        if (!proof || proof.digest !== expected.frameDigest || proof.capsuleDigest !== expected.capsuleDigest || proof.id !== expected.proofId
          || proof.kind !== expected.kind || proof.proposal !== expected.proposal || proof.exporter !== expected.exporter || proof.recipient !== expected.recipient || reply.frame) throw new Error('Opaque acknowledgment pair differs');
      } else if (action === 'object-read') {
        if (!reply.frame || !reply.capsule || !reply.commitment || !reply.capsuleDigest) throw new Error('Opaque acknowledgment lacks pair');
        const pair = requestPair(reply as unknown as OpaqueRecoveryRequest);
        if (JSON.stringify(pair.identity) !== JSON.stringify(identity)) throw new Error('Opaque recovery reply pair differs');
      } else if (action === 'object-status') {
        const proof = reply.proof;
        if (!proof || proof.id !== identity!.proofId || proof.kind !== identity!.kind || proof.digest !== identity!.frameDigest
          || proof.capsuleDigest !== identity!.capsuleDigest || proof.proposal !== identity!.proposal || proof.exporter !== identity!.exporter || proof.recipient !== identity!.recipient || reply.frame) throw new Error('Opaque status pair differs');
      } else if (reply.frame || reply.proof) throw new Error('Unexpected opaque acknowledgment proof');
      if (record && (!reply.record || !recordBytes(reply.record).equals(recordBytes(record)))) throw new Error('Opaque acknowledgment differs from selected endpoint'); return reply;
    }));
    const replies = responses.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    if (replies.length < required) throw new Error(`${required === 4 ? 'Four' : required === 1 ? 'One' : required} authenticated opaque recovery acknowledgments unavailable: ` + [...new Set(responses.flatMap(r => r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []))].join('; '));
    return replies;
  }
  async function complete(record: OpaqueRecoveryRecord) { await exchange('write', record); ready = true; }
  async function object(bytes: Uint8Array, kind: RecoveryProofKind): Promise<PreparedOpaqueProof> {
    const originalBinding = binding(), enrollment = enrollmentFor(originalBinding), proofId = recoveryDigest(bytes);
    const retained = selectInitialRecoveryPair({ candidates: options.arena.findProofPairs(proofId, kind), original: originalBinding,
      owner, proofId, kind, enrollment });
    if (retained) return { ...retained, initial: false };
    const prepared = prepareOpaqueRecoveryObject({ plaintext: bytes, kind, original: originalBinding, signingKey: options.signingKey });
    try {
      const proposal = recoveryInitialProposal(originalBinding, owner);
      const pair = await createRecoveryCapsule({ frame: prepared.frame, dek: prepared.dek, proposal, exporter: options.signingKey, enrollment });
      return { ...pair, dek: prepared.dek, initial: true };
    } catch (error) { prepared.dek.fill(0); throw error; }
  }
  async function recoverRemote(identity: RecoveryPairIdentity) {
    const statuses = await exchange('object-status', undefined, undefined, undefined, identity, undefined, 1), groups = new Map<string, number>();
    for (const reply of statuses) { const key = `${reply.proof!.digest}:${reply.proof!.capsuleDigest}`; groups.set(key, (groups.get(key) ?? 0) + 1); }
    if (Math.max(0, ...groups.values()) >= 4) { try { return { copies: 4, pair: options.arena.getPair(identity) }; } catch { /* Local loss requires an exact remote read. */ } }
    const replies = await exchange('object-read', undefined, undefined, undefined, identity, undefined, 1), pairs = new Map<string, { pair: RecoveryProofPair; copies: number }>();
    for (const reply of replies) {
      const pair = requestPair(reply as unknown as OpaqueRecoveryRequest), key = `${pair.identity.frameDigest}:${pair.identity.capsuleDigest}`, current = pairs.get(key);
      pairs.set(key, { pair, copies: (current?.copies ?? 0) + 1 });
    }
    const selected = [...pairs.values()].sort((a, b) => b.copies - a.copies)[0]; if (!selected) throw new Error('Opaque recovery reply lacks exact pair');
    return { copies: selected.copies, pair: selected.pair };
  }
  async function prepareTransfer(object: RecoveryProofTransferObject, proposal: string, exporter: string) {
    const bytes = sustainableRecoveryBytes(object.bytes, 'base64url', 'V');
    if (recoveryDigest(bytes) !== object.id || object.pair.commitment.proofId !== object.id || object.pair.commitment.proofKind !== object.kind) throw new Error('Transferred plaintext/proof identity differs');
    const validation = options.arena.validatePair(object.pair, true); let plaintext: Buffer | undefined, dek: Buffer | undefined;
    try {
      const enrollment = enrollmentFor({ genesis: object.pair.capsule.originalGenesis, configuration: object.pair.capsule.originalConfiguration, context: object.pair.capsule.originalContext });
      const opened = await openValidatedRecoveryCapsule(validation.view, validation.operation, { material: options.recipientKey, enrollment, proposal, exporter });
      plaintext = opened.plaintext; dek = opened.dek;
      if (!plaintext.equals(bytes)) throw new Error('Transferred plaintext differs from recipient frame');
      plaintext.fill(0); plaintext = undefined;
      const prepared: PreparedOpaqueProof = { ...object.pair, initial: false, opened: true, validation, dek };
      return { bytes, prepared };
    } catch (error) { plaintext?.fill(0); dek?.fill(0); closeRecoveryPairValidationOperation(validation.operation); throw error; }
  }
  return {
    arena: options.arena, owner, scope: options.scope,
    configureOriginal(value: RecoveryOriginalBinding) { original = { ...value }; },
    recipientEnrollment(genesis: string, context: string) { return enrollmentFor({ genesis, configuration: original?.configuration ?? genesis, context }); },
    async startup() { return meter(async () => {
      live(); if (active) throw new Error('Recovery operation in progress'); active = true; ready = false;
      try {
        options.arena.recover(); const before = local(), replies = await exchange('head'); let selected = before;
        for (const reply of replies) if (reply.record) { const candidate = reply.record; if (selected && candidate.revision === selected.revision && !recordBytes(candidate).equals(recordBytes(selected))) throw new Error('Equivocating selected protected endpoint'); if (!selected || candidate.revision > selected.revision) selected = candidate; }
        if (before && (!selected || selected.revision < before.revision)) throw new Error('Protected endpoint below durable floor');
        if (selected) { if (!before || !recordBytes(before).equals(recordBytes(selected))) options.arena.write('state', json(selected)); const matching = replies.filter(reply => reply.record && recordBytes(reply.record).equals(recordBytes(selected))); if (matching.length < 4) await complete(selected); ready = true; return options.arena.unseal(sustainableRecoveryBytes(selected.ciphertext, 'base64url', 'L')); }
        ready = true; return undefined;
      } finally { active = false; }
    }); },
    async preflight(items: Array<{ bytes: Uint8Array; kind: RecoveryProofKind; pair?: RecoveryProofPair; prepared?: PreparedOpaqueProof }>, stateBytes: number) { return meter(async () => {
      live(); const prepared: PreparedOpaqueProof[] = [];
      try {
        for (const item of items) prepared.push(item.prepared ?? (item.pair ? { ...item.pair, initial: false } : await object(item.bytes, item.kind)));
        options.arena.preflightPairs(prepared.map(item => ({ pair: item, initialKey: true })));
        options.arena.assertImageSize('state', stateRecordMaximum(options.scope, owner, stateBytes));
        await exchange('preflight', undefined, prepared, stateBytes); return prepared;
      } catch (error) { for (const item of prepared) dispose(item); throw error; }
    }); },
    async put(bytes: Uint8Array, kind: RecoveryProofKind = 'original', prepared?: PreparedOpaqueProof) { return meter(async () => {
      live(); const id = recoveryDigest(bytes); if (prepared && (prepared.commitment.proofId !== id || prepared.commitment.proofKind !== kind)) throw new Error('Prepared proof differs from original bytes');
      if (!prepared) {
        const retained = options.arena.findProofPairs(id, kind).filter(pair => pair.capsule.recipient === owner);
        if (retained.length) { if (new Set(retained.map(pair => pair.identity.frameDigest)).size !== 1) throw new Error('Conflicting retained proof frames'); prepared = { ...retained[0], initial: false }; }
      }
      const current = prepared ?? await object(bytes, kind), validation = current.validation ?? options.arena.validatePair(current, true);
      let dek = current.dek, plaintext: Buffer | undefined;
      try {
        if (!current.opened) {
          if (dek) plaintext = decryptValidatedRecoveryPair(validation.view, validation.operation, dek);
          else {
            const enrollment = enrollmentFor({ genesis: current.capsule.originalGenesis, configuration: current.capsule.originalConfiguration, context: current.capsule.originalContext });
            const opened = await openValidatedRecoveryCapsule(validation.view, validation.operation, { material: options.recipientKey, enrollment });
            plaintext = opened.plaintext; dek = opened.dek;
          }
          if (!plaintext.equals(sustainableRecoveryBytes(bytes, undefined, 'V'))) throw new Error('Transferred plaintext differs from recipient frame');
        }
        if (!dek) throw new Error('Missing validated local DEK');
        const identity = options.arena.putValidatedPair(validation.view, validation.operation, dek); let copies = 0;
        try { const statuses = await exchange('object-status', undefined, undefined, undefined, identity, undefined, 1); copies = statuses.filter(reply => reply.proof?.digest === identity.frameDigest && reply.proof.capsuleDigest === identity.capsuleDigest).length; } catch { copies = 0; }
        if (copies < 4) await exchange('object', undefined, undefined, undefined, identity, current);
      } finally { plaintext?.fill(0); dek?.fill(0); closeRecoveryPairValidationOperation(validation.operation); current.dek = undefined; current.validation = undefined; current.opened = false; }
      return id;
    }); },
    async exportProofs(ids: string[], proposal: string, recipient: RecoveryRecipientEnrollment) { return meter(async () => {
      live(); const verifiedRecipient = verifyRecoveryRecipientEnrollment(recipient, { genesis: recipient.genesis, context: recipient.context }), objects: RecoveryProofTransferObject[] = [];
      for (const id of ids) {
        const candidates = options.arena.findProofPairs(id).filter(pair => pair.capsule.recipient === owner);
        if (!candidates.length || new Set(candidates.map(pair => pair.identity.frameDigest)).size !== 1) throw new Error('Ambiguous or missing current-owner recovery capsule');
        const source = candidates[candidates.length - 1], validation = options.arena.validatePair(source, false); let plaintext: Buffer | undefined, dek: Buffer | undefined;
        try {
          const enrollment = enrollmentFor({ genesis: source.capsule.originalGenesis, configuration: source.capsule.originalConfiguration, context: source.capsule.originalContext });
          const opened = await openValidatedRecoveryCapsule(validation.view, validation.operation, { material: options.recipientKey, enrollment });
          plaintext = opened.plaintext; dek = opened.dek;
          if (recoveryDigest(plaintext) !== id) throw new Error('Exported plaintext proof identity differs');
          const pair = await createRecoveryCapsule({ frame: source.frame, dek, proposal, exporter: options.signingKey, enrollment: verifiedRecipient });
          const bytes = plaintext.toString('base64url'); chargeSustainableRecoveryWork(Buffer.byteLength(bytes), 'V', 'base64');
          objects.push({ id, bytes, kind: source.commitment.proofKind, pair });
        } finally { plaintext?.fill(0); dek?.fill(0); closeRecoveryPairValidationOperation(validation.operation); }
      }
      return objects;
    }); },
    async prepareTransfer(object: RecoveryProofTransferObject, proposal: string, exporter: string) { return meter(() => prepareTransfer(object, proposal, exporter)); },
    async validateTransfer(object: RecoveryProofTransferObject, proposal: string, exporter: string) { return meter(async () => {
      const { bytes, prepared } = await prepareTransfer(object, proposal, exporter); dispose(prepared); return bytes;
    }); },
    discardPrepared(prepared: PreparedOpaqueProof) { dispose(prepared); },
    async recoverProof(id: string, kind: RecoveryProofKind = 'original', identity?: RecoveryPairIdentity) { return meter(async () => {
      live(); try { return options.arena.get(id); } catch (error) { if (!(error instanceof Error && (error.message.includes('Missing exact original') || error.message.includes('Missing role-private DEK')))) throw error; }
      let exact = identity;
      if (!exact) {
        const pairs = options.arena.findProofPairs(id, kind).filter(pair => pair.capsule.recipient === owner);
        if (pairs.length !== 1) throw new Error('Exact recipient/proposal identity required for remote proof recovery');
        exact = pairs[0].identity;
      }
      const current = await recoverRemote(exact), validation = options.arena.validatePair(current.pair, true); let plaintext: Buffer | undefined, dek: Buffer | undefined, result: Buffer;
      try {
        const enrollment = enrollmentFor({ genesis: current.pair.capsule.originalGenesis, configuration: current.pair.capsule.originalConfiguration, context: current.pair.capsule.originalContext });
        const opened = await openValidatedRecoveryCapsule(validation.view, validation.operation, { material: options.recipientKey, enrollment });
        plaintext = opened.plaintext; dek = opened.dek;
        if (recoveryDigest(plaintext) !== id) throw new Error('Recovered plaintext proof identity differs');
        options.arena.putValidatedPair(validation.view, validation.operation, dek);
        result = sustainableRecoveryBytes(plaintext, undefined, 'V');
      } finally { plaintext?.fill(0); dek?.fill(0); closeRecoveryPairValidationOperation(validation.operation); }
      if (current.copies < 4) await exchange('object', undefined, undefined, undefined, exact, current.pair);
      return result!;
    }); },
    read() { return meter(() => { live(); const record = local(); return record ? options.arena.unseal(sustainableRecoveryBytes(record.ciphertext, 'base64url', 'L')) : undefined; }); },
    async write(bytes: Uint8Array) { return meter(async () => {
      live(); if (active) throw new Error('Recovery operation in progress'); active = true; ready = false;
      try {
        const previous = local(), ciphertext = options.arena.seal(bytes).toString('base64url'); chargeSustainableRecoveryWork(Buffer.byteLength(ciphertext), 'L', 'base64');
        const record: OpaqueRecoveryRecord = { version: 1, scope: options.scope, owner, revision: (previous?.revision ?? -1) + 1, ciphertext, signature: '' };
        record.signature = Buffer.from(sign(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:recovery-opaque:v1\n', 'utf8', 'V'), recordBytes(record)], 'V'), options.signingKey.secretKey)).toString('base64url');
        options.arena.write('state', json(record)); await complete(record);
      } finally { active = false; }
    }); },
    assertReady() { live(); if (!ready || active) throw new Error('Protected recovery requires fresh selected endpoint/completion'); },
    close() { closed = true; ready = false; options.arena.close(); },
  };
}
export type SustainableProtectedArena = ReturnType<typeof openSustainableProtectedArena>;
