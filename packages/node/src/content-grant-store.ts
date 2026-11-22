import {
  createContentChannelOperationV2,
  createContentGrantV1,
  createContentRequestV1,
  createContentResponseV1,
  createLeasedIndexGenerationIdV1,
  decryptContentChannelOperationV2,
  encodeBase64,
  parseContentChannelOperationV2,
  serializeContentChannelOperationV2,
  verifyContentRequestV1,
  verifyContentGrantV1,
  verifyContentResponseForRequestV1,
  verifyContentResponseV1,
  verifyLeasedIndexV1,
  verifyOriginalCommitmentV1,
  type ContentGrantV1,
  type ContentRequestV1,
  type ContentResponseV1,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
  type RelationshipKeyMaterial,
} from '@resonance/core';
import { openEncryptedLocalState } from './encrypted-local-state.js';

const MAX_LOCAL_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_RECORDS = 64;

type DeliveryState = 'held' | 'sending' | 'outcome-unknown' | 'completed' | 'superseded' | 'expired';
type GrantState = 'active' | 'sending' | 'outcome-unknown' | 'used' | 'denied';

export interface ContentChannelContextV1 {
  channelId: string;
  localPublicationId: string;
  partnerPublicationId: string;
  localRelationshipKeys: RelationshipKeyMaterial;
  publicationKeys: LeasedIndexKeyMaterialV1;
  partnerRelationshipId: string;
  partnerRelationshipKey: string;
  sharedKey: Uint8Array;
}

interface StoredKeyPair {
  publicKey: string;
  secretKey: string;
}

interface StoredRelationshipKeys {
  relationshipId: string;
  signingKeyPair: StoredKeyPair;
  channelKeyPair: StoredKeyPair;
  mailboxId: string;
  mailboxKeyPair: StoredKeyPair;
}

interface StoredPublicationKeys {
  publicationId: string;
  clientLeaseId: string;
  mailboxId: string;
  signingKeyPair: StoredKeyPair;
  mailboxKeyPair: StoredKeyPair;
}

interface StoredChannelContext {
  channelId: string;
  localPublicationId: string;
  partnerPublicationId: string;
  localRelationshipKeys: StoredRelationshipKeys;
  publicationKeys: StoredPublicationKeys;
  partnerRelationshipId: string;
  partnerRelationshipKey: string;
  sharedKey: string;
}

interface StoredChannel {
  context: StoredChannelContext;
  consentActive: boolean;
  nextOutboundSequence: number;
  lastInboundSequence: number;
}

interface ResolvedChannel extends Omit<StoredChannel, 'context'> {
  context: ContentChannelContextV1;
}

interface StoredOriginal {
  publicationId: string;
  generationId: string;
  indexBytes: string;
  originalBytes: string;
  commitmentKey: string;
  withdrawn: boolean;
}

interface StoredRequest {
  requestBytes: string;
  channelId: string;
  direction: 'outbound' | 'inbound';
  state: DeliveryState;
  pendingOperationBytes: string | null;
  responseBytes: string | null;
}

interface StoredGrant {
  grantBytes: string;
  requestBytes: string;
  state: GrantState;
  responseBytes: string | null;
  pendingOperationBytes: string | null;
}

interface ReceivedOperation {
  operationId: string;
  channelId: string;
  responseBytes: string | null;
}

interface ContentState {
  version: 1;
  channels: StoredChannel[];
  originals: StoredOriginal[];
  requests: StoredRequest[];
  grants: StoredGrant[];
  receivedOperations: ReceivedOperation[];
}

interface Snapshot {
  read(): ContentState;
  write(value: ContentState): void;
  close(): void;
}

export interface ContentOperationPreparationV1 {
  operationBytes: string;
  state: DeliveryState | GrantState;
}

export interface ContentGrantResultV1 {
  status: 'granted' | 'duplicate' | 'superseded';
  grantId?: string;
}

export interface ContentReceiptResultV1 {
  status: 'received' | 'duplicate';
  requestId: string;
  originalBytes?: Uint8Array;
}

