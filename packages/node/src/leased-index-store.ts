import { randomBytes } from 'node:crypto';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createLeasedIndexWithdrawalV1,
  createOriginalCommitmentV1,
  decodeBase64,
  generateOriginalCommitmentKeyV1,
  parseLeasedIndexOperationV1,
  serializeLeasedIndexOperationV1,
  verifyOriginalCommitmentV1,
  type CreateLeasedIndexInputV1,
  type ItemType,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexOperationV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { openEncryptedLocalState } from './encrypted-local-state.js';

const STATE_VERSION = 1 as const;
const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024;
const MIN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LeasedIndexOriginalStateV1 {
  semanticRevision: number;
  bytes: string;
  commitmentKey: string;
}

export interface LeasedIndexLocalStateV1 {
  version: typeof STATE_VERSION;
  publicationId: string;
  clientLeaseId: string;
  signingPublicKey: string;
  signingSecretKey: string;
  mailboxPublicKey: string;
  mailboxSecretKey: string;
  mailboxId: string;
  originals: LeasedIndexOriginalStateV1[];
  operationBytes: string[];
  currentBytes: string;
  acknowledgedBytes: string | null;
  pendingBytes: string | null;
  nextLeaseSequence: number;
  semanticRevision: number;
  writerId: string;
  writerLeaseId: string | null;
  reconciledGenerationId: string | null;
  observedGenerationIds: string[];
  withdrawn: boolean;
  notificationIds: string[];
}

export interface CreateLeasedIndexLocalStoreOptionsV1 {
  path: string;
  encryptionKey: Uint8Array;
  keys: LeasedIndexKeyMaterialV1;
  originalBytes: Uint8Array;
  input: Omit<CreateLeasedIndexInputV1, 'leaseSequence' | 'semanticRevision' | 'originalCommitment'>;
}

export interface OpenLeasedIndexLocalStoreOptionsV1 {
  path: string;
  encryptionKey: Uint8Array;
}

export interface ReviseLeasedIndexInputV1 {
  originalBytes: Uint8Array;
  createdAt: number;
  expiresAt: number;
  groupId?: string;
  itemType?: ItemType;
  derivationId?: string;
  fingerprintEpoch?: string;
  fingerprint?: Uint8Array;
}

export interface LeaseWriterReconciliationResultV1 {
  status: 'ready' | 'waiting' | 'conflict' | 'withdrawn';
  writerLeaseId?: string;
  generationId?: string;
  observedGenerationIds: string[];
}

interface SnapshotHandle {
  read(): LeasedIndexLocalStateV1;
  write(value: LeasedIndexLocalStateV1): void;
  close(): void;
}

export class LeasedIndexLocalStore {
  private constructor(private readonly snapshot: SnapshotHandle) {}

  static create(options: CreateLeasedIndexLocalStoreOptionsV1): LeasedIndexLocalStore {
    const commitmentKey = generateOriginalCommitmentKeyV1();
    const index = createLeasedIndexV1({
      ...options.input,
      leaseSequence: 0,
      semanticRevision: 0,
      originalCommitment: createOriginalCommitmentV1(options.originalBytes, commitmentKey),
    }, options.keys);
    const bytes = serializeLeasedIndexOperationV1(index);
    const initial: LeasedIndexLocalStateV1 = {
      version: STATE_VERSION,
      publicationId: keysOrThrow(options.keys).publicationId,
      clientLeaseId: options.keys.clientLeaseId,
      signingPublicKey: encodeBytes(options.keys.signingKeyPair.publicKey),
      signingSecretKey: encodeBytes(options.keys.signingKeyPair.secretKey),
      mailboxPublicKey: encodeBytes(options.keys.mailboxKeyPair.publicKey),
      mailboxSecretKey: encodeBytes(options.keys.mailboxKeyPair.secretKey),
      mailboxId: options.keys.mailboxId,
      originals: [{
        semanticRevision: 0,
        bytes: encodeBytes(options.originalBytes),
        commitmentKey: encodeBytes(commitmentKey),
      }],
      operationBytes: [bytes],
      currentBytes: bytes,
      acknowledgedBytes: null,
      pendingBytes: bytes,
      nextLeaseSequence: 1,
      semanticRevision: 0,
      writerId: randomBytes(16).toString('base64url'),
      writerLeaseId: null,
      reconciledGenerationId: null,
      observedGenerationIds: [createLeasedIndexGenerationIdV1(index)],
      withdrawn: false,
      notificationIds: [],
    };
    const snapshot = openEncryptedLocalState<LeasedIndexLocalStateV1>({
      path: options.path,
      key: options.encryptionKey,
      domain: 'resonance:leased-index-local:v1',
      maxBytes: MAX_LOCAL_STATE_BYTES,
      initial,
      validate: isLocalState,
      mode: 'create-new',
    });
    return new LeasedIndexLocalStore(snapshot);
  }

