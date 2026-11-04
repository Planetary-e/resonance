import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { sign, verify, type SigningKeyPair } from '@resonance/core';
import { SUSTAINABLE_RECOVERY_LIMITS, type RecoveryProofKind } from './sustainable-recovery-manifest.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryJson, sustainableRecoveryView, withSustainableRecoveryWork } from './sustainable-recovery-work.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const HEADER = 24;
const SIGNATURE = 64;
const DOMAIN = 'RSO3V001';
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const publicKey = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const kinds: RecoveryProofKind[] = ['original', 'frame', 'policy', 'activation'];

function encoded(value: Uint8Array): string {
  const text = Buffer.from(value).toString('base64url');
  chargeSustainableRecoveryWork(Buffer.byteLength(text), 'V', 'base64');
  return text;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function signedJson(domain: string, value: unknown): Buffer {
  return sustainableRecoveryConcat([sustainableRecoveryBytes(domain, 'utf8', 'V'), sustainableRecoveryJson(canonical(value), 'V')], 'V');
}
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }
function validKey(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
function validP256(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{87}$/.test(value); }
function validSignature(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value); }
function validCiphertext(value: unknown): value is string { return typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(value); }
function exactKeys(value: object, keys: string): boolean { return Object.keys(value).sort().join(',') === keys; }