export class ContentGrantStore {
  private readonly now: () => number;
  private closed = false;

  private constructor(private readonly snapshot: Snapshot, now: () => number) {
    this.now = now;
    const state = snapshot.read();
    const requests = state.requests.map(request => request.state === 'sending'
      ? { ...request, state: 'outcome-unknown' as const }
      : request);
    const grants = state.grants.map(grant => grant.state === 'sending'
      ? { ...grant, state: 'outcome-unknown' as const }
      : grant);
    if (requests.some((entry, index) => entry !== state.requests[index])
      || grants.some((entry, index) => entry !== state.grants[index])) {
      snapshot.write({ ...state, requests, grants });
    }
  }

  static open(options: {
    path: string;
    encryptionKey: Uint8Array;
    now?: () => number;
  }): ContentGrantStore {
    const snapshot = openEncryptedLocalState<ContentState>({
      path: options.path,
      key: options.encryptionKey,
      domain: 'resonance:content-grant-store:v1',
      maxBytes: MAX_LOCAL_BYTES,
      initial: {
        version: 1,
        channels: [],
        originals: [],
        requests: [],
        grants: [],
        receivedOperations: [],
      },
      validate: isContentState,
    });
    return new ContentGrantStore(snapshot, options.now ?? Date.now);
  }

  registerChannel(context: ContentChannelContextV1): void {
    this.ensureOpen();
    validateChannelContext(context);
    const state = this.snapshot.read();
    const existing = state.channels.find(channel => channel.context.channelId === context.channelId);
    if (existing) {
      if (JSON.stringify(existing.context) !== JSON.stringify(encodeContext(context))) {
        throw new Error('Channel identity changed');
      }
      return;
    }
    this.snapshot.write({
      ...state,
      channels: [...state.channels, {
        context: encodeContext(context),
        consentActive: true,
        nextOutboundSequence: 0,
        lastInboundSequence: -1,
      }],
    });
  }

  setConsent(channelId: string, active: boolean): void {
    this.ensureOpen();
    const state = this.snapshot.read();
    this.channel(state, channelId);
    this.snapshot.write({
      ...state,
      channels: state.channels.map(channel => channel.context.channelId === channelId
        ? { ...channel, consentActive: active }
        : channel),
    });
  }

  retainOriginal(index: LeasedIndexV1, originalBytes: Uint8Array, commitmentKey: Uint8Array): void {
    this.ensureOpen();
    if (!verifyLeasedIndexV1(index)
      || !verifyOriginalCommitmentV1(originalBytes, commitmentKey, index.original.commitment)) {
      throw new Error('Invalid retained original');
    }
    const state = this.snapshot.read();
    const generationId = createLeasedIndexGenerationIdV1(index);
    const existing = state.originals.find(original => original.generationId === generationId);
    if (existing) {
      if (existing.originalBytes !== encodeBase64(originalBytes)
        || existing.commitmentKey !== encodeBase64(commitmentKey)) throw new Error('Original generation conflict');
      return;
    }
    this.snapshot.write({
      ...state,
      originals: [...state.originals, {
        publicationId: index.publicationId,
        generationId,
        indexBytes: JSON.stringify(index),
        originalBytes: encodeBase64(originalBytes),
        commitmentKey: encodeBase64(commitmentKey),
        withdrawn: false,
      }],
    });
  }

  withdrawPublication(publicationId: string): void {
    this.ensureOpen();
    const state = this.snapshot.read();
    this.snapshot.write({
      ...state,
      originals: state.originals.map(original => original.publicationId === publicationId
        ? { ...original, withdrawn: true }
        : original),
      grants: state.grants.map(grant => {
        const parsed = parseGrant(grant.grantBytes);
        return parsed.publicationId === publicationId && grant.state !== 'used'
          ? { ...grant, state: 'denied' as const, pendingOperationBytes: null }
          : grant;
      }),
    });
  }