  static open(options: OpenLeasedIndexLocalStoreOptionsV1): LeasedIndexLocalStore {
    const snapshot = openEncryptedLocalState<LeasedIndexLocalStateV1>({
      path: options.path,
      key: options.encryptionKey,
      domain: 'resonance:leased-index-local:v1',
      maxBytes: MAX_LOCAL_STATE_BYTES,
      initial: {} as LeasedIndexLocalStateV1,
      validate: isLocalState,
      mode: 'open-existing',
    });
    const current = snapshot.read();
    snapshot.write({
      ...current,
      writerLeaseId: null,
      reconciledGenerationId: null,
    });
    return new LeasedIndexLocalStore(snapshot);
  }

  read(): LeasedIndexLocalStateV1 {
    return structuredClone(this.snapshot.read());
  }

  currentOperation(): LeasedIndexOperationV1 {
    return parseLeasedIndexOperationV1(this.snapshot.read().currentBytes);
  }

  pendingOperation(): string | null {
    return this.snapshot.read().pendingBytes;
  }

  original(semanticRevision: number): Uint8Array | undefined {
    const original = this.snapshot.read().originals.find(item => item.semanticRevision === semanticRevision);
    return original ? Uint8Array.from(decodeBytes(original.bytes)) : undefined;
  }

  acknowledge(raw: string): void {
    const state = this.snapshot.read();
    if (state.pendingBytes === null || raw !== state.pendingBytes) {
      throw new Error('Acknowledgement does not match the exact pending operation');
    }
    const operation = parseLeasedIndexOperationV1(raw);
    this.snapshot.write({
      ...state,
      acknowledgedBytes: raw,
      pendingBytes: null,
      nextLeaseSequence: operation.leaseSequence + 1,
      semanticRevision: operation.semanticRevision,
      writerLeaseId: null,
      reconciledGenerationId: null,
      withdrawn: state.withdrawn || operation.kind === 'leased-discovery-withdrawal',
    });
  }

