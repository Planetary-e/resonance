import {
  createLeasedIndexGenerationIdV1,
  createOfflineDiscoveryAckIdV1,
  createOfflineDiscoveryAckV1,
  createOfflineDiscoveryDepositV1,
  createOfflineDiscoveryRequestV1,
  decryptOfflineDiscoveryEnvelopeV1,
  encodeBase64,
  encryptOfflineDiscoveryRequestV1,
  generateSigningKeyPair,
  parseLeasedIndexOperationV1,
  parseOfflineDiscoveryAckV1,
  parseOfflineDiscoveryDepositV1,
  serializeLeasedIndexOperationV1,
  serializeOfflineDiscoveryAckV1,
  serializeOfflineDiscoveryDepositV1,
  verifyLeasedIndexV1,
  verifyOfflineDiscoveryAckV1,
  verifyOfflineDiscoveryReceiptForDepositV1,
  verifyOfflineDiscoveryReceiptV1,
  verifyOfflineDiscoveryRequestV1,
  type AdmissionCapabilityV2,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
  type OfflineDiscoveryAckV1,
  type OfflineDiscoveryDepositV1,
  type OfflineDiscoveryReplicaReceiptV1,
  type OfflineDiscoveryRequestV1,
} from '@resonance/core';
import { randomBytes } from 'node:crypto';
import { openEncryptedLocalState } from './encrypted-local-state.js';

const MAX_OUTBOX_ENTRIES = 64;
const MAX_LOCAL_BYTES = 16 * 1024 * 1024;

export type OfflineRequestDeliveryState =
  | 'held'
  | 'sending'
  | 'stored'
  | 'queued'
  | 'outcome-unknown'
  | 'acknowledged'
  | 'expired';

export interface OfflineRequestGenerationStateV1 {
  generationId: string;
  depositBytes: string;
  admission: AdmissionCapabilityV2;
  receipts: OfflineDiscoveryReplicaReceiptV1[];
  ackBytes: string | null;
}

export interface OfflineRequestOutboxStateV1 {
  requestId: string;
  clientLeaseId: string;
  senderSecretKey: string;
  originalRequestBytes: string;
  generations: OfflineRequestGenerationStateV1[];
  selectedRelayIds: string[];
  state: OfflineRequestDeliveryState;
  activeGenerationId: string | null;
}

export interface OfflineInboxStateV1 {
  clientLeaseId: string;
  requestId: string;
  requestBytes: string;
  committedAt: number;
}

export interface OfflineMailboxGenerationStateV1 {
  generationId: string;
  indexBytes: string;
  mailboxPublicKey: string;
  mailboxSecretKey: string;
  signingPublicKey: string;
  signingSecretKey: string;
}

export interface OfflineRequestLocalStateV1 {
  version: 1;
  outbox: OfflineRequestOutboxStateV1[];
  inbox: OfflineInboxStateV1[];
  pendingAcks: string[];
  generations: OfflineMailboxGenerationStateV1[];
  withdrawnLeases: string[];
}

export interface OfflineRequestDepositResultV1 {
  requestId: string;
  generationId: string;
  depositBytes: string;
  admission: AdmissionCapabilityV2;
  transportId: string;
}

export interface OfflineRequestReceiveResultV1 {
  status: 'committed' | 'duplicate';
  request: OfflineDiscoveryRequestV1;
  ackBytes: string;
}

interface Snapshot {
  read(): OfflineRequestLocalStateV1;
  write(value: OfflineRequestLocalStateV1): void;
  close(): void;
}

export class OfflineRequestStore {
  private readonly snapshot: Snapshot;
  private readonly now: () => number;
  private closed = false;

  private constructor(snapshot: Snapshot, now: () => number) {
    this.snapshot = snapshot;
    this.now = now;
    const state = snapshot.read();
    const reopened = state.outbox.map(entry => entry.state === 'sending'
      ? { ...entry, state: 'outcome-unknown' as const, activeGenerationId: null }
      : entry);
    if (reopened.some((entry, index) => entry !== state.outbox[index])) {
      snapshot.write({ ...state, outbox: reopened });
    }
    this.expire(now());
  }