  createRequest(input: {
    channelId: string;
    index: LeasedIndexV1;
    createdAt: number;
    expiresAt: number;
  }): string {
    this.ensureOpen();
    const state = this.snapshot.read();
    const channel = this.usableChannel(state, input.channelId);
    const request = createContentRequestV1({
      channelId: input.channelId,
      requesterRelationshipId: channel.context.localRelationshipKeys.relationshipId,
      index: input.index,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    }, channel.context.publicationKeys);
    if (input.index.publicationId !== channel.context.partnerPublicationId) {
      throw new Error('Content request targets a different channel counterparty');
    }
    if (state.requests.some(existing => parseRequest(existing.requestBytes).requestId === request.requestId)) {
      throw new Error('Content request already exists');
    }
    if (state.requests.length >= MAX_CONTENT_RECORDS) throw new Error('Content request store is full');
    const requestBytes = JSON.stringify(request);
    this.snapshot.write({
      ...state,
      requests: [...state.requests, {
        requestBytes,
        channelId: input.channelId,
        direction: 'outbound',
        state: 'held',
        pendingOperationBytes: null,
        responseBytes: null,
      }],
    });
    return request.requestId;
  }

  prepareRequest(requestId: string): ContentOperationPreparationV1 {
    this.ensureOpen();
    const state = this.snapshot.read();
    const request = this.request(state, requestId, 'outbound');
    if (request.pendingOperationBytes) {
      return { operationBytes: request.pendingOperationBytes, state: request.state };
    }
    const parsed = parseRequest(request.requestBytes);
    if (this.now() >= parsed.expiresAt) throw new Error('Content request expired');
    const channel = this.usableChannel(state, request.channelId);
    const operation = createContentChannelOperationV2({
      record: parsed,
      recipientRelationshipId: channel.context.partnerRelationshipId,
      sequence: channel.nextOutboundSequence,
      sharedKey: channel.context.sharedKey,
      relationshipKeys: channel.context.localRelationshipKeys,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    });
    const operationBytes = serializeContentChannelOperationV2(operation);
    this.snapshot.write({
      ...state,
      requests: state.requests.map(item => item === request ? {
        ...item,
        state: 'sending',
        pendingOperationBytes: operationBytes,
      } : item),
      channels: state.channels.map(item => item.context.channelId === channel.context.channelId
        ? { ...item, nextOutboundSequence: item.nextOutboundSequence + 1 }
        : item),
    });
    return { operationBytes, state: 'sending' };
  }

  markRequestSent(requestId: string): void {
    this.ensureOpen();
    const state = this.snapshot.read();
    const request = this.request(state, requestId, 'outbound');
    if (!request.pendingOperationBytes) throw new Error('No pending content request');
    this.snapshot.write({
      ...state,
      requests: state.requests.map(item => item === request
        ? { ...item, state: 'held' }
        : item),
    });
  }

  receiveRequest(raw: string, now: number): ContentReceiptResultV1 {
    this.ensureOpen();
    const { operation, record, state, channel } = this.receiveRecord(raw, now);
    if (record.kind !== 'content-request') throw new Error('Expected content request');
    if (record.publicationId !== channel.context.localPublicationId
      || record.requesterPublicationId !== channel.context.partnerPublicationId
      || record.requesterRelationshipId !== channel.context.partnerRelationshipId) {
      throw new Error('Content request counterparty mismatch');
    }
    const existingOperation = state.receivedOperations.find(item => item.operationId === operation.messageId);
    if (existingOperation) return { status: 'duplicate', requestId: record.requestId };
    if (operation.sequence !== channel.lastInboundSequence + 1) throw new Error('Unexpected content request sequence');
    const requestBytes = JSON.stringify(record);
    this.snapshot.write({
      ...state,
      requests: [...state.requests, {
        requestBytes,
        channelId: record.channelId,
        direction: 'inbound',
        state: 'held',
        pendingOperationBytes: null,
        responseBytes: null,
      }],
      channels: state.channels.map(item => item.context.channelId === channel.context.channelId
        ? { ...item, lastInboundSequence: operation.sequence }
        : item),
      receivedOperations: [...state.receivedOperations, {
        operationId: operation.messageId,
        channelId: record.channelId,
        responseBytes: null,
      }],
    });
    return { status: 'received', requestId: record.requestId };
  }