  reconcile(replicaStates: readonly (readonly string[])[]): LeaseWriterReconciliationResultV1 {
    if (!Array.isArray(replicaStates) || replicaStates.length === 0) throw new Error('Replica evidence is required');
    const state = this.snapshot.read();
    const replicaBytes = new Set<string>();
    const operations = new Map<string, LeasedIndexOperationV1>();
    for (const replica of replicaStates) {
      if (!Array.isArray(replica)) throw new Error('Invalid replica evidence');
      for (const bytes of replica) {
        const operation = parseLeasedIndexOperationV1(bytes);
        if (!sameLocalWriter(state, operation)) throw new Error('Replica evidence belongs to another writer');
        replicaBytes.add(bytes);
        operations.set(bytes, operation);
      }
    }
    for (const bytes of state.operationBytes) {
      operations.set(bytes, parseLeasedIndexOperationV1(bytes));
    }
    if (state.acknowledgedBytes) {
      const operation = parseLeasedIndexOperationV1(state.acknowledgedBytes);
      operations.set(state.acknowledgedBytes, operation);
    }
    if (state.pendingBytes) {
      const pending = parseLeasedIndexOperationV1(state.pendingBytes);
      operations.set(state.pendingBytes, pending);
    }
    const observedGenerationIds = generationIds(Array.from(operations.values()));
    const withdrawals = Array.from(operations.entries())
      .filter((entry): entry is [string, Extract<LeasedIndexOperationV1, { kind: 'leased-discovery-withdrawal' }>] => (
        entry[1].kind === 'leased-discovery-withdrawal'
      ));
    if (withdrawals.length > 0) {
      const distinct = new Set(withdrawals.map(([bytes]) => bytes));
      const selected = withdrawals.sort((a, b) => b[1].leaseSequence - a[1].leaseSequence
        || a[0].localeCompare(b[0]))[0];
      const next: LeasedIndexLocalStateV1 = {
        ...state,
        operationBytes: appendedBytes(state.operationBytes, selected[0]),
        currentBytes: selected[0],
        acknowledgedBytes: selected[0],
        pendingBytes: null,
        nextLeaseSequence: selected[1].leaseSequence + 1,
        semanticRevision: selected[1].semanticRevision,
        writerLeaseId: null,
        reconciledGenerationId: null,
        observedGenerationIds,
        withdrawn: true,
      };
      this.snapshot.write(next);
      return { status: distinct.size > 1 ? 'conflict' : 'withdrawn', observedGenerationIds };
    }

    const live = Array.from(operations.entries())
      .filter((entry): entry is [string, LeasedIndexV1] => entry[1].kind === 'leased-discovery-index');
    const highestSequence = Math.max(...live.map(([, operation]) => operation.leaseSequence));
    const highest = live.filter(([, operation]) => operation.leaseSequence === highestSequence);
    const distinctHighest = new Set(highest.map(([bytes]) => bytes));
    if (distinctHighest.size > 1) {
      this.snapshot.write({
        ...state,
        writerLeaseId: null,
        reconciledGenerationId: null,
        observedGenerationIds,
      });
      return { status: 'conflict', observedGenerationIds };
    }
    if (highest.length === 0) {
      this.snapshot.write({ ...state, writerLeaseId: null, reconciledGenerationId: null, observedGenerationIds });
      return { status: 'waiting', observedGenerationIds };
    }
    const [selectedBytes, selected] = highest[0];
    const pendingResolved = state.pendingBytes === null || state.pendingBytes === selectedBytes;
    const replicated = replicaBytes.has(selectedBytes);
    if (!pendingResolved) {
      this.snapshot.write({
        ...state,
        writerLeaseId: null,
        reconciledGenerationId: null,
        observedGenerationIds,
      });
      return { status: 'waiting', generationId: createLeasedIndexGenerationIdV1(selected), observedGenerationIds };
    }
    const next: LeasedIndexLocalStateV1 = {
      ...state,
      operationBytes: appendedBytes(state.operationBytes, selectedBytes),
      currentBytes: selectedBytes,
      acknowledgedBytes: pendingResolved && replicated ? selectedBytes : state.acknowledgedBytes,
      pendingBytes: pendingResolved && replicated ? null : state.pendingBytes,
      nextLeaseSequence: selected.leaseSequence + 1,
      semanticRevision: selected.semanticRevision,
      writerLeaseId: null,
      reconciledGenerationId: null,
      observedGenerationIds,
      withdrawn: false,
    };
    if (!pendingResolved || !replicated) {
      this.snapshot.write(next);
      return { status: 'waiting', generationId: createLeasedIndexGenerationIdV1(selected), observedGenerationIds };
    }
    const writerLeaseId = randomBytes(16).toString('base64url');
    const generationId = createLeasedIndexGenerationIdV1(selected);
    this.snapshot.write({
      ...next,
      acknowledgedBytes: selectedBytes,
      pendingBytes: null,
      writerLeaseId,
      reconciledGenerationId: generationId,
    });
    return { status: 'ready', writerLeaseId, generationId, observedGenerationIds };
  }