  static open(options: {
    path: string;
    encryptionKey: Uint8Array;
    now?: () => number;
  }): OfflineRequestStore {
    const snapshot = openEncryptedLocalState<OfflineRequestLocalStateV1>({
      path: options.path,
      key: options.encryptionKey,
      domain: 'resonance:offline-request-store:v1',
      maxBytes: MAX_LOCAL_BYTES,
      initial: {
        version: 1,
        outbox: [],
        inbox: [],
        pendingAcks: [],
        generations: [],
        withdrawnLeases: [],
      },
      validate: isLocalState,
    });
    return new OfflineRequestStore(snapshot, options.now ?? Date.now);
  }

  retainGeneration(index: LeasedIndexV1, keys: LeasedIndexKeyMaterialV1): void {
    this.ensureOpen();
    if (!verifyLeasedIndexV1(index)
      || keys.publicationId !== index.publicationId
      || keys.clientLeaseId !== index.clientLeaseId
      || keys.mailboxId !== index.mailbox.id
      || encodeBase64(keys.signingKeyPair.publicKey) !== index.publicationKey
      || encodeBase64(keys.mailboxKeyPair.publicKey) !== index.mailbox.encryptionKey) {
      throw new Error('Invalid retained mailbox generation');
    }
    const state = this.snapshot.read();
    const generationId = generationIdOf(index);
    if (state.generations.some(item => item.generationId === generationId)) return;
    const generation: OfflineMailboxGenerationStateV1 = {
      generationId,
      indexBytes: serializeLeasedIndexOperationV1(index),
      mailboxPublicKey: bytesToString(keys.mailboxKeyPair.publicKey),
      mailboxSecretKey: bytesToString(keys.mailboxKeyPair.secretKey),
      signingPublicKey: bytesToString(keys.signingKeyPair.publicKey),
      signingSecretKey: bytesToString(keys.signingKeyPair.secretKey),
    };
    this.snapshot.write({ ...state, generations: [...state.generations, generation] });
  }

  createDeposit(options: {
    index: LeasedIndexV1;
    requestNonce: Uint8Array;
    payload: string;
    replyCapability: string;
    createdAt: number;
    expiresAt: number;
    admission: AdmissionCapabilityV2;
    selectedRelayIds: readonly string[];
  }): OfflineRequestDepositResultV1 {
    this.ensureOpen();
    if (this.now() < options.createdAt || this.now() >= options.expiresAt) {
      throw new Error('Offline request is not currently valid');
    }
    if (!verifyLeasedIndexV1(options.index) || options.selectedRelayIds.length < 1
      || options.selectedRelayIds.length > 5
      || new Set(options.selectedRelayIds).size !== options.selectedRelayIds.length) {
      throw new Error('Invalid offline outbox input');
    }
    const sender = generateSigningKeyPair();
    const request = createOfflineDiscoveryRequestV1({
      requestNonce: options.requestNonce,
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
      payload: options.payload,
      replyCapability: options.replyCapability,
    }, options.index, sender);
    const state = this.snapshot.read();
    if (state.outbox.some(entry => entry.requestId === request.requestId)) {
      throw new Error('Logical request already exists');
    }
    if (state.outbox.length >= MAX_OUTBOX_ENTRIES) throw new Error('Offline request outbox is full');
    const depositBytes = encryptedDeposit(request, sender);
    const generation: OfflineRequestGenerationStateV1 = {
      generationId: request.generationId,
      depositBytes,
      admission: structuredClone(options.admission),
      receipts: [],
      ackBytes: null,
    };
    const entry: OfflineRequestOutboxStateV1 = {
      requestId: request.requestId,
      clientLeaseId: request.clientLeaseId,
      senderSecretKey: bytesToString(sender.secretKey),
      originalRequestBytes: JSON.stringify(request),
      generations: [generation],
      selectedRelayIds: [...options.selectedRelayIds],
      state: 'held',
      activeGenerationId: null,
    };
    this.snapshot.write({ ...state, outbox: [...state.outbox, entry] });
    return {
      requestId: request.requestId,
      generationId: request.generationId,
      depositBytes,
      admission: structuredClone(options.admission),
      transportId: randomBytes(16).toString('base64url'),
    };
  }