export interface RecoveryOriginalBinding { genesis: string; configuration: string; context: string }
export interface RecoveryRecipientKeyMaterial { privateKey: CryptoKey; publicKey: string; keyId: string }
export interface RecoveryRecipientEnrollment {
  version: 3; kind: 'recovery-recipient-key'; owner: string; role: string;
  genesis: string; context: string; keyVersion: 1; publicKey: string; keyId: string; signature: string;
}
export interface OpaqueRecoveryCommitment {
  version: 3; kind: 'opaque-recovery-commitment'; scope: string; owner: string; revision: number;
  proofId: string; proofKind: RecoveryProofKind; logicalBytes: number; frameBytes: number; frameDigest: string;
  originalGenesis: string; originalConfiguration: string; originalContext: string;
}
export interface RecoveryCapsule {
  version: 3; kind: 'recovery-dek-capsule'; scope: string; proofId: string; proofKind: RecoveryProofKind;
  originalOwner: string; originalGenesis: string; originalConfiguration: string; originalContext: string;
  frameDigest: string; proposal: string; exporter: string; recipient: string; recipientRole: string;
  wrappingKeyId: string; enc: string; ciphertext: string; signature: string;
}
export interface RecoveryProofPair {
  frame: Buffer; commitment: OpaqueRecoveryCommitment; capsule: RecoveryCapsule;
  capsuleBytes: Buffer; capsuleDigest: string; identity: RecoveryPairIdentity;
}
export interface RecoveryPairIdentity {
  scope: string; proofId: string; kind: RecoveryProofKind; frameDigest: string;
  proposal: string; exporter: string; recipient: string; wrappingKeyId: string; capsuleDigest: string;
}
const validatedPairBrand = Symbol('validated-recovery-pair');
export class RecoveryPairValidationOperation {
  #active = true;
  private constructor(readonly participant: object, readonly token: symbol) {}
  static create(participant: object): RecoveryPairValidationOperation { return new RecoveryPairValidationOperation(participant, Symbol('recovery-pair-operation')); }
  get active(): boolean { return this.#active; }
  close(): void { this.#active = false; }
}
export interface ValidatedRecoveryPairView {
  readonly [validatedPairBrand]: RecoveryPairValidationOperation;
  readonly frame: Buffer; readonly capsuleBytes: Buffer;
  readonly frameMetadata: Readonly<ReturnType<typeof parseOpaqueRecoveryObjectBytes>>;
  readonly commitment: Readonly<OpaqueRecoveryCommitment>; readonly capsule: Readonly<RecoveryCapsule>;
  readonly identity: Readonly<RecoveryPairIdentity>; readonly logicalBytes: number;
  readonly frameBytes: number; readonly capsulePhysicalBytes: number; readonly initialKey: boolean;
}
export function createRecoveryPairValidationOperation(participant: object): RecoveryPairValidationOperation {
  if (!participant || (typeof participant !== 'object' && typeof participant !== 'function')) throw new Error('Invalid pair validation participant');
  return RecoveryPairValidationOperation.create(participant);
}
export function closeRecoveryPairValidationOperation(operation: RecoveryPairValidationOperation): void { operation.close(); }
function samePairIdentity(a: RecoveryPairIdentity, b: RecoveryPairIdentity): boolean {
  return a.scope === b.scope && a.proofId === b.proofId && a.kind === b.kind && a.frameDigest === b.frameDigest
    && a.proposal === b.proposal && a.exporter === b.exporter && a.recipient === b.recipient
    && a.wrappingKeyId === b.wrappingKeyId && a.capsuleDigest === b.capsuleDigest;
}
function assertRecoveryCapsuleMatchesFrame(capsule: RecoveryCapsule, frame: ReturnType<typeof parseOpaqueRecoveryObjectBytes>): void {
  if (frame.frameDigest !== capsule.frameDigest || frame.scope !== capsule.scope || frame.proofId !== capsule.proofId || frame.kind !== capsule.proofKind
    || frame.owner !== capsule.originalOwner || frame.originalGenesis !== capsule.originalGenesis
    || frame.originalConfiguration !== capsule.originalConfiguration || frame.originalContext !== capsule.originalContext) throw new Error('Capsule differs from original frame');
}
export function assertValidatedRecoveryPairView(view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation): ValidatedRecoveryPairView {
  if (!operation.active || view[validatedPairBrand] !== operation) throw new Error('Stale or cross-operation validated pair view');
  if (view.frame.length !== view.frameBytes || view.capsuleBytes.length !== view.capsulePhysicalBytes
    || view.frame.length !== view.commitment.frameBytes || view.logicalBytes !== view.commitment.logicalBytes
    || digest(view.frame) !== view.frameMetadata.frameDigest || digest(view.capsuleBytes) !== view.identity.capsuleDigest) throw new Error('Mutated validated pair view');
  return view;
}
export function validateRecoveryPair(operation: RecoveryPairValidationOperation, pair: RecoveryProofPair, initialKey: boolean): ValidatedRecoveryPairView {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    if (!operation.active) throw new Error('Closed pair validation operation');
    const frame = sustainableRecoveryBytes(pair.frame, undefined, 'V'), capsuleBytes = sustainableRecoveryBytes(pair.capsuleBytes, undefined, 'V');
    const frameMetadata = parseOpaqueRecoveryObjectBytes(frame), capsule = verifyRecoveryCapsule(pair.capsule);
    assertRecoveryCapsuleMatchesFrame(capsule, frameMetadata);
    assertOpaqueRecoveryCommitment(pair.commitment, frameMetadata);
    if (capsuleBytes.length !== pair.capsuleBytes.length || !capsuleBytes.equals(sustainableRecoveryJson(capsule, 'V'))
      || digest(capsuleBytes) !== pair.capsuleDigest) throw new Error('Recovery capsule encoding/digest differs');
    const identity: RecoveryPairIdentity = { scope: frameMetadata.scope, proofId: frameMetadata.proofId, kind: frameMetadata.kind,
      frameDigest: frameMetadata.frameDigest, proposal: capsule.proposal, exporter: capsule.exporter, recipient: capsule.recipient,
      wrappingKeyId: capsule.wrappingKeyId, capsuleDigest: pair.capsuleDigest };
    if (!samePairIdentity(identity, pair.identity)) throw new Error('Recovery pair identity differs');
    return { [validatedPairBrand]: operation, frame, capsuleBytes, frameMetadata: Object.freeze(frameMetadata),
      commitment: Object.freeze({ ...pair.commitment }), capsule: Object.freeze({ ...capsule }), identity: Object.freeze(identity),
      logicalBytes: frameMetadata.logicalBytes, frameBytes: frame.length, capsulePhysicalBytes: capsuleBytes.length, initialKey };
  });
}