  refresh(writerLeaseId: string, createdAt: number, expiresAt: number): string {
    const state = this.readyState(writerLeaseId);
    const current = this.currentLive(state);
    if (createdAt - current.createdAt < MIN_REFRESH_INTERVAL_MS || expiresAt <= current.expiresAt) {
      throw new Error('Lease refresh is too early or does not extend expiry');
    }
    const next = createLeasedIndexV1({
      leaseSequence: current.leaseSequence + 1,
      semanticRevision: current.semanticRevision,
      groupId: current.groupId,
      itemType: current.itemType,
      derivationId: current.derivationId,
      fingerprintEpoch: current.fingerprint.epoch,
      fingerprint: decodeBase64(current.fingerprint.value),
      originalCommitment: current.original.commitment,
      createdAt,
      expiresAt,
    }, keysFromState(state));
    return this.setPending(state, next);
  }

  revise(writerLeaseId: string, input: ReviseLeasedIndexInputV1): string {
    const state = this.readyState(writerLeaseId);
    const current = this.currentLive(state);
    if (input.createdAt <= current.createdAt) throw new Error('Semantic revision must advance creation time');
    const commitmentKey = generateOriginalCommitmentKeyV1();
    const next = createLeasedIndexV1({
      leaseSequence: current.leaseSequence + 1,
      semanticRevision: current.semanticRevision + 1,
      groupId: input.groupId ?? current.groupId,
      itemType: input.itemType ?? current.itemType,
      derivationId: input.derivationId ?? current.derivationId,
      fingerprintEpoch: input.fingerprintEpoch ?? current.fingerprint.epoch,
      fingerprint: input.fingerprint ?? decodeBase64(current.fingerprint.value),
      originalCommitment: createOriginalCommitmentV1(input.originalBytes, commitmentKey),
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    }, keysFromState(state));
    const bytes = serializeLeasedIndexOperationV1(next);
    this.snapshot.write({
      ...state,
      originals: [...state.originals, {
        semanticRevision: next.semanticRevision,
        bytes: encodeBytes(input.originalBytes),
        commitmentKey: encodeBytes(commitmentKey),
      }],
      operationBytes: appendedBytes(state.operationBytes, bytes),
      currentBytes: bytes,
      pendingBytes: bytes,
      nextLeaseSequence: next.leaseSequence + 1,
      semanticRevision: next.semanticRevision,
      writerLeaseId: null,
      reconciledGenerationId: null,
    });
    return bytes;
  }

  withdraw(writerLeaseId: string, createdAt: number): string {
    const state = this.readyState(writerLeaseId);
    const current = this.currentLive(state);
    const withdrawal = createLeasedIndexWithdrawalV1(current, keysFromState(state), createdAt);
    const bytes = serializeLeasedIndexOperationV1(withdrawal);
    this.snapshot.write({
      ...state,
      operationBytes: appendedBytes(state.operationBytes, bytes),
      currentBytes: bytes,
      pendingBytes: bytes,
      nextLeaseSequence: withdrawal.leaseSequence + 1,
      writerLeaseId: null,
      reconciledGenerationId: null,
      withdrawn: true,
    });
    return bytes;
  }

  recordNotification(notificationId: string): boolean {
    if (!/^notification_[A-Za-z0-9_-]{43}$/.test(notificationId)) throw new Error('Invalid notification ID');
    const state = this.snapshot.read();
    if (state.notificationIds.includes(notificationId)) return false;
    this.snapshot.write({ ...state, notificationIds: [...state.notificationIds, notificationId] });
    return true;
  }

  close(): void {
    this.snapshot.close();
  }

