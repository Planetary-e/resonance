/** Short-lived personal-client transport through two authenticated relay hops. */

import { randomInt } from 'node:crypto';
import { parseAdmissionPolicyObservers, parseAdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { createAdmissionPolicyChunkRequest, parseAdmissionPolicyChunkReply, assembleAdmissionPolicyTransfer,
  ADMISSION_POLICY_CHUNK_REPLY_TYPE, type AdmissionPolicyChunkRequest, type AdmissionPolicyChunkReply } from '@resonance/core/admission-policy-transfer';
import { createAdmissionPolicyQuery, parseAdmissionPolicyQueryReply, ADMISSION_POLICY_QUERY_REPLY_TYPE,
  type AdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import WebSocket from 'ws';
import type { WalletPolicyObservation } from './wallet-policy-freshness.js';
import { parseRelayAcknowledgement, parseRelayMailbox } from './relay-response.js';
import {
  MAX_PRIVATE_FRAME_BYTES,
  MAX_PRIVATE_DISCOVERY_FRAME_BYTES,
  MessageTypes,
  SEARCH_RESPONSE_MESSAGE_TYPE,
  assertSecureRelayTransportEndpoint, relayTlsClientOptions,
  createAdmissionRequestBindingV2,
  createMailboxDepositFrame,
  createMailboxDepositRequest,
  createMailboxRequest,
  createMailboxRequestFrame,
  createPrivateRequestV1,
  createPrivateDiscoveryRequestV1,
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
  serializePrivateDiscoveryRequestV1,
  serializeMailboxDepositFrame,
  serializeMailboxRequestFrame,
  serializePrivateRequestLayerV1,
  serializePublicationOperationFrame,
  serializeRelationshipMailboxDepositFrameV2,
  serializeRelationshipMailboxRequestFrameV2,
  serializeSearchRequestFrameV2,
  verifyMessage,
  verifyPrivateDiscoveryResponseV1,
  verifySearchResponsePayloadV2,
  type AckPayload,
  type AdmissionCapabilityV2,
  type EncryptedMailboxEnvelope,
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
import { verifyPrivateDestinationAddressV1 } from './private-destination-dns.js';
import { createPrivateTrafficScheduler } from './private-traffic-scheduler.js';
import { createPrivateOperation, PrivateOperationError, type PrivateOperation } from './private-operation.js';
import type {
  MailboxFetchResult, RelayClient, RelayClientConfig, RelayClientEvents,
  RelationshipMailboxFetchResult,
} from './relay-client.js';

interface PreparedPrivateRequest { raw: string; valid: () => void }
type PrivateRequestBuilder = () => string | PreparedPrivateRequest | Promise<string | PreparedPrivateRequest>;

interface PrivateContact {
  candidate: PrivateRouteCandidateV1;
  key: NonNullable<Awaited<ReturnType<typeof discoverRelayContactV1>>['transportKey']>;
}

export function createPrivateRelayClient(config: RelayClientConfig): RelayClient {
  const destinations = [...new Set([config.relayUrl, ...(config.fallbackUrls ?? [])])];
  const entryUrls = [...new Set(config.privateEntryUrls ?? [])];
  if (entryUrls.length === 0 || destinations.some(url => entryUrls.includes(url))) {
    throw new Error('Private mode requires separate entry and destination relay URLs');
  }
  [...entryUrls, ...destinations].forEach(assertSecureRelayTransportEndpoint);
  const events: Partial<RelayClientEvents> = {};
  const scheduler = createPrivateTrafficScheduler(config.privateTraffic);
  const operations = new Set<PrivateOperation>();

  async function runOperation<T>(work: (operation: PrivateOperation) => Promise<T>): Promise<T> {
    const operation = createPrivateOperation();
    operations.add(operation);
    try { return await work(operation); }
    catch (error) { throw operation.failure(error instanceof Error ? error : new Error(String(error))); }
    finally { operation.dispose(); operations.delete(operation); }
  }

  async function admittedRequest(url: string, action: RelayAdmissionActionV2, request: unknown,
    serialize: (capability: AdmissionCapabilityV2 | undefined) => string, operation: PrivateOperation, signal: AbortSignal, requestValid = () => {}): Promise<PreparedPrivateRequest> {
    const provider = config.admissionCapabilityProvider;
    const context = provider?.policyObservers?.();
    let policyObservation: WalletPolicyObservation | undefined;
    let observationDeadline = Infinity;
    if (context) {
      let query: AdmissionPolicyQuery | undefined;
      const reply = await sendTo(url, () => {
        query = createAdmissionPolicyQuery(context);
        observationDeadline = performance.now() + query.request.expiresAt - query.request.issuedAt;
        return JSON.stringify(query);
      }, operation, signal, undefined, false);
      operation.check(signal);
      if (!query || reply.type !== ADMISSION_POLICY_QUERY_REPLY_TYPE) throw new Error('Private relay did not return a policy observation');
      policyObservation = { query, reply: parseAdmissionPolicyQueryReply(reply.payload, query, context, Date.now()) };
    }
    const capabilityContext = { relayUrl: url, action, requestBinding: createAdmissionRequestBindingV2(action, request),
      ...(policyObservation ? { policyObservation } : {}) };
    const valid = () => {
      operation.check(signal);
      requestValid();
      if (policyObservation && (performance.now() >= observationDeadline || Date.now() < policyObservation.query.request.issuedAt
        || Date.now() >= policyObservation.query.request.expiresAt)) throw new Error('Policy observation expired before transmission');
      provider?.assertCurrent?.(capabilityContext);
    };
    valid();
    const capability = provider?.(capabilityContext);
    valid();
    return { raw: serialize(capability), valid };
  }

  async function discoverEntry(endpoint: string, signal: AbortSignal): Promise<PrivateContact> {
    signal.throwIfAborted();
    let remoteAddress = '';
    const contact = await discoverRelayContactV1(createRelayContactHintV1('configured', endpoint), {
      onTransportSocket: socket => { remoteAddress = socket.remoteAddress ?? ''; },
      signal,
    });
    if (!contact.transportKey || !isRelayTransportKeyActiveV1(contact.transportKey, Date.now())
      || contact.transportKey.relayId !== contact.responder.relayId) {
      throw new Error('Entry relay did not provide an active signed transport key');
    }
    return { candidate: { descriptor: contact.responder, endpoint, remoteAddress },
      key: contact.transportKey };
  }

  async function discoverDestination(entry: PrivateContact, endpoint: string, signal: AbortSignal): Promise<PrivateContact> {
    signal.throwIfAborted();
    const request = createPrivateDiscoveryRequestV1(endpoint);
    const requestRaw = serializePrivateDiscoveryRequestV1(request);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(entry.candidate.endpoint, { ...relayTlsClientOptions,
        handshakeTimeout: 8_000, maxPayload: MAX_PRIVATE_DISCOVERY_FRAME_BYTES,
        followRedirects: false, perMessageDeflate: false,
      });
      let settled = false;
      let receivedResponse = false;
      const timer = setTimeout(() => finish(new Error('Indirect destination discovery timed out')), 8_000);
      function finish(error?: Error, result?: PrivateContact): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        if (error) reject(error); else resolve(result!);
      }
      function onAbort(): void {
        finish(signal.reason);
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('open', () => {
        if (settled || signal.aborted) return;
        try { socket.send(requestRaw); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('message', (data, binary) => {
        if (settled || signal.aborted) return;
        if (binary) { finish(new Error('Private discovery response must be JSON text')); return; }
        if (receivedResponse) { finish(new Error('Entry sent multiple discovery responses')); return; }
        receivedResponse = true;
        try {
          const verified = verifyPrivateDiscoveryResponseV1(
            data.toString('utf8'), request, entry.candidate.descriptor.relayId,
          );
          finish(undefined, {
            candidate: {
              descriptor: verified.descriptor,
              endpoint,
              remoteAddress: verified.destinationRemoteAddress,
            },
            key: verified.transportKey,
          });
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('error', error => finish(error));
      socket.on('close', (code, reason) => {
        if (!settled && !receivedResponse) {
          finish(new Error(`Indirect destination discovery closed: ${code} ${reason.toString()}`));
        }
      });
    });
  }

  async function discoverRoute(destinationUrl: string, operation: PrivateOperation, signal: AbortSignal): Promise<{ entry: PrivateContact; destination: PrivateContact }> {
    let lastError: unknown;
    const start = randomInt(entryUrls.length);
    for (let offset = 0; offset < entryUrls.length; offset++) {
      operation.check(signal);
      const entryUrl = entryUrls[(start + offset) % entryUrls.length];
      try {
        const entry = await discoverEntry(entryUrl, signal);
        operation.check(signal);
        const destination = await discoverDestination(entry, destinationUrl, signal);
        operation.check(signal);
        // Independently resolve DNS without opening a destination relay socket.
        // DNS integrity and operator diversity remain separate trust questions.
        await verifyPrivateDestinationAddressV1(
          destinationUrl, destination.candidate.remoteAddress,
          entry.candidate.remoteAddress, undefined, signal,
        );
        operation.check(signal);
        selectPrivateRouteV1([entry.candidate, destination.candidate]);
        return { entry, destination };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('No independent two-relay route is available');
  }

  async function sendTo(destinationUrl: string, makeRaw: PrivateRequestBuilder, operation: PrivateOperation, signal: AbortSignal, valid = () => {}, accountDelivery = true): Promise<Message> {
    valid();
    const { entry, destination } = await discoverRoute(destinationUrl, operation, signal);
    operation.check(signal);
    valid();
    const prepared = await makeRaw();
    const check = () => { valid(); if (typeof prepared !== 'string') prepared.valid(); };
    check();
    const plaintext = decodeUTF8(typeof prepared === 'string' ? prepared : prepared.raw);
    operation.check(signal);
    const exchange = await createPrivateRequestV1(
      plaintext, entry.key, destination.key,
    );
    operation.check(signal);
    const requestRaw = serializePrivateRequestLayerV1(exchange.request);
    operation.check(signal);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(entry.candidate.endpoint, { ...relayTlsClientOptions,
        handshakeTimeout: 10_000, maxPayload: MAX_PRIVATE_FRAME_BYTES,
        followRedirects: false, perMessageDeflate: false,
      });
      let settled = false;
      let receivedResponse = false;
      function finish(error?: Error, response?: Message): void {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        if (error) reject(operation.transportError(error));
        else resolve(response!);
      }
      function onAbort(): void {
        finish(signal.reason);
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('open', () => {
        if (settled) return;
        try {
          operation.check(signal);
          check();
          // Once handed to the socket, failure cannot prove non-delivery.
          if (accountDelivery) operation.markSent();
          socket.send(requestRaw);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('message', (data, binary) => {
        if (settled || signal.aborted) return;
        if (binary) { finish(new Error('Private response must be JSON text')); return; }
        if (receivedResponse) { finish(new Error('Private relay sent multiple responses')); return; }
        receivedResponse = true;
        void (async () => {
          const encrypted = parsePrivateResponseV1(data.toString('utf8'));
          const plaintext = await openPrivateResponseV1(
            encrypted, exchange.responsePrivateKey, exchange.request.requestId,
            destination.candidate.descriptor.relayId,
          );
          operation.check(signal);
          const message = parseMessage(encodeUTF8(plaintext));
          if (!verifyMessage(message) || message.from !== destination.candidate.descriptor.relayId) {
            throw new Error('Private destination response has an invalid signature');
          }
          operation.check(signal);
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

  function firstReply(operation: PrivateOperation, makeRaw: (url: string, signal: AbortSignal) => ReturnType<PrivateRequestBuilder>, valid = () => {}): Promise<Message> {
    return scheduler.schedule(async signal => {
      let lastError: unknown;
      let unknownOutcome: PrivateOperationError | undefined;
      for (const url of destinations) {
        operation.check(signal);
        valid();
        try { return await sendTo(url, () => makeRaw(url, signal), operation, signal, valid); }
        catch (error) {
          lastError = error;
          if (error instanceof PrivateOperationError && error.outcome === 'unknown') unknownOutcome = error;
        }
      }
      if (unknownOutcome) throw unknownOutcome;
      throw lastError instanceof Error ? lastError : new Error('No private destination answered');
    }, operation.signal);
  }

  function expectedAck(message: Message, ref: string): AckPayload {
    if (message.type !== MessageTypes.ACK) throw new Error('Unexpected private relay response');
    const ack = parseRelayAcknowledgement(message.payload);
    if (ack.ref !== ref) throw new Error('Private relay ACK does not match request');
    if (ack.status !== 'ok') throw new Error(ack.message ?? 'Private relay rejected request');
    return ack;
  }

  function expectedMailbox(message: Message, requestId: string, mailboxId: string): EncryptedMailboxEnvelope[] {
    return parseRelayMailbox(message, requestId, mailboxId);
  }

  return {
    async fetchAdmissionPolicySuccessor(contextValue, previousValue) {
      const context = parseAdmissionPolicyObservers(contextValue), previous = parseAdmissionPolicyHead(previousValue);
      return runOperation(async operation => {
        const fetchChunk = async (request: AdmissionPolicyChunkRequest) => {
          const message = await firstReply(operation, () => JSON.stringify(request));
          operation.check();
          if (message.type !== ADMISSION_POLICY_CHUNK_REPLY_TYPE) throw new Error('Private relay did not return a policy chunk');
          return parseAdmissionPolicyChunkReply(message.payload, request, context);
        };
        const first = await fetchChunk(createAdmissionPolicyChunkRequest(context, previous));
        const chunks: AdmissionPolicyChunkReply[] = [first]; let next = 1;
        // At most four chunk requests share the original operation deadline and
        // the ordinary private traffic scheduler. No nested operation budgets.
        const workers = await Promise.allSettled(Array.from({ length: Math.min(4, first.count - 1) }, async () => {
          try {
            while (next < first.count) {
              operation.check(); const index = next++;
              chunks[index] = await fetchChunk(createAdmissionPolicyChunkRequest(context, previous, first.artifact, index));
            }
          } catch (error) { operation.cancel(error instanceof Error ? error : new Error('Policy chunk transfer failed'), 'PRIVATE_OPERATION_FAILED'); throw error; }
        }));
        const failed = workers.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        operation.check(); const advance = await assembleAdmissionPolicyTransfer(chunks, context, previous);
        operation.check(); return advance;
      });
    },
    async queryAdmissionPolicy(contextValue) {
      const context = parseAdmissionPolicyObservers(contextValue);
      return runOperation(async operation => {
        let query: AdmissionPolicyQuery | undefined;
        const reply = await firstReply(operation, () => {
          // Discovery and queued waiting do not consume the short challenge window.
          query = createAdmissionPolicyQuery(context); return JSON.stringify(query);
        });
        operation.check();
        if (!query || reply.type !== ADMISSION_POLICY_QUERY_REPLY_TYPE) throw new Error('Private relay did not return a policy observation');
        const certificate = parseAdmissionPolicyQueryReply(reply.payload, query, context, Date.now());
        operation.check(); return { query, reply: certificate };
      });
    },
    async connect() {
      return runOperation(operation => scheduler.schedule(async signal => {
        let lastError: unknown;
        for (const destination of destinations) {
          operation.check(signal);
          try { await discoverRoute(destination, operation, signal); return; }
          catch (error) { lastError = error; }
        }
        throw lastError instanceof Error ? lastError : new Error('No private route is available');
      }, operation.signal));
    },
    disconnect() {
      for (const operation of operations) operation.cancel(new Error('Private client disconnected'));
      scheduler.cancelAll();
      events.onDisconnect?.('Private client disconnected');
    },
    isConnected() { return false; }, // v2 deliberately uses no persistent authenticated socket.
    on(next) { Object.assign(events, next); },
    async submitPublicationOperation(publication: PublicationOperation): Promise<AckPayload> {
      return runOperation(async operation => {
        const valid = () => {
          if (publication.kind === 'publication' && publication.expiresAt <= Date.now()) {
            throw new Error('Publication expired before transmission');
          }
        };
        valid();
        const reply = await firstReply(operation, (url, signal) => admittedRequest(url, 'publication-write', publication,
          cap => serializePublicationOperationFrame(createPublicationOperationFrame(publication, cap)), operation, signal, valid), valid);
        const ack = expectedAck(reply, publication.publicationId);
        operation.check();
        return ack;
      });
    },
    async fetchMailbox(record: PublicationRecord, keys: PublicationKeyMaterial): Promise<MailboxFetchResult> {
      return runOperation(async operation => {
        const request = createMailboxRequest('fetch', record, keys);
        const reply = await firstReply(operation, (url, signal) => admittedRequest(url, 'mailbox-fetch', request,
          cap => serializeMailboxRequestFrame(createMailboxRequestFrame(request, cap)), operation, signal));
        const envelopes = expectedMailbox(reply, request.requestId, record.mailbox.id);
        const notices: Message<MatchNoticePayload>[] = [];
        const relationshipMessages: RelationshipMessageV2[] = [];
        for (const envelope of envelopes) {
          if (envelope.payloadType === 'match-notice') notices.push(decryptMatchNotice(envelope, keys));
          else if (envelope.payloadType === 'relationship-message') {
            relationshipMessages.push(decryptRelationshipMessage(envelope, keys));
          } else throw new Error('Unsupported private mailbox payload');
        }
        operation.check();
        return { envelopes, notices, relationshipMessages };
      });
    },
    async depositMailboxEnvelope(matchId, sender, recipient: PublicationMailboxRecipient, keys, envelope) {
      return runOperation(async operation => {
        const request = createMailboxDepositRequest(matchId, sender, recipient, keys, envelope);
        const reply = await firstReply(operation, (url, signal) => admittedRequest(url, 'mailbox-deposit', request,
          cap => serializeMailboxDepositFrame(createMailboxDepositFrame(request, cap)), operation, signal));
        const ack = expectedAck(reply, request.requestId);
        operation.check();
        return ack;
      });
    },
    async acknowledgeMailbox(record, keys, envelopeIds) {
      return runOperation(async operation => {
        const request = createMailboxRequest('ack', record, keys, envelopeIds);
        const reply = await firstReply(operation, (url, signal) => admittedRequest(url, 'mailbox-acknowledge', request,
          cap => serializeMailboxRequestFrame(createMailboxRequestFrame(request, cap)), operation, signal));
        const ack = expectedAck(reply, request.requestId);
        operation.check();
        return ack;
      });
    },
    async fetchRelationshipMailbox(keys: RelationshipKeyMaterial): Promise<RelationshipMailboxFetchResult> {
      return runOperation(async operation => {
        const request = createRelationshipMailboxRequestV2('fetch', keys);
        const results = await Promise.allSettled(destinations.map(url => scheduler.schedule(async signal => {
          const reply = await sendTo(url, () => admittedRequest(url, 'mailbox-fetch', request,
            cap => serializeRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestFrameV2(request, cap)), operation, signal), operation, signal);
          const envelopes = expectedMailbox(reply, request.requestId, keys.mailboxId);
          operation.check(signal);
          return envelopes;
        }, operation.signal)));
        const successes = results.filter((result): result is PromiseFulfilledResult<EncryptedMailboxEnvelope[]> =>
          result.status === 'fulfilled');
        if (successes.length === 0) {
          const failed = (results.find(result => result.status === 'rejected'
            && result.reason instanceof PrivateOperationError && result.reason.outcome === 'unknown')
            ?? results[0]) as PromiseRejectedResult;
          throw failed.reason instanceof Error ? failed.reason : new Error('No private mailbox destination answered');
        }
        const envelopes = new Map<string, EncryptedMailboxEnvelope>();
        for (const result of successes) for (const envelope of result.value) {
          if (!envelopes.has(envelope.envelopeId)) envelopes.set(envelope.envelopeId, envelope);
        }
        return { envelopes: [...envelopes.values()].sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)) };
      });
    },
    async depositRelationshipMailboxEnvelope(recipientRelationshipId, keys, envelope) {
      return runOperation(async operation => {
        const request = createRelationshipMailboxDepositV2(recipientRelationshipId, keys, envelope);
        const reply = await firstReply(operation, (url, signal) => admittedRequest(url, 'mailbox-deposit', request,
          cap => serializeRelationshipMailboxDepositFrameV2(createRelationshipMailboxDepositFrameV2(request, cap)), operation, signal));
        const ack = expectedAck(reply, request.requestId);
        operation.check();
        return ack;
      });
    },
    async acknowledgeRelationshipMailbox(keys, envelopeIds) {
      return runOperation(async operation => {
        const request = createRelationshipMailboxRequestV2('ack', keys, envelopeIds);
        const results = await Promise.allSettled(destinations.map(url => scheduler.schedule(async signal => {
          const reply = await sendTo(url, () => admittedRequest(url, 'mailbox-acknowledge', request,
            cap => serializeRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestFrameV2(request, cap)), operation, signal), operation, signal);
          const ack = expectedAck(reply, request.requestId);
          operation.check(signal);
          return ack;
        }, operation.signal)));
        const success = results.find((result): result is PromiseFulfilledResult<AckPayload> =>
          result.status === 'fulfilled');
        if (success) return success.value;
        const failed = (results.find(result => result.status === 'rejected'
          && result.reason instanceof PrivateOperationError && result.reason.outcome === 'unknown')
          ?? results[0]) as PromiseRejectedResult;
        throw failed.reason instanceof Error ? failed.reason : new Error('No private mailbox destination answered');
      });
    },
    async searchV2(input): Promise<SearchResponsePayloadV2> {
      return runOperation(async operation => {
        const request = createSearchRequestV2(input);
        const reply = await firstReply(operation, (url, signal) => admittedRequest(url, 'search', request,
          cap => serializeSearchRequestFrameV2(createSearchRequestFrameV2(request, cap)), operation, signal));
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
        operation.check();
        return reply.payload;
      });
    },
    search() { return Promise.reject(new Error('Legacy search is unavailable in private mode')); },
    sendConsent() { return Promise.reject(new Error('Legacy consent is unavailable in private mode')); },
    sendChannelMessage() { throw new Error('Legacy channel messages are unavailable in private mode'); },
  };
}