export function recoveryProofBaseScope(original: RecoveryOriginalBinding, owner: string): string {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => digest(signedJson('resonance:recovery-original-scope:v3\n', [original.genesis, original.configuration, original.context, owner])));
}
export function recoveryInitialProposal(original: RecoveryOriginalBinding, owner: string): string {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => digest(signedJson('resonance:recovery-initial-capsule:v3\n', [original.genesis, original.configuration, original.context, owner])));
}
export function recoveryPairIdentity(pair: RecoveryProofPair): RecoveryPairIdentity {
  const operation = createRecoveryPairValidationOperation(pair);
  try { return validateRecoveryPair(operation, pair, false).identity; } finally { closeRecoveryPairValidationOperation(operation); }
}

export function verifyRecoveryOriginalProvenance(pair: RecoveryProofPair, expected: RecoveryOriginalBinding & { proofId: string; kind: RecoveryProofKind; signers: string[] }) {
  const frame = parseOpaqueRecoveryObjectBytes(pair.frame);
  verifyRecoveryCapsule(pair.capsule, pair.frame);
  assertOpaqueRecoveryCommitment(pair.commitment, frame);
  if (frame.originalGenesis !== expected.genesis || frame.originalConfiguration !== expected.configuration || frame.originalContext !== expected.context
    || frame.proofId !== expected.proofId || frame.kind !== expected.kind || !expected.signers.includes(frame.owner)
    || frame.baseScope !== recoveryProofBaseScope(expected, frame.owner)) throw new Error('Wrong original signer/scope/configuration');
  return frame;
}

export function assertValidatedRecoveryOriginalProvenance(view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation,
  expected: RecoveryOriginalBinding & { proofId: string; kind: RecoveryProofKind; signers: string[] }) {
  assertValidatedRecoveryPairView(view, operation); const frame = view.frameMetadata;
  if (frame.originalGenesis !== expected.genesis || frame.originalConfiguration !== expected.configuration || frame.originalContext !== expected.context
    || frame.proofId !== expected.proofId || frame.kind !== expected.kind || !expected.signers.includes(frame.owner)
    || frame.baseScope !== recoveryProofBaseScope(expected, frame.owner)) throw new Error('Wrong original signer/scope/configuration');
  return frame;
}

export async function generateRecoveryRecipientKey(): Promise<RecoveryRecipientKeyMaterial> {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, async () => {
    const keys = await suite.kem.generateKeyPair();
    const bytes = new Uint8Array(await suite.kem.serializePublicKey(keys.publicKey));
    chargeSustainableRecoveryWork(bytes.length, 'V', 'serialize');
    return { privateKey: keys.privateKey, publicKey: encoded(bytes), keyId: digest(bytes) };
  });
}
export function createRecoveryRecipientEnrollment(options: {
  material: RecoveryRecipientKeyMaterial; signingKey: SigningKeyPair; role: string; genesis: string; context: string;
}): RecoveryRecipientEnrollment {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    if (!options.role || options.role.length > 64 || !validDigest(options.genesis) || !validDigest(options.context)) throw new Error('Invalid recovery recipient enrollment input');
    const body = { version: 3 as const, kind: 'recovery-recipient-key' as const, owner: publicKey(options.signingKey),
      role: options.role, genesis: options.genesis, context: options.context, keyVersion: 1 as const,
      publicKey: options.material.publicKey, keyId: options.material.keyId };
    return { ...body, signature: encoded(sign(signedJson('resonance:recovery-recipient-key:v3\n', body), options.signingKey.secretKey)) };
  });
}
export function verifyRecoveryRecipientEnrollment(value: unknown, expected?: { owner?: string; role?: string; genesis?: string; context?: string }): RecoveryRecipientEnrollment {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery recipient enrollment');
    const enrollment = value as RecoveryRecipientEnrollment;
    if (!exactKeys(enrollment, 'context,genesis,keyId,keyVersion,kind,owner,publicKey,role,signature,version')
      || enrollment.version !== 3 || enrollment.kind !== 'recovery-recipient-key' || enrollment.keyVersion !== 1
      || !validKey(enrollment.owner) || !validP256(enrollment.publicKey) || !validSignature(enrollment.signature)
      || typeof enrollment.role !== 'string' || !enrollment.role || enrollment.role.length > 64
      || !validDigest(enrollment.genesis) || !validDigest(enrollment.context) || !validDigest(enrollment.keyId)
      || (expected?.owner !== undefined && enrollment.owner !== expected.owner)
      || (expected?.role !== undefined && enrollment.role !== expected.role)
      || (expected?.genesis !== undefined && enrollment.genesis !== expected.genesis)
      || (expected?.context !== undefined && enrollment.context !== expected.context)) throw new Error('Invalid recovery recipient enrollment');
    const publicBytes = sustainableRecoveryBytes(enrollment.publicKey, 'base64url', 'V');
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || digest(publicBytes) !== enrollment.keyId) throw new Error('Invalid recovery wrapping key identity');
    const { signature, ...body } = enrollment;
    if (!verify(signedJson('resonance:recovery-recipient-key:v3\n', body), sustainableRecoveryBytes(signature, 'base64url', 'V'), sustainableRecoveryBytes(enrollment.owner, 'base64url', 'V'))) throw new Error('Unauthenticated recovery recipient enrollment');
    return enrollment;
  });
}