  grantRequest(input: {
    requestId: string;
    createdAt: number;
    expiresAt: number;
    allowSuperseded?: boolean;
  }): ContentGrantResultV1 {
    this.ensureOpen();
    const state = this.snapshot.read();
    const request = this.request(state, input.requestId, 'inbound');
    const parsedRequest = parseRequest(request.requestBytes);
    const channel = this.usableChannel(state, request.channelId);
    const original = this.original(state, parsedRequest.publicationId, parsedRequest.generationId);
    if (!original || original.withdrawn) throw new Error('Original is unavailable or withdrawn');
    const current = currentOriginal(state, parsedRequest.publicationId);
    if (current?.generationId !== original.generationId && !input.allowSuperseded) {
      this.snapshot.write({
        ...state,
        requests: state.requests.map(item => item === request
          ? { ...item, state: 'superseded' }
          : item),
      });
      return { status: 'superseded' };
    }
    const existing = state.grants.find(grant => parseGrant(grant.grantBytes).requestId === input.requestId);
    if (existing) return { status: 'duplicate', grantId: parseGrant(existing.grantBytes).grantId };
    const index = parseIndex(original.indexBytes);
    if (this.now() >= input.expiresAt) throw new Error('Content grant expired');
    const grant = createContentGrantV1(
      parsedRequest,
      index,
      channel.context.publicationKeys,
      input.createdAt,
      input.expiresAt,
    );
    this.snapshot.write({
      ...state,
      grants: [...state.grants, {
        grantBytes: JSON.stringify(grant),
        requestBytes: request.requestBytes,
        state: 'active',
        responseBytes: null,
        pendingOperationBytes: null,
      }],
    });
    return { status: 'granted', grantId: grant.grantId };
  }

  prepareResponse(grantId: string): ContentOperationPreparationV1 {
    this.ensureOpen();
    const state = this.snapshot.read();
    const grant = this.grant(state, grantId);
    if (grant.pendingOperationBytes) {
      return { operationBytes: grant.pendingOperationBytes, state: grant.state };
    }
    if (grant.state !== 'active') throw new Error('Content grant is not active');
    const parsedGrant = parseGrant(grant.grantBytes);
    const request = this.request(state, parsedGrant.requestId, 'inbound');
    const channel = this.usableChannel(state, request.channelId);
    const original = this.original(state, parsedGrant.publicationId, parsedGrant.generationId);
    if (!original || original.withdrawn || this.now() >= parsedGrant.expiresAt) {
      throw new Error('Withdrawn, expired, or missing original cannot be transmitted');
    }
    const response = createContentResponseV1({
      grant: parsedGrant,
      index: parseIndex(original.indexBytes),
      originalBytes: decodeBase64(original.originalBytes),
      commitmentKey: decodeBase64(original.commitmentKey),
      owner: channel.context.publicationKeys,
      createdAt: this.now(),
    });
    if (response.createdAt < parsedGrant.createdAt) throw new Error('Response predates grant');
    const operation = createContentChannelOperationV2({
      record: response,
      recipientRelationshipId: channel.context.partnerRelationshipId,
      sequence: channel.nextOutboundSequence,
      sharedKey: channel.context.sharedKey,
      relationshipKeys: channel.context.localRelationshipKeys,
      createdAt: response.createdAt,
      expiresAt: response.expiresAt,
    });
    const operationBytes = serializeContentChannelOperationV2(operation);
    this.snapshot.write({
      ...state,
      grants: state.grants.map(item => item === grant ? {
        ...item,
        state: 'sending',
        responseBytes: JSON.stringify(response),
        pendingOperationBytes: operationBytes,
      } : item),
      channels: state.channels.map(item => item.context.channelId === channel.context.channelId
        ? { ...item, nextOutboundSequence: item.nextOutboundSequence + 1 }
        : item),
    });
    return { operationBytes, state: 'sending' };
  }