  redeposit(options: {
    requestId: string;
    index: LeasedIndexV1;
    admission: AdmissionCapabilityV2;
  }): OfflineRequestDepositResultV1 {
    this.ensureOpen();
    const state = this.snapshot.read();
    const entry = this.findOutbox(state, options.requestId);
    if (!verifyLeasedIndexV1(options.index) || options.index.clientLeaseId !== entry.clientLeaseId) {
      throw new Error('Invalid refreshed offline request index');
    }
    const active = entry.generations.filter(generation => {
      const deposit = parseOfflineDiscoveryDepositV1(generation.depositBytes);
      return !generation.ackBytes && deposit.expiresAt > this.now();
    });
    if (active.length >= 2) throw new Error('drain_required');
    const original = parseOriginalRequest(entry.originalRequestBytes);
    if (this.now() >= original.expiresAt) throw new Error('Offline request expired');
    const previous = entry.generations.at(-1)!;
    const previousDeposit = parseOfflineDiscoveryDepositV1(previous.depositBytes);
    if (previousDeposit.generationId === generationIdOf(options.index)) throw new Error('Invalid replacement generation');
    const sender = senderFromEntry(entry);
    const request = createOfflineDiscoveryRequestV1({
      requestNonce: decodeBytes(original.requestNonce),
      createdAt: original.createdAt,
      expiresAt: original.expiresAt,
      payload: original.payload,
      replyCapability: original.replyCapability,
      previousGenerationId: previousDeposit.generationId,
      previousEnvelopeId: previousDeposit.envelopeId,
    }, options.index, sender);
    if (request.requestId !== entry.requestId) throw new Error('Refreshed request changed logical identity');
    const generation: OfflineRequestGenerationStateV1 = {
      generationId: request.generationId,
      depositBytes: encryptedDeposit(request, sender),
      admission: structuredClone(options.admission),
      receipts: [],
      ackBytes: null,
    };
    this.snapshot.write({
      ...state,
      outbox: state.outbox.map(item => item.requestId === entry.requestId ? {
        ...item,
        generations: [...item.generations, generation],
        state: 'held',
        activeGenerationId: null,
      } : item),
    });
    return {
      requestId: request.requestId,
      generationId: request.generationId,
      depositBytes: generation.depositBytes,
      admission: structuredClone(options.admission),
      transportId: randomBytes(16).toString('base64url'),
    };
  }

  retry(requestId: string, generationId?: string): OfflineRequestDepositResultV1 {
    this.ensureOpen();
    const entry = this.findOutbox(this.snapshot.read(), requestId);
    const generation = generationId === undefined
      ? entry.generations.at(-1)!
      : entry.generations.find(item => item.generationId === generationId);
    if (!generation) throw new Error('Offline request generation not found');
    return {
      requestId,
      generationId: generation.generationId,
      depositBytes: generation.depositBytes,
      admission: structuredClone(generation.admission),
      transportId: randomBytes(16).toString('base64url'),
    };
  }

  beginSend(requestId: string, generationId: string): OfflineRequestDepositResultV1 {
    this.ensureOpen();
    const state = this.snapshot.read();
    const entry = this.findOutbox(state, requestId);
    const generation = entry.generations.find(item => item.generationId === generationId);
    if (!generation || generation.ackBytes) throw new Error('Offline request generation cannot be sent');
    if (this.now() >= parseOfflineDiscoveryDepositV1(generation.depositBytes).expiresAt) {
      throw new Error('Offline request expired');
    }
    this.snapshot.write({
      ...state,
      outbox: state.outbox.map(item => item.requestId === requestId
        ? { ...item, state: 'sending', activeGenerationId: generationId }
        : item),
    });
    return this.retry(requestId, generationId);
  }

  markOutcomeUnknown(requestId: string): void {
    this.ensureOpen();
    const state = this.snapshot.read();
    const entry = this.findOutbox(state, requestId);
    this.snapshot.write({
      ...state,
      outbox: state.outbox.map(item => item.requestId === requestId
        ? { ...item, state: 'outcome-unknown', activeGenerationId: null }
        : item),
    });
  }