function frameAad(scope: string, original: RecoveryOriginalBinding, owner: string): Buffer {
  return signedJson('resonance:recovery-frame-aad:v3\n', [DOMAIN, original.genesis, original.configuration, original.context, scope, owner]);
}
export function prepareOpaqueRecoveryObject(options: {
  plaintext: Uint8Array; kind: RecoveryProofKind; original: RecoveryOriginalBinding; signingKey: SigningKeyPair;
}): { frame: Buffer; commitment: OpaqueRecoveryCommitment; dek: Buffer } {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    if (!kinds.includes(options.kind) || !validDigest(options.original.genesis) || !validDigest(options.original.configuration) || !validDigest(options.original.context)) throw new Error('Invalid RSO3 proof input');
    const plaintext = sustainableRecoveryView(options.plaintext), proofId = digest(plaintext), owner = publicKey(options.signingKey);
    const scope = `${recoveryProofBaseScope(options.original, owner)}:object:${options.kind}:${proofId}`;
    const scopeBytes = sustainableRecoveryBytes(scope, 'utf8', 'V'), ownerBytes = sustainableRecoveryBytes(owner, 'base64url', 'V');
    const dek = randomBytes(32); chargeSustainableRecoveryWork(dek.length, 'V', 'allocate');
    try {
      const nonce = randomBytes(12); chargeSustainableRecoveryWork(nonce.length, 'V', 'allocate');
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      cipher.setAAD(frameAad(scope, options.original, owner));
      const ciphertext = sustainableRecoveryConcat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()], 'V', 'encrypt');
      const header = Buffer.alloc(HEADER); chargeSustainableRecoveryWork(header.length, 'V', 'allocate');
      header.write(DOMAIN, 0, 'ascii'); header.writeUInt16BE(scopeBytes.length, 8); header.writeBigUInt64BE(0n, 10); header.writeUInt32BE(ciphertext.length, 18);
      const body = sustainableRecoveryConcat([header, scopeBytes, ownerBytes,
        sustainableRecoveryBytes(options.original.genesis.slice(7), 'hex', 'V'), sustainableRecoveryBytes(options.original.configuration.slice(7), 'hex', 'V'),
        sustainableRecoveryBytes(options.original.context.slice(7), 'hex', 'V'), ciphertext], 'V');
      const frame = sustainableRecoveryConcat([body, sign(body, options.signingKey.secretKey)], 'V');
      const parsed = parseOpaqueRecoveryObjectBytes(frame);
      return { frame, dek, commitment: createOpaqueRecoveryCommitment(frame).commitment };
    } catch (error) { dek.fill(0); throw error; }
  });
}
export function parseOpaqueRecoveryObjectBytes(bytes: Uint8Array, expectedBaseScope?: string) {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    const data = sustainableRecoveryView(bytes);
    if (data.length < HEADER + 32 + 96 + 28 + SIGNATURE || data.toString('ascii', 0, 8) !== DOMAIN) throw new Error('Invalid opaque recovery frame version');
    const scopeLength = data.readUInt16BE(8), ciphertextLength = data.readUInt32BE(18);
    if (data.readUInt16BE(22) !== 0) throw new Error('Noncanonical opaque recovery frame');
    const signatureOffset = HEADER + scopeLength + 32 + 96 + ciphertextLength;
    if (signatureOffset + SIGNATURE !== data.length) throw new Error('Opaque recovery frame length/trailing data');
    const scope = decoder.decode(data.subarray(HEADER, HEADER + scopeLength));
    const match = /^(sha256:[a-f0-9]{64}):object:(original|frame|policy|activation):(sha256:[a-f0-9]{64})$/.exec(scope);
    if (!match || (expectedBaseScope !== undefined && match[1] !== expectedBaseScope)) throw new Error('Opaque recovery proof scope differs');
    const ownerStart = HEADER + scopeLength, originalStart = ownerStart + 32, ciphertextStart = originalStart + 96;
    const owner = data.subarray(ownerStart, originalStart), revision = Number(data.readBigUInt64BE(10));
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Opaque revision overflow');
    if (!verify(data.subarray(0, signatureOffset), data.subarray(signatureOffset), owner)) throw new Error('Unauthenticated opaque recovery frame');
    const original = { genesis: `sha256:${data.subarray(originalStart, originalStart + 32).toString('hex')}`,
      configuration: `sha256:${data.subarray(originalStart + 32, originalStart + 64).toString('hex')}`,
      context: `sha256:${data.subarray(originalStart + 64, originalStart + 96).toString('hex')}` };
    if (match[1] !== recoveryProofBaseScope(original, encoded(owner))) throw new Error('Opaque original scope derivation differs');
    return { scope, owner: encoded(owner), revision, ciphertext: data.subarray(ciphertextStart, signatureOffset),
      frameDigest: digest(data), proofId: match[3], baseScope: match[1], kind: match[2] as RecoveryProofKind,
      logicalBytes: ciphertextLength - 28, originalGenesis: original.genesis, originalConfiguration: original.configuration, originalContext: original.context };
  });
}
export function createOpaqueRecoveryCommitment(frame: Uint8Array) {
  const parsed = parseOpaqueRecoveryObjectBytes(frame);
  const commitment: OpaqueRecoveryCommitment = { version: 3, kind: 'opaque-recovery-commitment', scope: parsed.scope,
    owner: parsed.owner, revision: parsed.revision, proofId: parsed.proofId, proofKind: parsed.kind,
    logicalBytes: parsed.logicalBytes, frameBytes: frame.length, frameDigest: parsed.frameDigest,
    originalGenesis: parsed.originalGenesis, originalConfiguration: parsed.originalConfiguration, originalContext: parsed.originalContext };
  return { frame, commitment: validateOpaqueRecoveryCommitment(commitment, parsed.baseScope, parsed.owner), parsed };
}
export function validateOpaqueRecoveryCommitment(value: unknown, expectedBaseScope?: string, expectedOwner?: string): OpaqueRecoveryCommitment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid opaque commitment');
  const commitment = value as OpaqueRecoveryCommitment;
  if (!exactKeys(commitment, 'frameBytes,frameDigest,kind,logicalBytes,originalConfiguration,originalContext,originalGenesis,owner,proofId,proofKind,revision,scope,version')
    || commitment.version !== 3 || commitment.kind !== 'opaque-recovery-commitment' || !validKey(commitment.owner)
    || (expectedOwner !== undefined && commitment.owner !== expectedOwner) || !Number.isSafeInteger(commitment.revision) || commitment.revision < 0
    || !Number.isSafeInteger(commitment.logicalBytes) || commitment.logicalBytes < 0 || !Number.isSafeInteger(commitment.frameBytes) || commitment.frameBytes < 1
    || !validDigest(commitment.frameDigest) || !validDigest(commitment.originalGenesis) || !validDigest(commitment.originalConfiguration) || !validDigest(commitment.originalContext)) throw new Error('Invalid opaque commitment');
  const match = /^(sha256:[a-f0-9]{64}):object:(original|frame|policy|activation):(sha256:[a-f0-9]{64})$/.exec(commitment.scope);
  if (!match || (expectedBaseScope !== undefined && match[1] !== expectedBaseScope) || match[3] !== commitment.proofId || match[2] !== commitment.proofKind
    || recoveryProofBaseScope({ genesis: commitment.originalGenesis, configuration: commitment.originalConfiguration, context: commitment.originalContext }, commitment.owner) !== match[1]) throw new Error('Opaque commitment scope/kind differs');
  const expectedFrameBytes = HEADER + Buffer.byteLength(commitment.scope) + 32 + 96 + commitment.logicalBytes + 28 + SIGNATURE;
  if (commitment.frameBytes !== expectedFrameBytes) throw new Error('Opaque commitment physical length differs');
  return commitment;
}
export function assertOpaqueRecoveryCommitment(commitment: OpaqueRecoveryCommitment, parsed: ReturnType<typeof parseOpaqueRecoveryObjectBytes>): void {
  const expected = validateOpaqueRecoveryCommitment(commitment, parsed.baseScope, parsed.owner);
  if (expected.scope !== parsed.scope || expected.revision !== parsed.revision || expected.proofId !== parsed.proofId
    || expected.proofKind !== parsed.kind || expected.logicalBytes !== parsed.logicalBytes || expected.frameDigest !== parsed.frameDigest
    || expected.originalGenesis !== parsed.originalGenesis || expected.originalConfiguration !== parsed.originalConfiguration || expected.originalContext !== parsed.originalContext) throw new Error('Opaque frame differs from its commitment');
}