  markResponseSent(grantId: string): void {
    this.ensureOpen();
    const state = this.snapshot.read();
    const grant = this.grant(state, grantId);
    if (!grant.pendingOperationBytes || !['sending', 'outcome-unknown'].includes(grant.state)) {
      throw new Error('No uncertain content response');
    }
    this.snapshot.write({
      ...state,
      grants: state.grants.map(item => item === grant
        ? { ...item, state: 'used', pendingOperationBytes: null }
        : item),
    });
  }

  receiveResponse(raw: string, now: number): ContentReceiptResultV1 {
    this.ensureOpen();
    const { operation, record, state, channel } = this.receiveRecord(raw, now);
    if (record.kind !== 'content-response') throw new Error('Expected content response');
    const request = this.request(state, record.requestId, 'outbound');
    const parsedRequest = parseRequest(request.requestBytes);
    if (record.publicationId !== channel.context.partnerPublicationId
      || record.requesterPublicationId !== channel.context.localPublicationId
      || !verifyContentResponseForRequestV1(record, parsedRequest)) {
      throw new Error('Content response does not verify against request and channel');
    }
    const existingOperation = state.receivedOperations.find(item => item.operationId === operation.messageId);
    if (existingOperation) {
      return {
        status: 'duplicate',
        requestId: record.requestId,
        originalBytes: existingOperation.responseBytes
          ? decodeBase64(parseResponse(existingOperation.responseBytes).originalBytes)
          : undefined,
      };
    }
    if (operation.sequence !== channel.lastInboundSequence + 1) throw new Error('Unexpected content response sequence');
    const responseBytes = JSON.stringify(record);
    this.snapshot.write({
      ...state,
      requests: state.requests.map(item => item === request
        ? { ...item, state: 'completed', responseBytes, pendingOperationBytes: null }
        : item),
      channels: state.channels.map(item => item.context.channelId === channel.context.channelId
        ? { ...item, lastInboundSequence: operation.sequence }
        : item),
      receivedOperations: [...state.receivedOperations, {
        operationId: operation.messageId,
        channelId: record.channelId,
        responseBytes,
      }],
    });
    return {
      status: 'received',
      requestId: record.requestId,
      originalBytes: decodeBase64(record.originalBytes),
    };
  }

  receivedContent(requestId: string): Uint8Array | undefined {
    this.ensureOpen();
    const state = this.snapshot.read();
    const request = this.request(state, requestId, 'outbound');
    if (request.state !== 'completed' || !request.responseBytes) return undefined;
    const response = parseResponse(request.responseBytes);
    if (!verifyContentResponseV1(response)) throw new Error('Stored content response is invalid');
    return decodeBase64(response.originalBytes);
  }

  requestState(requestId: string): DeliveryState {
    return this.request(this.snapshot.read(), requestId, undefined).state;
  }

  grantState(grantId: string): GrantState {
    return this.grant(this.snapshot.read(), grantId).state;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.snapshot.close();
  }

  private receiveRecord(raw: string, now: number) {
    const operation = parseContentChannelOperationV2(raw);
    const state = this.snapshot.read();
    const channel = this.usableChannel(state, operation.channelId);
    if (operation.senderRelationshipId !== channel.context.partnerRelationshipId
      || operation.senderRelationshipKey !== channel.context.partnerRelationshipKey
      || operation.recipientRelationshipId !== channel.context.localRelationshipKeys.relationshipId) {
      throw new Error('Content channel counterparty mismatch');
    }
    const record = decryptContentChannelOperationV2(operation, channel.context.sharedKey);
    if (now >= record.expiresAt) throw new Error('Content record expired');
    return { operation, record, state, channel };
  }

  private usableChannel(state: ContentState, channelId: string): ResolvedChannel {
    const channel = this.channel(state, channelId);
    if (!channel.consentActive) throw new Error('Relationship channel or current consent is inactive');
    return channel;
  }

