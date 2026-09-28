/** Short-lived personal-client transport through two authenticated relay hops. */

import WebSocket from 'ws';
import {
  MAX_PRIVATE_FRAME_BYTES,
  MessageTypes,
  MAILBOX_RESPONSE_MESSAGE_TYPE,
  SEARCH_RESPONSE_MESSAGE_TYPE,
  assertSecureRelayTransportEndpoint,
  createAdmissionRequestBindingV2,
  createMailboxDepositFrame,
  createMailboxDepositRequest,
  createMailboxRequest,
  createMailboxRequestFrame,
  createPrivateRequestV1,
  createPublicationOperationFrame,
  createRelayContactHintV1,
  createRelationshipMailboxDepositFrameV2,
  createRelationshipMailboxDepositV2,
  createRelationshipMailboxRequestFrameV2,
  createRelationshipMailboxRequestV2,
  createSearchRequestFrameV2,
  createSearchRequestV2,
  decodeUTF8,
  decryptMatchNotice,
  decryptRelationshipMessage,
  encodeUTF8,
  isRelayTransportKeyActiveV1,
  openPrivateResponseV1,
  parseMessage,
  parsePrivateResponseV1,
  selectPrivateRouteV1,
  serializeMailboxDepositFrame,
  serializeMailboxRequestFrame,
  serializePrivateRequestLayerV1,
  serializePublicationOperationFrame,
  serializeRelationshipMailboxDepositFrameV2,
  serializeRelationshipMailboxRequestFrameV2,
  serializeSearchRequestFrameV2,
  verifyMessage,
  verifySearchResponsePayloadV2,
  type AckPayload,
  type AdmissionCapabilityV2,
  type EncryptedMailboxEnvelope,
  type MailboxResponsePayload,
  type MatchNoticePayload,
  type Message,
  type PrivateRouteCandidateV1,
  type PublicationKeyMaterial,
  type PublicationMailboxRecipient,
  type PublicationOperation,
  type PublicationRecord,
  type RelayAdmissionActionV2,
  type RelationshipKeyMaterial,
  type RelationshipMessageV2,
  type SearchResponsePayloadV2,
} from '@resonance/core';
import { discoverRelayContactV1 } from './relay-discovery-client.js';
import type {
  MailboxFetchResult, RelayClient, RelayClientConfig, RelayClientEvents,
  RelationshipMailboxFetchResult,
} from './relay-client.js';

interface PrivateContact {
  candidate: PrivateRouteCandidateV1;
  key: NonNullable<Awaited<ReturnType<typeof discoverRelayContactV1>>['transportKey']>;
}