  recordReceipt(requestId: string, receipt: OfflineDiscoveryReplicaReceiptV1): OfflineRequestDeliveryState {
    this.ensureOpen();
    if (!verifyOfflineDiscoveryReceiptV1(receipt)) throw new Error('Invalid offline replica receipt');
    const state = this.snapshot.read();
    const entry = this.findOutbox(state, requestId);
    const generation = entry.generations.find(item => item.generationId === receipt.generationId);
    if (!generation) throw new Error('Receipt generation not found');
    const deposit = parseOfflineDiscoveryDepositV1(generation.depositBytes);
    if (!verifyOfflineDiscoveryReceiptForDepositV1(receipt, deposit)
      || this.now() >= deposit.expiresAt
      || !entry.selectedRelayIds.includes(receipt.relayId)) throw new Error('Receipt is not selected for this deposit');
    const receipts = generation.receipts.some(item => item.relayId === receipt.relayId)
      ? generation.receipts
      : [...generation.receipts, receipt];
    const selected = new Set(receipts.map(item => item.relayId)).size;
    const nextState: OfflineRequestDeliveryState = selected >= 3 ? 'queued' : 'stored';
    this.snapshot.write({
      ...state,
      outbox: state.outbox.map(item => item.requestId === requestId ? {
        ...item,
        generations: item.generations.map(item => item.generationId === generation.generationId
          ? { ...item, receipts }
          : item),
        state: nextState,
        activeGenerationId: null,
      } : item),
    });
    return nextState;
  }

  receiveMany(raw: readonly string[], now: number): OfflineRequestReceiveResultV1[] {
    this.ensureOpen();
    return Array.from(new Set(raw)).sort().map(bytes => this.receive(bytes, now));
  }

  receive(raw: string, now: number): OfflineRequestReceiveResultV1 {
    this.ensureOpen();
    const deposit = parseOfflineDiscoveryDepositV1(raw);
    const state = this.snapshot.read();
    if (state.withdrawnLeases.includes(deposit.clientLeaseId)) throw new Error('Withdrawn mailbox generation');
    const retained = state.generations.find(item => item.generationId === deposit.generationId);
    if (!retained) throw new Error('Mailbox generation keys are unavailable');
    const indexOperation = parseLeasedIndexOperationV1(retained.indexBytes);
    if (indexOperation.kind !== 'leased-discovery-index') throw new Error('Withdrawn mailbox generation');
    const index = indexOperation;
    const request = decryptOfflineDiscoveryEnvelopeV1(deposit.envelope, {
      secretKey: decodeBytes(retained.mailboxSecretKey),
    });
    if (now >= request.expiresAt || request.generationId !== retained.generationId
      || request.publicationId !== index.publicationId
      || request.clientLeaseId !== index.clientLeaseId) throw new Error('Expired or mismatched offline request');
    const ackId = createOfflineDiscoveryAckIdV1(request);
    const existingAck = state.pendingAcks.find(bytes => parseOfflineDiscoveryAckV1(bytes).ackId === ackId);
    const duplicate = state.inbox.some(item => item.clientLeaseId === request.clientLeaseId
      && item.requestId === request.requestId);
    if (!duplicate) {
      const committed: OfflineInboxStateV1 = {
        clientLeaseId: request.clientLeaseId,
        requestId: request.requestId,
        requestBytes: JSON.stringify(request),
        committedAt: now,
      };
      this.snapshot.write({ ...state, inbox: [...state.inbox, committed] });
    }
    if (existingAck) return { status: duplicate ? 'duplicate' : 'committed', request, ackBytes: existingAck };
    const afterInbox = this.snapshot.read();
    const ack = createOfflineDiscoveryAckV1(request, index, keysFromGeneration(retained), now);
    const ackBytes = serializeOfflineDiscoveryAckV1(ack);
    this.snapshot.write({ ...afterInbox, pendingAcks: [...afterInbox.pendingAcks, ackBytes] });
    return { status: duplicate ? 'duplicate' : 'committed', request, ackBytes };
  }

  pendingAcks(): string[] {
    this.ensureOpen();
    return [...this.snapshot.read().pendingAcks];
  }