  private channel(state: ContentState, channelId: string): ResolvedChannel {
    const channel = state.channels.find(item => item.context.channelId === channelId);
    if (!channel) throw new Error('Content channel not found');
    return { ...channel, context: decodeContext(channel.context) };
  }

  private request(
    state: ContentState,
    requestId: string,
    direction: 'outbound' | 'inbound' | undefined,
  ): StoredRequest {
    const request = state.requests.find(item => parseRequest(item.requestBytes).requestId === requestId
      && (!direction || item.direction === direction));
    if (!request) throw new Error('Content request not found');
    return request;
  }

  private grant(state: ContentState, grantId: string): StoredGrant {
    const grant = state.grants.find(item => parseGrant(item.grantBytes).grantId === grantId);
    if (!grant) throw new Error('Content grant not found');
    return grant;
  }

  private original(state: ContentState, publicationId: string, generationId: string): StoredOriginal | undefined {
    return state.originals.find(item => item.publicationId === publicationId
      && item.generationId === generationId);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Content grant store is closed');
  }
}

function currentOriginal(state: ContentState, publicationId: string): StoredOriginal | undefined {
  return state.originals.filter(original => original.publicationId === publicationId)
    .sort((a, b) => parseIndex(b.indexBytes).leaseSequence - parseIndex(a.indexBytes).leaseSequence)[0];
}

function encodeContext(context: ContentChannelContextV1): StoredChannelContext {
  return {
    channelId: context.channelId,
    localPublicationId: context.localPublicationId,
    partnerPublicationId: context.partnerPublicationId,
    localRelationshipKeys: {
      relationshipId: context.localRelationshipKeys.relationshipId,
      signingKeyPair: encodeKeyPair(context.localRelationshipKeys.signingKeyPair),
      channelKeyPair: encodeKeyPair(context.localRelationshipKeys.channelKeyPair),
      mailboxId: context.localRelationshipKeys.mailboxId,
      mailboxKeyPair: encodeKeyPair(context.localRelationshipKeys.mailboxKeyPair),
    },
    publicationKeys: {
      publicationId: context.publicationKeys.publicationId,
      clientLeaseId: context.publicationKeys.clientLeaseId,
      mailboxId: context.publicationKeys.mailboxId,
      signingKeyPair: encodeKeyPair(context.publicationKeys.signingKeyPair),
      mailboxKeyPair: encodeKeyPair(context.publicationKeys.mailboxKeyPair),
    },
    partnerRelationshipId: context.partnerRelationshipId,
    partnerRelationshipKey: context.partnerRelationshipKey,
    sharedKey: encodeBase64(context.sharedKey),
  };
}

function decodeContext(context: StoredChannelContext): ContentChannelContextV1 {
  return {
    channelId: context.channelId,
    localPublicationId: context.localPublicationId,
    partnerPublicationId: context.partnerPublicationId,
    localRelationshipKeys: {
      relationshipId: context.localRelationshipKeys.relationshipId,
      signingKeyPair: decodeKeyPair(context.localRelationshipKeys.signingKeyPair),
      channelKeyPair: decodeKeyPair(context.localRelationshipKeys.channelKeyPair),
      mailboxId: context.localRelationshipKeys.mailboxId,
      mailboxKeyPair: decodeKeyPair(context.localRelationshipKeys.mailboxKeyPair),
    },
    publicationKeys: {
      publicationId: context.publicationKeys.publicationId,
      clientLeaseId: context.publicationKeys.clientLeaseId,
      mailboxId: context.publicationKeys.mailboxId,
      signingKeyPair: decodeKeyPair(context.publicationKeys.signingKeyPair),
      mailboxKeyPair: decodeKeyPair(context.publicationKeys.mailboxKeyPair),
    },
    partnerRelationshipId: context.partnerRelationshipId,
    partnerRelationshipKey: context.partnerRelationshipKey,
    sharedKey: decodeBase64(context.sharedKey),
  };
}

function encodeKeyPair(keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }): StoredKeyPair {
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}