function capsuleInfo(value: Omit<RecoveryCapsule, 'enc' | 'ciphertext' | 'signature'>): Buffer {
  return signedJson('resonance:recovery-capsule-hpke:v3\n', value);
}
export async function createRecoveryCapsule(options: {
  frame: Uint8Array; dek: Uint8Array; proposal: string; exporter: SigningKeyPair; enrollment: RecoveryRecipientEnrollment;
}): Promise<RecoveryProofPair> {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, async () => {
    if (options.dek.length !== 32 || !validDigest(options.proposal)) throw new Error('Invalid recovery capsule input');
    const frame = parseOpaqueRecoveryObjectBytes(options.frame), enrollment = verifyRecoveryRecipientEnrollment(options.enrollment, { genesis: frame.originalGenesis, context: frame.originalContext });
    const body = { version: 3 as const, kind: 'recovery-dek-capsule' as const, scope: frame.scope, proofId: frame.proofId,
      proofKind: frame.kind, originalOwner: frame.owner, originalGenesis: frame.originalGenesis,
      originalConfiguration: frame.originalConfiguration, originalContext: frame.originalContext, frameDigest: frame.frameDigest,
      proposal: options.proposal, exporter: publicKey(options.exporter), recipient: enrollment.owner,
      recipientRole: enrollment.role, wrappingKeyId: enrollment.keyId };
    const recipientPublicKey = await suite.kem.deserializePublicKey(sustainableRecoveryBytes(enrollment.publicKey, 'base64url', 'V'));
    const sender = await suite.createSenderContext({ recipientPublicKey, info: capsuleInfo(body) });
    const ciphertext = new Uint8Array(await sender.seal(options.dek, capsuleInfo(body)));
    chargeSustainableRecoveryWork(ciphertext.length, 'V', 'encrypt');
    const unsigned = { ...body, enc: encoded(new Uint8Array(sender.enc)), ciphertext: encoded(ciphertext) };
    const capsule: RecoveryCapsule = { ...unsigned, signature: encoded(sign(signedJson('resonance:recovery-capsule:v3\n', unsigned), options.exporter.secretKey)) };
    const capsuleBytes = sustainableRecoveryJson(capsule, 'V'), capsuleDigest = digest(capsuleBytes);
    const commitment: OpaqueRecoveryCommitment = { version: 3, kind: 'opaque-recovery-commitment', scope: frame.scope,
      owner: frame.owner, revision: frame.revision, proofId: frame.proofId, proofKind: frame.kind,
      logicalBytes: frame.logicalBytes, frameBytes: options.frame.length, frameDigest: frame.frameDigest,
      originalGenesis: frame.originalGenesis, originalConfiguration: frame.originalConfiguration, originalContext: frame.originalContext };
    const identity: RecoveryPairIdentity = { scope: frame.scope, proofId: frame.proofId, kind: frame.kind, frameDigest: frame.frameDigest,
      proposal: capsule.proposal, exporter: capsule.exporter, recipient: capsule.recipient, wrappingKeyId: capsule.wrappingKeyId, capsuleDigest };
    return { frame: sustainableRecoveryBytes(options.frame, undefined, 'V'), commitment, capsule, capsuleBytes, capsuleDigest, identity };
  });
}
export function verifyRecoveryCapsule(value: unknown, frameValue?: Uint8Array, expected?: { proposal?: string; exporter?: string; recipient?: string; wrappingKeyId?: string }): RecoveryCapsule {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery capsule');
    const capsule = value as RecoveryCapsule;
    if (!exactKeys(capsule, 'ciphertext,enc,exporter,frameDigest,kind,originalConfiguration,originalContext,originalGenesis,originalOwner,proofId,proofKind,proposal,recipient,recipientRole,scope,signature,version,wrappingKeyId')
      || capsule.version !== 3 || capsule.kind !== 'recovery-dek-capsule' || !validKey(capsule.originalOwner) || !validKey(capsule.exporter)
      || !validKey(capsule.recipient) || !validP256(capsule.enc) || !validCiphertext(capsule.ciphertext) || !validSignature(capsule.signature)
      || !validDigest(capsule.frameDigest) || !validDigest(capsule.proposal) || !validDigest(capsule.proofId)
      || !validDigest(capsule.originalGenesis) || !validDigest(capsule.originalConfiguration) || !validDigest(capsule.originalContext)
      || !kinds.includes(capsule.proofKind) || typeof capsule.recipientRole !== 'string' || !capsule.recipientRole
      || (expected?.proposal !== undefined && capsule.proposal !== expected.proposal)
      || (expected?.exporter !== undefined && capsule.exporter !== expected.exporter)
      || (expected?.recipient !== undefined && capsule.recipient !== expected.recipient)
      || (expected?.wrappingKeyId !== undefined && capsule.wrappingKeyId !== expected.wrappingKeyId)) throw new Error('Invalid recovery capsule');
    const { signature, ...body } = capsule;
    if (!verify(signedJson('resonance:recovery-capsule:v3\n', body), sustainableRecoveryBytes(signature, 'base64url', 'V'), sustainableRecoveryBytes(capsule.exporter, 'base64url', 'V'))) throw new Error('Unauthenticated recovery capsule');
    if (frameValue) {
      const frame = parseOpaqueRecoveryObjectBytes(frameValue);
      if (frame.frameDigest !== capsule.frameDigest || frame.scope !== capsule.scope || frame.proofId !== capsule.proofId || frame.kind !== capsule.proofKind
        || frame.owner !== capsule.originalOwner || frame.originalGenesis !== capsule.originalGenesis || frame.originalConfiguration !== capsule.originalConfiguration || frame.originalContext !== capsule.originalContext) throw new Error('Capsule differs from original frame');
    }
    return capsule;
  });
}
export function encodeRecoveryCapsule(capsule: RecoveryCapsule): Buffer {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    verifyRecoveryCapsule(capsule);
    return sustainableRecoveryJson(capsule, 'V');
  });
}
function decryptFrame(frame: ReturnType<typeof parseOpaqueRecoveryObjectBytes>, ciphertext: Uint8Array, dekValue: Uint8Array): Buffer {
  if (dekValue.length !== 32) throw new Error('Invalid recovered DEK length');
  const dek = sustainableRecoveryBytes(dekValue, undefined, 'V', 'decrypt');
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, ciphertext.subarray(0, 12));
    decipher.setAAD(frameAad(frame.scope, { genesis: frame.originalGenesis, configuration: frame.originalConfiguration, context: frame.originalContext }, frame.owner));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = sustainableRecoveryConcat([decipher.update(ciphertext.subarray(12, -16)), decipher.final()], 'V', 'decrypt');
    if (digest(plaintext) !== frame.proofId || plaintext.length !== frame.logicalBytes) throw new Error('Recovered plaintext proof identity differs');
    return plaintext;
  } finally { dek.fill(0); }
}
export function decryptOpaqueRecoveryObject(frameValue: Uint8Array, dekValue: Uint8Array): Buffer {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    const frame = parseOpaqueRecoveryObjectBytes(frameValue);
    return decryptFrame(frame, frame.ciphertext, dekValue);
  });
}
export function decryptValidatedRecoveryPair(view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation, dek: Uint8Array): Buffer {
  assertValidatedRecoveryPairView(view, operation);
  return decryptFrame(view.frameMetadata, view.frameMetadata.ciphertext, dek);
}
export async function openValidatedRecoveryCapsule(view: ValidatedRecoveryPairView, operation: RecoveryPairValidationOperation, options: {
  material: RecoveryRecipientKeyMaterial; enrollment: RecoveryRecipientEnrollment; proposal?: string; exporter?: string;
}): Promise<{ plaintext: Buffer; dek: Buffer }> {
  assertValidatedRecoveryPairView(view, operation);
  const capsule = view.capsule, enrollment = verifyRecoveryRecipientEnrollment(options.enrollment, { owner: capsule.recipient, role: capsule.recipientRole,
    genesis: capsule.originalGenesis, context: capsule.originalContext });
  if (enrollment.keyId !== options.material.keyId || enrollment.publicKey !== options.material.publicKey
    || options.proposal !== undefined && capsule.proposal !== options.proposal || options.exporter !== undefined && capsule.exporter !== options.exporter) throw new Error('Recovery recipient or capsule differs');
  const { enc, ciphertext, signature, ...body } = capsule, info = capsuleInfo(body);
  const recipient = await suite.createRecipientContext({ recipientKey: options.material.privateKey,
    enc: sustainableRecoveryBytes(enc, 'base64url', 'V'), info });
  const dek = sustainableRecoveryBytes(new Uint8Array(await recipient.open(sustainableRecoveryBytes(ciphertext, 'base64url', 'V'), info)), undefined, 'V', 'decrypt');
  if (dek.length !== 32) { dek.fill(0); throw new Error('Invalid recovered DEK length'); }
  try {
    assertValidatedRecoveryPairView(view, operation);
    const plaintext = decryptFrame(view.frameMetadata, view.frameMetadata.ciphertext, dek);
    return { plaintext, dek };
  } catch (error) { dek.fill(0); throw error; }
}
export async function unwrapRecoveryCapsule(options: {
  pair: RecoveryProofPair; material: RecoveryRecipientKeyMaterial; enrollment: RecoveryRecipientEnrollment;
  proposal?: string; exporter?: string;
}): Promise<Buffer> {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, async () => {
    const enrollment = verifyRecoveryRecipientEnrollment(options.enrollment, { owner: options.pair.capsule.recipient, role: options.pair.capsule.recipientRole,
      genesis: options.pair.capsule.originalGenesis, context: options.pair.capsule.originalContext });
    if (enrollment.keyId !== options.material.keyId || enrollment.publicKey !== options.material.publicKey) throw new Error('Recovery recipient private key differs from enrollment');
    const capsule = verifyRecoveryCapsule(options.pair.capsule, options.pair.frame, { proposal: options.proposal, exporter: options.exporter,
      recipient: enrollment.owner, wrappingKeyId: enrollment.keyId });
    assertOpaqueRecoveryCommitment(options.pair.commitment, parseOpaqueRecoveryObjectBytes(options.pair.frame));
    if (digest(options.pair.capsuleBytes) !== options.pair.capsuleDigest || !options.pair.capsuleBytes.equals(encodeRecoveryCapsule(capsule))) throw new Error('Recovery capsule encoding/digest differs');
    const { enc, ciphertext, signature, ...body } = capsule, info = capsuleInfo(body);
    const recipient = await suite.createRecipientContext({ recipientKey: options.material.privateKey,
      enc: sustainableRecoveryBytes(enc, 'base64url', 'V'), info });
    const dek = sustainableRecoveryBytes(new Uint8Array(await recipient.open(sustainableRecoveryBytes(ciphertext, 'base64url', 'V'), info)), undefined, 'V', 'decrypt');
    if (dek.length !== 32) { dek.fill(0); throw new Error('Invalid recovered DEK length'); }
    return dek;
  });
}
export async function openRecoveryCapsule(options: {
  pair: RecoveryProofPair; material: RecoveryRecipientKeyMaterial; enrollment: RecoveryRecipientEnrollment;
  proposal?: string; exporter?: string;
}): Promise<Buffer> {
  const dek = await unwrapRecoveryCapsule(options);
  try { return decryptOpaqueRecoveryObject(options.pair.frame, dek); } finally { dek.fill(0); }
}