  recordGenerationAck(requestId: string, ackBytes: string): void {
    this.ensureOpen();
    const ack = parseOfflineDiscoveryAckV1(ackBytes);
    if (!verifyOfflineDiscoveryAckV1(ack) || ack.requestId !== requestId) throw new Error('Invalid generation ACK');
    const state = this.snapshot.read();
    const entry = this.findOutbox(state, requestId);
    const generation = entry.generations.find(item => item.generationId === ack.generationId);
    if (!generation) throw new Error('ACK generation not found');
    const deposit = parseOfflineDiscoveryDepositV1(generation.depositBytes);
    if (ack.envelopeId !== deposit.envelopeId || ack.requestExpiresAt !== deposit.expiresAt) {
      throw new Error('ACK does not match the exact deposit');
    }
    if (generation.ackBytes !== null && generation.ackBytes !== ackBytes) throw new Error('Conflicting generation ACK');
    const generations = entry.generations.map(item => item.generationId === ack.generationId
      ? { ...item, ackBytes }
      : item);
    this.snapshot.write({
      ...state,
      outbox: state.outbox.map(item => item.requestId === requestId ? {
        ...item,
        generations,
        state: generations.at(-1)!.ackBytes ? 'acknowledged' : 'held',
        activeGenerationId: null,
      } : item),
    });
  }

  markAcknowledged(ackBytes: string): void {
    this.ensureOpen();
    const ack = parseOfflineDiscoveryAckV1(ackBytes);
    const state = this.snapshot.read();
    if (!state.pendingAcks.includes(ackBytes)) throw new Error('Unknown pending ACK');
    this.snapshot.write({
      ...state,
      pendingAcks: state.pendingAcks.filter(item => item !== ackBytes),
      outbox: state.outbox.map(entry => entry.requestId === ack.requestId ? {
        ...entry,
        state: 'acknowledged',
        activeGenerationId: null,
        generations: entry.generations.map(generation => generation.generationId === ack.generationId
          ? { ...generation, ackBytes }
          : generation),
      } : entry),
    });
  }

  listOutbox(): OfflineRequestOutboxStateV1[] {
    this.ensureOpen();
    return structuredClone(this.snapshot.read().outbox);
  }

  listInbox(): OfflineInboxStateV1[] {
    this.ensureOpen();
    return structuredClone(this.snapshot.read().inbox);
  }