export function createPrivateRelayClient(config: RelayClientConfig): RelayClient {
  const destinations = [...new Set([config.relayUrl, ...(config.fallbackUrls ?? [])])];
  const contactUrls = [...new Set(config.privateRouteUrls ?? [])];
  if (contactUrls.length < 2 || destinations.some(url => !contactUrls.includes(url))) {
    throw new Error('Private mode requires at least two configured contacts and every destination in that set');
  }
  contactUrls.forEach(assertSecureRelayTransportEndpoint);
  const events: Partial<RelayClientEvents> = {};

  function admissionFor(url: string, action: RelayAdmissionActionV2, request: unknown): AdmissionCapabilityV2 | undefined {
    return config.admissionCapabilityProvider?.({
      relayUrl: url,
      action,
      requestBinding: createAdmissionRequestBindingV2(action, request),
    });
  }

  async function discoverContacts(): Promise<Map<string, PrivateContact>> {
    const results = await Promise.allSettled(contactUrls.map(async endpoint => {
      let remoteAddress = '';
      const contact = await discoverRelayContactV1(createRelayContactHintV1('configured', endpoint), {
        onTransportSocket: socket => { remoteAddress = socket.remoteAddress ?? ''; },
      });
      if (!contact.transportKey || !isRelayTransportKeyActiveV1(contact.transportKey, Date.now())
        || contact.transportKey.relayId !== contact.responder.relayId) {
        throw new Error('Relay did not provide an active signed transport key');
      }
      return { endpoint, candidate: { descriptor: contact.responder, endpoint, remoteAddress },
        key: contact.transportKey };
    }));
    const contacts = new Map<string, PrivateContact>();
    for (const result of results) if (result.status === 'fulfilled') {
      contacts.set(result.value.endpoint, result.value);
    }
    return contacts;
  }

  async function sendTo(destinationUrl: string, raw: string): Promise<Message> {
    const contacts = await discoverContacts();
    const destination = contacts.get(destinationUrl);
    if (!destination) throw new Error('Private destination discovery failed');
    let entry: PrivateContact | undefined;
    for (const [endpoint, candidate] of contacts) {
      if (endpoint === destinationUrl) continue;
      try {
        // The selector checks live observed IP domains and signed descriptors.
        selectPrivateRouteV1([candidate.candidate, destination.candidate]);
        entry = candidate;
        break;
      } catch { /* Try another independently observed relay. */ }
    }
    if (!entry) throw new Error('No independent two-relay route is available');
    const exchange = await createPrivateRequestV1(
      decodeUTF8(raw), entry.key, destination.key,
    );
    const requestRaw = serializePrivateRequestLayerV1(exchange.request);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(entry.candidate.endpoint, {
        handshakeTimeout: 10_000, maxPayload: MAX_PRIVATE_FRAME_BYTES,
      });
      let settled = false;
      let receivedResponse = false;
      const timer = setTimeout(() => finish(new Error('Private request timed out')), 10_000);
      function finish(error?: Error, response?: Message): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        if (error) reject(error);
        else resolve(response!);
      }
      socket.on('open', () => socket.send(requestRaw));
      socket.on('message', data => {
        if (receivedResponse) { finish(new Error('Private relay sent multiple responses')); return; }
        receivedResponse = true;
        void (async () => {
          const encrypted = parsePrivateResponseV1(data.toString('utf8'));
          const plaintext = await openPrivateResponseV1(
            encrypted, exchange.responsePrivateKey, exchange.request.requestId,
            destination.candidate.descriptor.relayId,
          );
          const message = parseMessage(encodeUTF8(plaintext));
          if (!verifyMessage(message) || message.from !== destination.candidate.descriptor.relayId) {
            throw new Error('Private destination response has an invalid signature');
          }
          finish(undefined, message);
        })().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
      });
      socket.on('error', error => finish(error));
      socket.on('close', (code, reason) => {
        if (!settled && !receivedResponse) {
          finish(new Error(`Private route closed: ${code} ${reason.toString()}`));
        }
      });
    });
  }

  async function firstReply(makeRaw: (url: string) => string): Promise<Message> {
    let lastError: unknown;
    for (const url of destinations) {
      try { return await sendTo(url, makeRaw(url)); }
      catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('No private destination answered');
  }

  function expectedAck(message: Message, ref: string): AckPayload {
    if (message.type !== MessageTypes.ACK) throw new Error('Unexpected private relay response');
    const ack = message.payload as AckPayload;
    if (ack.ref !== ref) throw new Error('Private relay ACK does not match request');
    if (ack.status !== 'ok') throw new Error(ack.message ?? 'Private relay rejected request');
    return ack;
  }

  function expectedMailbox(message: Message, requestId: string, mailboxId: string): EncryptedMailboxEnvelope[] {
    if (message.type === MessageTypes.ACK) {
      throw new Error((message.payload as AckPayload).message ?? 'Private relay rejected mailbox request');
    }
    if (message.type !== MAILBOX_RESPONSE_MESSAGE_TYPE) throw new Error('Unexpected private mailbox response');
    const payload = message.payload as MailboxResponsePayload;
    if (payload.requestId !== requestId || payload.mailboxId !== mailboxId
      || !Array.isArray(payload.envelopes)) throw new Error('Private mailbox response does not match request');
    return payload.envelopes;
  }

  return {
    async connect() { await discoverContacts(); },
    disconnect() {},
    isConnected() { return false; }, // v2 deliberately uses no persistent authenticated socket.
    on(next) { Object.assign(events, next); },
    async submitPublicationOperation(operation: PublicationOperation): Promise<AckPayload> {
      const reply = await firstReply(url => serializePublicationOperationFrame(
        createPublicationOperationFrame(operation, admissionFor(url, 'publication-write', operation))));
      return expectedAck(reply, operation.publicationId);
    },
    async fetchMailbox(record: PublicationRecord, keys: PublicationKeyMaterial): Promise<MailboxFetchResult> {
      const request = createMailboxRequest('fetch', record, keys);
      const reply = await firstReply(url => serializeMailboxRequestFrame(
        createMailboxRequestFrame(request, admissionFor(url, 'mailbox-fetch', request))));
      const envelopes = expectedMailbox(reply, request.requestId, record.mailbox.id);
      const notices: Message<MatchNoticePayload>[] = [];
      const relationshipMessages: RelationshipMessageV2[] = [];
      for (const envelope of envelopes) {
        if (envelope.payloadType === 'match-notice') notices.push(decryptMatchNotice(envelope, keys));
        else if (envelope.payloadType === 'relationship-message') {
          relationshipMessages.push(decryptRelationshipMessage(envelope, keys));
        } else throw new Error('Unsupported private mailbox payload');
      }
      return { envelopes, notices, relationshipMessages };
    },
    async depositMailboxEnvelope(matchId, sender, recipient: PublicationMailboxRecipient, keys, envelope) {
      const request = createMailboxDepositRequest(matchId, sender, recipient, keys, envelope);
      const reply = await firstReply(url => serializeMailboxDepositFrame(
        createMailboxDepositFrame(request, admissionFor(url, 'mailbox-deposit', request))));
      return expectedAck(reply, request.requestId);
    },
    async acknowledgeMailbox(record, keys, envelopeIds) {
      const request = createMailboxRequest('ack', record, keys, envelopeIds);
      const reply = await firstReply(url => serializeMailboxRequestFrame(
        createMailboxRequestFrame(request, admissionFor(url, 'mailbox-acknowledge', request))));
      return expectedAck(reply, request.requestId);
    },
    async fetchRelationshipMailbox(keys: RelationshipKeyMaterial): Promise<RelationshipMailboxFetchResult> {
      const request = createRelationshipMailboxRequestV2('fetch', keys);
      const results = await Promise.allSettled(destinations.map(async url => expectedMailbox(
        await sendTo(url, serializeRelationshipMailboxRequestFrameV2(
          createRelationshipMailboxRequestFrameV2(request, admissionFor(url, 'mailbox-fetch', request)))),
        request.requestId, keys.mailboxId,
      )));
      const successes = results.filter((result): result is PromiseFulfilledResult<EncryptedMailboxEnvelope[]> =>
        result.status === 'fulfilled');
      if (successes.length === 0) {
        const failed = results[0] as PromiseRejectedResult;
        throw failed.reason instanceof Error ? failed.reason : new Error('No private mailbox destination answered');
      }
      const envelopes = new Map<string, EncryptedMailboxEnvelope>();
      for (const result of successes) for (const envelope of result.value) {
        if (!envelopes.has(envelope.envelopeId)) envelopes.set(envelope.envelopeId, envelope);
      }
      return { envelopes: [...envelopes.values()].sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)) };
    },
    async depositRelationshipMailboxEnvelope(recipientRelationshipId, keys, envelope) {
      const request = createRelationshipMailboxDepositV2(recipientRelationshipId, keys, envelope);
      const reply = await firstReply(url => serializeRelationshipMailboxDepositFrameV2(
        createRelationshipMailboxDepositFrameV2(request, admissionFor(url, 'mailbox-deposit', request))));
      return expectedAck(reply, request.requestId);
    },
    async acknowledgeRelationshipMailbox(keys, envelopeIds) {
      const request = createRelationshipMailboxRequestV2('ack', keys, envelopeIds);
      const results = await Promise.allSettled(destinations.map(async url => expectedAck(
        await sendTo(url, serializeRelationshipMailboxRequestFrameV2(
          createRelationshipMailboxRequestFrameV2(request, admissionFor(url, 'mailbox-acknowledge', request)))),
        request.requestId,
      )));
      const success = results.find((result): result is PromiseFulfilledResult<AckPayload> =>
        result.status === 'fulfilled');
      if (success) return success.value;
      const failed = results[0] as PromiseRejectedResult;
      throw failed.reason instanceof Error ? failed.reason : new Error('No private mailbox destination answered');
    },
    async searchV2(input): Promise<SearchResponsePayloadV2> {
      const request = createSearchRequestV2(input);
      const reply = await firstReply(url => serializeSearchRequestFrameV2(
        createSearchRequestFrameV2(request, admissionFor(url, 'search', request))));
      if (reply.type === MessageTypes.ACK) {
        expectedAck(reply, request.searchId);
        throw new Error('Unexpected private search acknowledgement');
      }
      if (reply.type !== SEARCH_RESPONSE_MESSAGE_TYPE
        || !verifySearchResponsePayloadV2(reply.payload)
        || reply.payload.searchId !== request.searchId
        || reply.payload.results.length > request.k) {
        throw new Error('Private search response does not match request');
      }
      return reply.payload;
    },
    search() { return Promise.reject(new Error('Legacy search is unavailable in private mode')); },
    sendConsent() { return Promise.reject(new Error('Legacy consent is unavailable in private mode')); },
    sendChannelMessage() { throw new Error('Legacy channel messages are unavailable in private mode'); },
  };
}
