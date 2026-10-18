/**
 * WebSocket client for connecting a personal node to a relay server.
 */

import WebSocket from 'ws';
import { parseRelayAcknowledgement, parseRelayMailbox } from './relay-response.js';
import { createPrivateRelayClient } from './private-relay-client.js';
import type { PrivateTrafficScheduleOptions } from './private-traffic-scheduler.js';
import type { AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import type { WalletPolicyObservation } from './wallet-policy-freshness.js';
import {
  assertSecureRelayTransportEndpoint, relayTlsClientOptions,
  MAX_SIGNED_MESSAGE_BYTES,
  MessageTypes,
  MAILBOX_RESPONSE_MESSAGE_TYPE,
  SEARCH_RESPONSE_MESSAGE_TYPE,
  createAdmissionRequestBindingV2,
  createMailboxDepositFrame,
  createMailboxDepositRequest,
  createMailboxRequest,
  createMailboxRequestFrame,
  createPublicationOperationFrame,
  createSearchRequestFrameV2,
  createSearchRequestV2,
  createRelationshipMailboxDepositFrameV2,
  createRelationshipMailboxDepositV2,
  createRelationshipMailboxRequestFrameV2,
  createRelationshipMailboxRequestV2,
  decryptMatchNotice,
  decryptRelationshipMessage,
  serializeMailboxDepositFrame,
  serializeMailboxRequestFrame,
  serializePublicationOperationFrame,
  serializeSearchRequestFrameV2,
  serializeRelationshipMailboxDepositFrameV2,
  serializeRelationshipMailboxRequestFrameV2,
  parseMessage,
  verifyMessage,
  verifySearchResponsePayloadV2,
  type Identity,
  type Message,
  type AckPayload,
  type AdmissionCapabilityV2,
  type EncryptedMailboxEnvelope,
  type MailboxDepositRequest,
  type MailboxRequest,
  type MailboxResponsePayload,
  type MatchNoticePayload,
  type RelationshipMessageV2,
  type RelationshipKeyMaterial,
  type RelationshipMailboxDepositV2,
  type RelationshipMailboxRequestV2,
  type PublicationKeyMaterial,
  type PublicationMailboxRecipient,
  type PublicationOperation,
  type PublicationRecord,
  type RelayAdmissionActionV2,
  type SearchPayload,
  type SearchResultsPayload,
  type CreateSearchRequestInputV2,
  type SearchRequestV2,
  type SearchResponsePayloadV2,
  type ConsentPayload,
  type MatchPayload,
  type ConsentForwardPayload,
  type ChannelMessagePayload,
  type ChannelForwardPayload,
} from '@resonance/core';

export interface RelayClientConfig {
  relayUrl: string;
  /** Deprecated compatibility input; never transmitted by protocol v2. */
  identity?: Identity;
  /** Additional relay URLs to try if primary fails. */
  fallbackUrls?: string[];
  /** Explicit entry relays for private mode; destination URLs stay separate. */
  privateEntryUrls?: string[];
  /** Bounded batch release and timing jitter for experimental private mode. */
  privateTraffic?: PrivateTrafficScheduleOptions;
  /** Deprecated compatibility input; v2 uses a short connection per operation. */
  autoReconnect?: boolean;
  /** Supplies an unlinkable capability for each exact v2 relay request. */
  admissionCapabilityProvider?: AdmissionCapabilityProviderV2;
}

function openRelaySocket(url: string): WebSocket {
  assertSecureRelayTransportEndpoint(url);
  return new WebSocket(url, { ...relayTlsClientOptions,
    handshakeTimeout: 10_000,
    maxPayload: MAX_SIGNED_MESSAGE_BYTES,
    followRedirects: false,
    perMessageDeflate: false,
  });
}

export interface AdmissionCapabilityRequestContextV2 {
  relayUrl: string;
  action: RelayAdmissionActionV2;
  requestBinding: string;
  policyObservation?: WalletPolicyObservation;
}

export type AdmissionCapabilityProviderV2 = ((
  context: AdmissionCapabilityRequestContextV2,
) => AdmissionCapabilityV2 | undefined) & {
  /** Independently pinned context, read only after releasing queued work. */
  policyObservers?: () => AdmissionPolicyObservers | undefined;
  /** Recheck retained state immediately before socket transmission; never reserve. */
  assertCurrent?: (context: AdmissionCapabilityRequestContextV2) => void;
};

export interface RelayClientEvents {
  onMatch?: (payload: MatchPayload) => void;
  onConsentForward?: (payload: ConsentForwardPayload) => void;
  onChannelForward?: (payload: ChannelForwardPayload) => void;
  onDisconnect?: (reason: string) => void;
  onReconnect?: () => void;
}

export interface RelayClient {
  /** Private-only public metadata query; no personal identifier or capability. */
  queryAdmissionPolicy?(context: import('@resonance/core/admission-policy-freshness').AdmissionPolicyObservers): Promise<import('@resonance/core/admission-policy-query').AdmissionPolicyQueryReply>;
  connect(): Promise<void>;
  disconnect(): void;
  /** Submit one self-authenticating v2 operation without sending the root DID. */
  submitPublicationOperation(operation: PublicationOperation): Promise<AckPayload>;
  fetchMailbox(record: PublicationRecord, keys: PublicationKeyMaterial): Promise<MailboxFetchResult>;
  depositMailboxEnvelope(
    matchId: string,
    sender: PublicationRecord,
    recipient: PublicationMailboxRecipient,
    keys: PublicationKeyMaterial,
    envelope: EncryptedMailboxEnvelope,
  ): Promise<AckPayload>;
  acknowledgeMailbox(
    record: PublicationRecord,
    keys: PublicationKeyMaterial,
    envelopeIds: string[],
  ): Promise<AckPayload>;
  fetchRelationshipMailbox(keys: RelationshipKeyMaterial): Promise<RelationshipMailboxFetchResult>;
  depositRelationshipMailboxEnvelope(
    recipientRelationshipId: string,
    keys: RelationshipKeyMaterial,
    envelope: EncryptedMailboxEnvelope,
  ): Promise<AckPayload>;
  acknowledgeRelationshipMailbox(
    keys: RelationshipKeyMaterial,
    envelopeIds: string[],
  ): Promise<AckPayload>;
  /** Execute a search with a newly generated one-use identity over a short connection. */
  searchV2(input: CreateSearchRequestInputV2): Promise<SearchResponsePayloadV2>;
  search(payload: SearchPayload): Promise<SearchResultsPayload>;
  sendConsent(payload: ConsentPayload): Promise<AckPayload>;
  sendChannelMessage(payload: ChannelMessagePayload): void;
  isConnected(): boolean;
  on(events: Partial<RelayClientEvents>): void;
}

export interface MailboxFetchResult {
  envelopes: EncryptedMailboxEnvelope[];
  notices: Message<MatchNoticePayload>[];
  relationshipMessages: RelationshipMessageV2[];
}

export interface RelationshipMailboxFetchResult {
  envelopes: EncryptedMailboxEnvelope[];
}

export function createRelayClient(config: RelayClientConfig): RelayClient {
  if (config.privateEntryUrls !== undefined) return createPrivateRelayClient(config);
  const allUrls = [config.relayUrl, ...(config.fallbackUrls ?? [])];
  if (allUrls.length > 16) throw new Error('Direct relay client supports at most 16 endpoints');
  allUrls.forEach(assertSecureRelayTransportEndpoint);
  const events: Partial<RelayClientEvents> = {};

  function admissionFor(
    relayUrl: string,
    action: RelayAdmissionActionV2,
    request: unknown,
  ): AdmissionCapabilityV2 | undefined {
    return config.admissionCapabilityProvider?.({
      relayUrl,
      action,
      requestBinding: createAdmissionRequestBindingV2(action, request),
    });
  }

  class DisconnectedOperation extends Error {}
  class OperationTimeout extends Error { constructor() { super('Direct relay operation timeout'); } }
  const exchanges = new Set<(error: Error) => void>();
  function rememberFailure(error: unknown): unknown {
    if (error instanceof DisconnectedOperation || error instanceof OperationTimeout) throw error;
    return error;
  }
  function directDeadline() { return performance.now() + 10_000; }
  function exchange<T>(url: string, raw: () => string, select: (message: Message) => T, deadline: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (exchanges.size >= 64) throw new Error('Direct relay client operation capacity exhausted');
      if (performance.now() >= deadline) throw new OperationTimeout();
      // Serialization and capability errors belong to the returned promise,
      // never an uncaught WebSocket open callback.
      const request = raw();
      if (performance.now() >= deadline) throw new OperationTimeout();
      const socket = openRelaySocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new OperationTimeout()), Math.max(1, deadline - performance.now()));
      const cancel = (error: Error) => finish(error); exchanges.add(cancel);
      function finish(error?: Error, result?: T) {
        if (settled) return; settled = true;
        clearTimeout(timeout); exchanges.delete(cancel);
        // This socket carries exactly one request/reply. Do not leave either
        // a connecting dial or an uncooperative closing peer alive afterwards.
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        if (error) reject(error); else resolve(result!);
      }
      socket.on('open', () => {
        if (settled) return;
        try {
          if (performance.now() >= deadline) throw new OperationTimeout();
          socket.send(request);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('message', (data, binary) => {
        if (settled) return;
        try {
          if (performance.now() >= deadline) throw new OperationTimeout();
          if (binary) throw new Error('Relay response must be JSON text');
          const message = parseMessage(data.toString('utf8'));
          if (!verifyMessage(message)) throw new Error('Relay response signature is invalid');
          if (message.type === MessageTypes.ACK) parseRelayAcknowledgement(message.payload);
          finish(undefined, select(message));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('error', error => finish(error));
      socket.on('close', () => finish(new Error('Relay closed before answering request')));
    });
  }
  function expectedAck(message: Message, ref: string, requireSuccess: boolean): AckPayload {
    if (message.type !== MessageTypes.ACK) throw new Error('Unexpected relay acknowledgement type');
    const ack = parseRelayAcknowledgement(message.payload);
    if (ack.ref !== ref) throw new Error('Relay acknowledgement does not match request');
    if (requireSuccess && ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected request');
    return ack;
  }
  function expectedMailboxReply(message: Message, request: MailboxRequest | RelationshipMailboxRequestV2): Message {
    if (request.action === 'ack') expectedAck(message, request.requestId, true);
    else parseRelayMailbox(message, request.requestId, request.mailboxId);
    return message;
  }
  function submitToUrl(url: string, operation: PublicationOperation, deadline: number): Promise<AckPayload> {
    return exchange(url, () => serializePublicationOperationFrame(createPublicationOperationFrame(operation,
      admissionFor(url, 'publication-write', operation))), message => expectedAck(message, operation.publicationId, false), deadline);
  }
  function sendMailboxRequestToUrl(url: string, request: MailboxRequest, deadline: number): Promise<Message> {
    return exchange(url, () => serializeMailboxRequestFrame(createMailboxRequestFrame(request,
      admissionFor(url, request.action === 'fetch' ? 'mailbox-fetch' : 'mailbox-acknowledge', request))),
    message => expectedMailboxReply(message, request), deadline);
  }
  function sendMailboxDepositToUrl(url: string, request: MailboxDepositRequest, deadline: number): Promise<AckPayload> {
    return exchange(url, () => serializeMailboxDepositFrame(createMailboxDepositFrame(request,
      admissionFor(url, 'mailbox-deposit', request))), message => expectedAck(message, request.requestId, true), deadline);
  }
  function sendRelationshipMailboxRequestToUrl(url: string, request: RelationshipMailboxRequestV2, deadline: number): Promise<Message> {
    return exchange(url, () => serializeRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestFrameV2(request,
      admissionFor(url, request.action === 'fetch' ? 'mailbox-fetch' : 'mailbox-acknowledge', request))),
    message => expectedMailboxReply(message, request), deadline);
  }
  function sendRelationshipMailboxDepositToUrl(url: string, request: RelationshipMailboxDepositV2, deadline: number): Promise<AckPayload> {
    return exchange(url, () => serializeRelationshipMailboxDepositFrameV2(createRelationshipMailboxDepositFrameV2(request,
      admissionFor(url, 'mailbox-deposit', request))), message => expectedAck(message, request.requestId, true), deadline);
  }
  function searchV2ToUrl(url: string, request: SearchRequestV2, deadline: number): Promise<SearchResponsePayloadV2> {
    return exchange(url, () => serializeSearchRequestFrameV2(createSearchRequestFrameV2(request, admissionFor(url, 'search', request))), message => {
      if (message.type === MessageTypes.ACK) { expectedAck(message, request.searchId, true); throw new Error('Unexpected search acknowledgement'); }
      if (message.type !== SEARCH_RESPONSE_MESSAGE_TYPE || !verifySearchResponsePayloadV2(message.payload)
        || message.payload.searchId !== request.searchId || message.payload.results.length > request.k) {
        throw new Error('Relay search response does not match the request');
      }
      return message.payload;
    }, deadline);
  }

  async function sendMailboxRequest(request: MailboxRequest): Promise<Message> {
    let lastError: unknown; const deadline = directDeadline();
    for (const url of allUrls) {
      try { return await sendMailboxRequestToUrl(url, request, deadline); } catch (error) { lastError = rememberFailure(error); }
    }
    throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
  }

  return {
    connect(): Promise<void> {
      return Promise.reject(new Error('Legacy relay authentication is unavailable; use protocol v2 operations'));
    },

    disconnect(): void {
      for (const cancel of [...exchanges]) cancel(new DisconnectedOperation('Direct relay client disconnected'));
      events.onDisconnect?.('Direct relay client disconnected');
    },

    async submitPublicationOperation(operation: PublicationOperation): Promise<AckPayload> {
      let lastError: unknown; const deadline = directDeadline();
      for (const url of allUrls) {
        try {
          return await submitToUrl(url, operation, deadline);
        } catch (error) {
          lastError = rememberFailure(error);
        }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    async fetchMailbox(record: PublicationRecord, keys: PublicationKeyMaterial): Promise<MailboxFetchResult> {
      const request = createMailboxRequest('fetch', record, keys);
      const response = await sendMailboxRequest(request);
      if (response.type === MessageTypes.ACK) {
        const ack = parseRelayAcknowledgement(response.payload);
        throw new Error(ack.message ?? 'Relay rejected mailbox fetch');
      }
      if (response.type !== MAILBOX_RESPONSE_MESSAGE_TYPE) throw new Error('Unexpected mailbox response type');
      const payload = response.payload as MailboxResponsePayload;
      if (payload.requestId !== request.requestId
        || payload.mailboxId !== record.mailbox.id
        || !Array.isArray(payload.envelopes)) {
        throw new Error('Mailbox response does not match request');
      }
      const notices: Message<MatchNoticePayload>[] = [];
      const relationshipMessages: RelationshipMessageV2[] = [];
      for (const envelope of payload.envelopes) {
        if (envelope.payloadType === 'match-notice') {
          notices.push(decryptMatchNotice(envelope, keys));
        } else if (envelope.payloadType === 'relationship-message') {
          relationshipMessages.push(decryptRelationshipMessage(envelope, keys));
        } else {
          throw new Error('Mailbox response contains an unsupported payload type');
        }
      }
      return { envelopes: payload.envelopes, notices, relationshipMessages };
    },

    async depositMailboxEnvelope(
      matchId: string,
      sender: PublicationRecord,
      recipient: PublicationMailboxRecipient,
      keys: PublicationKeyMaterial,
      envelope: EncryptedMailboxEnvelope,
    ): Promise<AckPayload> {
      const request = createMailboxDepositRequest(matchId, sender, recipient, keys, envelope);
      let lastError: unknown; const deadline = directDeadline();
      for (const url of allUrls) {
        try { return await sendMailboxDepositToUrl(url, request, deadline); } catch (error) { lastError = rememberFailure(error); }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    async acknowledgeMailbox(
      record: PublicationRecord,
      keys: PublicationKeyMaterial,
      envelopeIds: string[],
    ): Promise<AckPayload> {
      const request = createMailboxRequest('ack', record, keys, envelopeIds);
      const response = await sendMailboxRequest(request);
      if (response.type !== MessageTypes.ACK) throw new Error('Unexpected mailbox acknowledgement type');
      const ack = parseRelayAcknowledgement(response.payload);
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected mailbox acknowledgement');
      return ack;
    },

    async fetchRelationshipMailbox(keys: RelationshipKeyMaterial): Promise<RelationshipMailboxFetchResult> {
      const request = createRelationshipMailboxRequestV2('fetch', keys);
      // Explicit fallback relays can temporarily disagree during repair. Merge
      // their answers so one empty or stale relay cannot hide a live envelope.
      const deadline = directDeadline();
      const results = await Promise.allSettled(allUrls.map(async url => {
        const response = await sendRelationshipMailboxRequestToUrl(url, request, deadline);
        if (response.type === MessageTypes.ACK) {
          const ack = parseRelayAcknowledgement(response.payload);
          throw new Error(ack.message ?? 'Relay rejected relationship mailbox fetch');
        }
        if (response.type !== MAILBOX_RESPONSE_MESSAGE_TYPE) throw new Error('Unexpected relationship mailbox response');
        const payload = response.payload as MailboxResponsePayload;
        if (payload.requestId !== request.requestId
          || payload.mailboxId !== keys.mailboxId
          || !Array.isArray(payload.envelopes)) throw new Error('Relationship mailbox response does not match request');
        return payload.envelopes;
      }));
      for (const result of results) if (result.status === 'rejected' && result.reason instanceof DisconnectedOperation) throw result.reason;
      const successes = results.filter((result): result is PromiseFulfilledResult<EncryptedMailboxEnvelope[]> =>
        result.status === 'fulfilled');
      if (successes.length === 0) {
        const failed = results[0] as PromiseRejectedResult;
        throw failed.reason instanceof Error ? failed.reason : new Error('All relay URLs failed');
      }
      const envelopes = new Map<string, EncryptedMailboxEnvelope>();
      for (const result of successes) for (const envelope of result.value) {
        if (!envelopes.has(envelope.envelopeId)) envelopes.set(envelope.envelopeId, envelope);
      }
      return { envelopes: [...envelopes.values()].sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)) };
    },

    async depositRelationshipMailboxEnvelope(recipientRelationshipId, keys, envelope): Promise<AckPayload> {
      const request = createRelationshipMailboxDepositV2(recipientRelationshipId, keys, envelope);
      let lastError: unknown; const deadline = directDeadline();
      for (const url of allUrls) {
        try { return await sendRelationshipMailboxDepositToUrl(url, request, deadline); } catch (error) { lastError = rememberFailure(error); }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    async acknowledgeRelationshipMailbox(keys, envelopeIds): Promise<AckPayload> {
      const request = createRelationshipMailboxRequestV2('ack', keys, envelopeIds);
      const deadline = directDeadline();
      const results = await Promise.allSettled(allUrls.map(async url => {
        const response = await sendRelationshipMailboxRequestToUrl(url, request, deadline);
        if (response.type !== MessageTypes.ACK) throw new Error('Unexpected relationship mailbox acknowledgement');
        const ack = parseRelayAcknowledgement(response.payload);
        if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected relationship mailbox acknowledgement');
        return ack;
      }));
      for (const result of results) if (result.status === 'rejected' && result.reason instanceof DisconnectedOperation) throw result.reason;
      const success = results.find((result): result is PromiseFulfilledResult<AckPayload> =>
        result.status === 'fulfilled');
      if (success) return success.value;
      const failed = results[0] as PromiseRejectedResult;
      throw failed.reason instanceof Error ? failed.reason : new Error('All relay URLs failed');
    },

    async searchV2(input: CreateSearchRequestInputV2): Promise<SearchResponsePayloadV2> {
      // createSearchRequestV2 generates fresh signing material on every call.
      const request = createSearchRequestV2(input);
      let lastError: unknown; const deadline = directDeadline();
      for (const url of allUrls) {
        try { return await searchV2ToUrl(url, request, deadline); } catch (error) { lastError = rememberFailure(error); }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    search(): Promise<SearchResultsPayload> { return Promise.reject(new Error('Legacy search is unavailable; use searchV2')); },
    sendConsent(): Promise<AckPayload> { return Promise.reject(new Error('Legacy consent is unavailable; use relationship mailboxes')); },
    sendChannelMessage(): void { throw new Error('Legacy channel messages are unavailable; use relationship mailboxes'); },
    isConnected(): boolean { return false; }, // v2 has no persistent account-authenticated session.

    on(newEvents: Partial<RelayClientEvents>): void {
      Object.assign(events, newEvents);
    },
  };
}