function decodeKeyPair(keyPair: StoredKeyPair): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return { publicKey: decodeBase64(keyPair.publicKey), secretKey: decodeBase64(keyPair.secretKey) };
}

function validateChannelContext(context: ContentChannelContextV1): void {
  if (!context || typeof context !== 'object'
    || context.localPublicationId !== context.publicationKeys.publicationId
    || context.localRelationshipKeys.relationshipId.length === 0
    || context.partnerRelationshipId.length === 0
    || context.partnerRelationshipKey.length === 0
    || context.sharedKey.length !== 32) throw new Error('Invalid content channel context');
}

function isContentState(value: unknown): value is ContentState {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'channels,grants,originals,receivedOperations,requests,version') return false;
  const state = value as ContentState;
  if (state.version !== 1 || !Array.isArray(state.channels) || !Array.isArray(state.originals)
    || !Array.isArray(state.requests) || state.requests.length > MAX_CONTENT_RECORDS
    || !Array.isArray(state.grants) || state.grants.length > MAX_CONTENT_RECORDS
    || !Array.isArray(state.receivedOperations)) return false;
  try {
    for (const channel of state.channels) {
      validateChannelContext(decodeContext(channel.context));
      if (!Number.isSafeInteger(channel.nextOutboundSequence) || channel.nextOutboundSequence < 0
        || !Number.isSafeInteger(channel.lastInboundSequence) || channel.lastInboundSequence < -1
        || typeof channel.consentActive !== 'boolean') return false;
    }
    const generations = new Set<string>();
    for (const original of state.originals) {
      const index = parseIndex(original.indexBytes);
      const generationId = createLeasedIndexGenerationIdV1(index);
      if (generations.has(generationId) || original.generationId !== generationId
        || original.publicationId !== index.publicationId
        || !verifyOriginalCommitmentV1(
          decodeBase64(original.originalBytes),
          decodeBase64(original.commitmentKey),
          index.original.commitment,
        )) return false;
      generations.add(generationId);
    }
    const requestIds = new Set<string>();
    for (const request of state.requests) {
      const parsed = parseRequest(request.requestBytes);
      const key = `${request.direction}:${parsed.requestId}`;
      if (requestIds.has(key) || !['held', 'sending', 'outcome-unknown', 'completed', 'superseded', 'expired'].includes(request.state)
        || (request.responseBytes !== null && !verifyContentResponseV1(parseResponse(request.responseBytes)))) return false;
      requestIds.add(key);
    }
    const grantIds = new Set<string>();
    for (const grant of state.grants) {
      const parsed = parseGrant(grant.grantBytes);
      if (grantIds.has(parsed.grantId) || !['active', 'sending', 'outcome-unknown', 'used', 'denied'].includes(grant.state)
        || (grant.responseBytes !== null && !verifyContentResponseV1(parseResponse(grant.responseBytes)))) return false;
      grantIds.add(parsed.grantId);
    }
    return state.receivedOperations.every(operation => typeof operation.operationId === 'string'
      && (operation.responseBytes === null || verifyContentResponseV1(parseResponse(operation.responseBytes))));
  } catch {
    return false;
  }
}

function parseRequest(bytes: string): ContentRequestV1 {
  const value = JSON.parse(bytes) as unknown;
  if (!verifyContentRequestV1(value)) throw new Error('Invalid stored content request');
  return value;
}

function parseGrant(bytes: string): ContentGrantV1 {
  const value = JSON.parse(bytes) as unknown;
  if (!verifyContentGrantV1(value)) throw new Error('Invalid stored content grant');
  return value;
}

function parseResponse(bytes: string): ContentResponseV1 {
  const value = JSON.parse(bytes) as unknown;
  if (!verifyContentResponseV1(value)) throw new Error('Invalid stored content response');
  return value;
}

function parseIndex(bytes: string): LeasedIndexV1 {
  const value = JSON.parse(bytes) as unknown;
  if (!verifyLeasedIndexV1(value)) throw new Error('Invalid stored content index');
  return value;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}