  private readyState(writerLeaseId: string): LeasedIndexLocalStateV1 {
    const state = this.snapshot.read();
    const current = this.currentLive(state);
    const generationId = createLeasedIndexGenerationIdV1(current);
    if (state.withdrawn || state.pendingBytes !== null || state.acknowledgedBytes !== state.currentBytes
      || state.writerLeaseId === null || state.writerLeaseId !== writerLeaseId
      || state.reconciledGenerationId !== generationId) {
      throw new Error('Writer is stale, read-only, withdrawn, or has unresolved outbox state');
    }
    return state;
  }

  private currentLive(state: LeasedIndexLocalStateV1): LeasedIndexV1 {
    const current = parseLeasedIndexOperationV1(state.currentBytes);
    if (current.kind !== 'leased-discovery-index') throw new Error('Withdrawn publication is read-only');
    return current;
  }

  private setPending(state: LeasedIndexLocalStateV1, operation: LeasedIndexOperationV1): string {
    const bytes = serializeLeasedIndexOperationV1(operation);
    this.snapshot.write({
      ...state,
      operationBytes: appendedBytes(state.operationBytes, bytes),
      currentBytes: bytes,
      pendingBytes: bytes,
      nextLeaseSequence: operation.leaseSequence + 1,
      semanticRevision: operation.semanticRevision,
      writerLeaseId: null,
      reconciledGenerationId: null,
    });
    return bytes;
  }
}

function isLocalState(value: unknown): value is LeasedIndexLocalStateV1 {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== [
    'acknowledgedBytes', 'clientLeaseId', 'currentBytes', 'mailboxId', 'mailboxPublicKey',
    'mailboxSecretKey', 'nextLeaseSequence', 'notificationIds', 'observedGenerationIds',
    'operationBytes', 'originals', 'pendingBytes', 'publicationId', 'reconciledGenerationId', 'semanticRevision',
    'signingPublicKey', 'signingSecretKey', 'version', 'withdrawn', 'writerId', 'writerLeaseId',
  ].sort().join(',')) return false;
  try {
    if (value.version !== STATE_VERSION
      || !isBase64Url(value.writerId, 16)
      || (value.writerLeaseId !== null && !isBase64Url(value.writerLeaseId, 16))
      || (value.reconciledGenerationId !== null && !isOpaque(value.reconciledGenerationId, 'gen'))
      || ((value.writerLeaseId === null) !== (value.reconciledGenerationId === null))
      || !isBase64Url(value.signingPublicKey, 32)
      || !isBase64Url(value.signingSecretKey, 64)
      || !isBase64Url(value.mailboxPublicKey, 32)
      || !isBase64Url(value.mailboxSecretKey, 32)
      || !isOpaque(value.publicationId, 'pub')
      || !isOpaque(value.clientLeaseId, 'lease')
      || !isOpaque(value.mailboxId, 'mbx')
      || typeof value.currentBytes !== 'string'
      || (value.acknowledgedBytes !== null && typeof value.acknowledgedBytes !== 'string')
      || (value.pendingBytes !== null && typeof value.pendingBytes !== 'string')
      || !Number.isSafeInteger(value.nextLeaseSequence)
      || !Number.isSafeInteger(value.semanticRevision)
      || typeof value.withdrawn !== 'boolean'
      || !Array.isArray(value.operationBytes)
      || !value.operationBytes.every(bytes => typeof bytes === 'string')
      || !Array.isArray(value.originals)
      || !Array.isArray(value.notificationIds)
      || !value.notificationIds.every(id => typeof id === 'string' && /^notification_[A-Za-z0-9_-]{43}$/.test(id))
      || new Set(value.notificationIds).size !== value.notificationIds.length
      || !Array.isArray(value.observedGenerationIds)
      || !value.observedGenerationIds.every(id => isOpaque(id, 'gen'))
      || new Set(value.observedGenerationIds).size !== value.observedGenerationIds.length) return false;
    const state = value as unknown as LeasedIndexLocalStateV1;
    const current = parseLeasedIndexOperationV1(state.currentBytes);
    if (!sameLocalWriter(state, current)
      || state.nextLeaseSequence !== current.leaseSequence + 1
      || state.semanticRevision !== current.semanticRevision
      || new Set(state.operationBytes).size !== state.operationBytes.length
      || !state.operationBytes.includes(state.currentBytes)) return false;
    for (const bytes of state.operationBytes) {
      if (!sameLocalWriter(state, parseLeasedIndexOperationV1(bytes))) return false;
    }
    for (const bytes of [state.acknowledgedBytes, state.pendingBytes]) {
      if (bytes !== null && !sameLocalWriter(state, parseLeasedIndexOperationV1(bytes))) return false;
    }
    if (state.pendingBytes !== null && state.pendingBytes !== state.currentBytes) return false;
    if (current.kind === 'leased-discovery-withdrawal' && !state.withdrawn) return false;
    const revisions = new Set<number>();
    for (const original of state.originals) {
      if (!isObject(original) || Object.keys(original).sort().join(',') !== 'bytes,commitmentKey,semanticRevision'
        || !Number.isSafeInteger(original.semanticRevision) || original.semanticRevision < 0
        || original.semanticRevision > state.semanticRevision || revisions.has(original.semanticRevision)
        || !isBase64Url(original.bytes) || decodeBytes(original.bytes).byteLength > 8192
        || !isBase64Url(original.commitmentKey, 32)) return false;
      revisions.add(original.semanticRevision);
    }
    if (!revisions.has(current.semanticRevision)) return false;
    const original = state.originals.find(item => item.semanticRevision === current.semanticRevision);
    if (current.kind === 'leased-discovery-index' && original && !verifyOriginalCommitmentV1(
      decodeBytes(original.bytes),
      decodeBytes(original.commitmentKey),
      current.original.commitment,
    )) return false;
    return true;
  } catch {
    return false;
  }
}