  withdraw(clientLeaseId: string): void {
    this.ensureOpen();
    const state = this.snapshot.read();
    if (!state.withdrawnLeases.includes(clientLeaseId)) {
      this.snapshot.write({ ...state, withdrawnLeases: [...state.withdrawnLeases, clientLeaseId] });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.snapshot.close();
  }

  private findOutbox(state: OfflineRequestLocalStateV1, requestId: string): OfflineRequestOutboxStateV1 {
    const entry = state.outbox.find(item => item.requestId === requestId);
    if (!entry) throw new Error('Offline request not found');
    return entry;
  }

  private expire(now: number): void {
    const state = this.snapshot.read();
    this.snapshot.write({
      ...state,
      outbox: state.outbox.map(entry => {
        const latest = entry.generations.at(-1)!;
        const deposit = parseOfflineDiscoveryDepositV1(latest.depositBytes);
        return deposit.expiresAt <= now && entry.state !== 'acknowledged'
          ? { ...entry, state: 'expired' as const, activeGenerationId: null }
          : entry;
      }),
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Offline request store is closed');
  }
}

function encryptedDeposit(request: OfflineDiscoveryRequestV1, sender: ReturnType<typeof generateSigningKeyPair>): string {
  const envelope = encryptOfflineDiscoveryRequestV1(request);
  return serializeOfflineDiscoveryDepositV1(createOfflineDiscoveryDepositV1(envelope, request, sender));
}

function generationIdOf(index: LeasedIndexV1): string {
  return createLeasedIndexGenerationIdV1(index);
}

function parseOriginalRequest(raw: string): OfflineDiscoveryRequestV1 {
  const value = JSON.parse(raw) as unknown;
  if (!verifyOfflineDiscoveryRequestV1(value)) throw new Error('Invalid retained original request');
  return value;
}

function senderFromEntry(entry: OfflineRequestOutboxStateV1): ReturnType<typeof generateSigningKeyPair> {
  const secretKey = decodeBytes(entry.senderSecretKey);
  return { secretKey, publicKey: secretKey.slice(32) };
}

function keysFromGeneration(generation: OfflineMailboxGenerationStateV1): LeasedIndexKeyMaterialV1 {
  const index = parseLeasedIndexOperationV1(generation.indexBytes);
  if (index.kind !== 'leased-discovery-index') throw new Error('Invalid retained generation');
  return {
    publicationId: index.publicationId,
    clientLeaseId: index.clientLeaseId,
    mailboxId: index.mailbox.id,
    signingKeyPair: {
      publicKey: decodeBytes(generation.signingPublicKey),
      secretKey: decodeBytes(generation.signingSecretKey),
    },
    mailboxKeyPair: {
      publicKey: decodeBytes(generation.mailboxPublicKey),
      secretKey: decodeBytes(generation.mailboxSecretKey),
    },
  };
}

function bytesToString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64url'));
}

function isLocalState(value: unknown): value is OfflineRequestLocalStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'generations,inbox,outbox,pendingAcks,version,withdrawnLeases') return false;
  const state = value as OfflineRequestLocalStateV1;
  if (state.version !== 1 || !Array.isArray(state.outbox) || state.outbox.length > MAX_OUTBOX_ENTRIES
    || !Array.isArray(state.inbox) || !Array.isArray(state.pendingAcks) || !Array.isArray(state.generations)
    || !Array.isArray(state.withdrawnLeases)
    || new Set(state.withdrawnLeases).size !== state.withdrawnLeases.length) return false;
  try {
    const requestIds = new Set<string>();
    for (const entry of state.outbox) {
      if (!entry || typeof entry !== 'object' || requestIds.has(entry.requestId)
        || !Array.isArray(entry.generations) || entry.generations.length < 1
        || !Array.isArray(entry.selectedRelayIds) || entry.selectedRelayIds.length < 1
        || entry.selectedRelayIds.length > 5
        || !['held', 'sending', 'stored', 'queued', 'outcome-unknown', 'acknowledged', 'expired'].includes(entry.state)
        || typeof entry.senderSecretKey !== 'string' || decodeBytes(entry.senderSecretKey).length !== 64
        || parseOriginalRequest(entry.originalRequestBytes).requestId !== entry.requestId) return false;
      requestIds.add(entry.requestId);
      const generations = new Set<string>();
      for (const generation of entry.generations) {
        const deposit = parseOfflineDiscoveryDepositV1(generation.depositBytes);
        if (generations.has(generation.generationId) || deposit.generationId !== generation.generationId
          || deposit.requestId !== entry.requestId || !Array.isArray(generation.receipts)
          || generation.receipts.length > 5
          || !generation.receipts.every(receipt => verifyOfflineDiscoveryReceiptForDepositV1(receipt, deposit))
          || (generation.ackBytes !== null && !verifyOfflineDiscoveryAckV1(parseOfflineDiscoveryAckV1(generation.ackBytes)))) return false;
        generations.add(generation.generationId);
      }
    }
    const inboxKeys = new Set<string>();
    for (const item of state.inbox) {
      const key = `${item.clientLeaseId}\n${item.requestId}`;
      if (inboxKeys.has(key) || parseOriginalRequest(item.requestBytes).requestId !== item.requestId) return false;
      inboxKeys.add(key);
    }
    for (const generation of state.generations) {
      if (typeof generation.indexBytes !== 'string'
        || decodeBytes(generation.mailboxSecretKey).length !== 32
        || decodeBytes(generation.signingSecretKey).length !== 64) return false;
      const index = parseLeasedIndexOperationV1(generation.indexBytes);
      if (index.kind !== 'leased-discovery-index'
        || generation.generationId !== generationIdOf(index)) return false;
    }
    return new Set(state.pendingAcks).size === state.pendingAcks.length
      && state.pendingAcks.every(bytes => {
        const ack = parseOfflineDiscoveryAckV1(bytes);
        return verifyOfflineDiscoveryAckV1(ack) && state.inbox.some(item => (
          item.clientLeaseId === ack.clientLeaseId && item.requestId === ack.requestId
        ));
      });
  } catch {
    return false;
  }
}