function keysFromState(state: LeasedIndexLocalStateV1): LeasedIndexKeyMaterialV1 {
  return {
    publicationId: state.publicationId,
    clientLeaseId: state.clientLeaseId,
    mailboxId: state.mailboxId,
    signingKeyPair: {
      publicKey: decodeBytes(state.signingPublicKey),
      secretKey: decodeBytes(state.signingSecretKey),
    },
    mailboxKeyPair: {
      publicKey: decodeBytes(state.mailboxPublicKey),
      secretKey: decodeBytes(state.mailboxSecretKey),
    },
  };
}

function keysOrThrow(keys: LeasedIndexKeyMaterialV1): LeasedIndexKeyMaterialV1 {
  if (!isOpaque(keys.publicationId, 'pub') || !isOpaque(keys.clientLeaseId, 'lease')) {
    throw new Error('Invalid leased index keys');
  }
  return keys;
}

function sameLocalWriter(
  state: LeasedIndexLocalStateV1,
  operation: LeasedIndexOperationV1,
): boolean {
  return operation.publicationId === state.publicationId
    && operation.clientLeaseId === state.clientLeaseId
    && operation.publicationKey === Buffer.from(decodeBytes(state.signingPublicKey)).toString('base64');
}

function generationIds(operations: LeasedIndexOperationV1[]): string[] {
  return Array.from(new Set(operations.flatMap(operation => (
    operation.kind === 'leased-discovery-index' ? [createLeasedIndexGenerationIdV1(operation)] : []
  )))).sort();
}

function appendedBytes(history: string[], bytes: string): string[] {
  return history.includes(bytes) ? history : [...history, bytes];
}

function encodeBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('Invalid local bytes');
  return Buffer.from(bytes).toString('base64url');
}

function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64url'));
}

function isBase64Url(value: unknown, length?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return false;
  const bytes = decodeBytes(value);
  return Buffer.from(bytes).toString('base64url') === value && (length === undefined || bytes.length === length);
}

function isOpaque(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
