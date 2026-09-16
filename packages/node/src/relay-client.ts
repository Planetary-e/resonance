/**
 * WebSocket client for connecting a personal node to a relay server.
 */

import WebSocket from 'ws';
import {
  MessageTypes,
  MAILBOX_RESPONSE_MESSAGE_TYPE,
  SEARCH_RESPONSE_MESSAGE_TYPE,
  createAdmissionRequestBindingV2,
  createMessage,
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
  serializeMessage,
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
  /** Required only by isolated legacy authenticated methods. */
  identity?: Identity;
  /** Additional relay URLs to try if primary fails. */
  fallbackUrls?: string[];
  /** Enable auto-reconnect with exponential backoff. */
  autoReconnect?: boolean;
  /** Supplies an unlinkable capability for each exact v2 relay request. */
  admissionCapabilityProvider?: AdmissionCapabilityProviderV2;
}

export interface AdmissionCapabilityRequestContextV2 {
  relayUrl: string;
  action: RelayAdmissionActionV2;
  requestBinding: string;
}

export type AdmissionCapabilityProviderV2 = (
  context: AdmissionCapabilityRequestContextV2,
) => AdmissionCapabilityV2 | undefined;

export interface RelayClientEvents {
  onMatch?: (payload: MatchPayload) => void;
  onConsentForward?: (payload: ConsentForwardPayload) => void;
  onChannelForward?: (payload: ChannelForwardPayload) => void;
  onDisconnect?: (reason: string) => void;
  onReconnect?: () => void;
}

export interface RelayClient {
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

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createRelayClient(config: RelayClientConfig): RelayClient {
  let ws: WebSocket | null = null;
  let connected = false;
  let intentionalDisconnect = false;
  let reconnectDelay = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentUrl = config.relayUrl;
  const allUrls = [config.relayUrl, ...(config.fallbackUrls ?? [])];
  let urlIndex = 0;
  const events: Partial<RelayClientEvents> = {};
  const pending = new Map<string, PendingRequest>();
  let pendingSearchResolve: ((value: SearchResultsPayload) => void) | null = null;

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

  function scheduleReconnect(): void {
    if (!config.autoReconnect || intentionalDisconnect) return;
    reconnectTimer = setTimeout(async () => {
      // Try next URL in list
      urlIndex = (urlIndex + 1) % allUrls.length;
      currentUrl = allUrls[urlIndex];
      try {
        await doConnect(currentUrl);
        reconnectDelay = 1000; // Reset on success
        events.onReconnect?.();
      } catch {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        scheduleReconnect();
      }
    }, reconnectDelay);
  }

  function send<T>(type: string, payload: T): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    if (!config.identity) throw new Error('Legacy relay authentication requires an identity');
    const msg = createMessage(type, payload, config.identity);
    ws.send(serializeMessage(msg));
  }

  function waitForAck(ref: string, timeoutMs = 10_000): Promise<AckPayload> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(ref);
        reject(new Error(`Timeout waiting for ACK: ${ref}`));
      }, timeoutMs);
      pending.set(ref, { resolve, reject, timeout });
    });
  }

  function handleMessage(data: Buffer): void {
    let msg: Message;
    try {
      msg = parseMessage(data.toString('utf-8'));
    } catch {
      return;
    }

    switch (msg.type) {
      case MessageTypes.ACK: {
        const ack = msg.payload as AckPayload;
        const req = pending.get(ack.ref);
        if (req) {
          clearTimeout(req.timeout);
          pending.delete(ack.ref);
          req.resolve(ack);
        }
        break;
      }
      case MessageTypes.MATCH:
        events.onMatch?.(msg.payload as MatchPayload);
        break;
      case MessageTypes.CONSENT_FORWARD:
        events.onConsentForward?.(msg.payload as ConsentForwardPayload);
        break;
      case MessageTypes.CHANNEL_FORWARD:
        events.onChannelForward?.(msg.payload as ChannelForwardPayload);
        break;
      case MessageTypes.SEARCH_RESULTS:
        if (pendingSearchResolve) {
          pendingSearchResolve(msg.payload as SearchResultsPayload);
          pendingSearchResolve = null;
        }
        break;
    }
  }

  function doConnect(url: string): Promise<void> {
    if (!config.identity) return Promise.reject(new Error('Legacy relay authentication requires an identity'));
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);

      ws.on('open', () => {
        send(MessageTypes.AUTH, {});
      });

      ws.on('message', (data: Buffer) => {
        let msg: Message;
        try { msg = parseMessage(data.toString('utf-8')); } catch { return; }

        if (msg.type === MessageTypes.ACK && (msg.payload as AckPayload).ref === 'auth') {
          const ack = msg.payload as AckPayload;
          if (ack.status === 'ok') {
            connected = true;
            intentionalDisconnect = false;
            ws!.removeAllListeners('message');
            ws!.on('message', handleMessage);
            resolve();
          } else {
            reject(new Error(`Auth failed: ${ack.message}`));
          }
          return;
        }
      });

      ws.on('close', (code, reason) => {
        connected = false;
        events.onDisconnect?.(reason.toString() || `code:${code}`);
        scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (!connected) reject(err);
      });

      setTimeout(() => {
        if (!connected) reject(new Error('Connection timeout'));
      }, 10_000);
    });
  }

  function submitToUrl(url: string, operation: PublicationOperation): Promise<AckPayload> {
    return new Promise((resolve, reject) => {
      const admission = admissionFor(url, 'publication-write', operation);
      const operationSocket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Publication operation timeout')), 10_000);

      function finish(error?: Error, ack?: AckPayload): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (operationSocket.readyState === WebSocket.OPEN) operationSocket.close();
        if (error) reject(error);
        else resolve(ack!);
      }

      operationSocket.on('open', () => {
        const frame = createPublicationOperationFrame(operation, admission);
        operationSocket.send(serializePublicationOperationFrame(frame));
      });
      operationSocket.on('message', (data: Buffer) => {
        try {
          const message = parseMessage(data.toString('utf-8'));
          if (!verifyMessage(message)) throw new Error('Relay ACK signature is invalid');
          if (message.type !== MessageTypes.ACK) return;
          const ack = message.payload as AckPayload;
          if (ack.ref !== operation.publicationId) return;
          finish(undefined, ack);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      operationSocket.on('error', (error) => finish(error));
      operationSocket.on('close', () => {
        if (!settled) finish(new Error('Relay closed before acknowledging publication operation'));
      });
    });
  }

  function sendMailboxRequestToUrl(url: string, request: MailboxRequest): Promise<Message> {
    return new Promise((resolve, reject) => {
      const admission = admissionFor(
        url,
        request.action === 'fetch' ? 'mailbox-fetch' : 'mailbox-acknowledge',
        request,
      );
      const mailboxSocket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Mailbox request timeout')), 10_000);

      function finish(error?: Error, message?: Message): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (mailboxSocket.readyState === WebSocket.OPEN) mailboxSocket.close();
        if (error) reject(error);
        else resolve(message!);
      }

      mailboxSocket.on('open', () => {
        mailboxSocket.send(serializeMailboxRequestFrame(createMailboxRequestFrame(request, admission)));
      });
      mailboxSocket.on('message', (data: Buffer) => {
        try {
          const message = parseMessage(data.toString('utf8'));
          if (!verifyMessage(message)) throw new Error('Relay mailbox response signature is invalid');
          const payload = message.payload as Partial<MailboxResponsePayload & AckPayload>;
          if (payload.requestId !== request.requestId && payload.ref !== request.requestId) return;
          finish(undefined, message);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      mailboxSocket.on('error', (error) => finish(error));
      mailboxSocket.on('close', () => {
        if (!settled) finish(new Error('Relay closed before answering mailbox request'));
      });
    });
  }

  function sendMailboxDepositToUrl(url: string, request: MailboxDepositRequest): Promise<AckPayload> {
    return new Promise((resolve, reject) => {
      const admission = admissionFor(url, 'mailbox-deposit', request);
      const mailboxSocket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Mailbox deposit timeout')), 10_000);

      function finish(error?: Error, ack?: AckPayload): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (mailboxSocket.readyState === WebSocket.OPEN) mailboxSocket.close();
        if (error) reject(error);
        else resolve(ack!);
      }

      mailboxSocket.on('open', () => {
        mailboxSocket.send(serializeMailboxDepositFrame(createMailboxDepositFrame(request, admission)));
      });
      mailboxSocket.on('message', (data: Buffer) => {
        try {
          const message = parseMessage(data.toString('utf8'));
          if (!verifyMessage(message)) throw new Error('Relay mailbox deposit ACK signature is invalid');
          if (message.type !== MessageTypes.ACK) return;
          const ack = message.payload as AckPayload;
          if (ack.ref !== request.requestId) return;
          if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected mailbox deposit');
          finish(undefined, ack);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      mailboxSocket.on('error', (error) => finish(error));
      mailboxSocket.on('close', () => {
        if (!settled) finish(new Error('Relay closed before acknowledging mailbox deposit'));
      });
    });
  }

  function sendRelationshipMailboxRequestToUrl(
    url: string,
    request: RelationshipMailboxRequestV2,
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      const admission = admissionFor(
        url,
        request.action === 'fetch' ? 'mailbox-fetch' : 'mailbox-acknowledge',
        request,
      );
      const socket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Relationship mailbox request timeout')), 10_000);
      function finish(error?: Error, message?: Message): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        if (error) reject(error); else resolve(message!);
      }
      socket.on('open', () => socket.send(serializeRelationshipMailboxRequestFrameV2(
        createRelationshipMailboxRequestFrameV2(request, admission),
      )));
      socket.on('message', (data: Buffer) => {
        try {
          const message = parseMessage(data.toString('utf8'));
          if (!verifyMessage(message)) throw new Error('Relay relationship mailbox response signature is invalid');
          const payload = message.payload as Partial<MailboxResponsePayload & AckPayload>;
          if (payload.requestId !== request.requestId && payload.ref !== request.requestId) return;
          finish(undefined, message);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) finish(new Error('Relay closed before answering relationship mailbox request'));
      });
    });
  }

  function sendRelationshipMailboxDepositToUrl(
    url: string,
    request: RelationshipMailboxDepositV2,
  ): Promise<AckPayload> {
    return new Promise((resolve, reject) => {
      const admission = admissionFor(url, 'mailbox-deposit', request);
      const socket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Relationship mailbox deposit timeout')), 10_000);
      function finish(error?: Error, ack?: AckPayload): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        if (error) reject(error); else resolve(ack!);
      }
      socket.on('open', () => socket.send(serializeRelationshipMailboxDepositFrameV2(
        createRelationshipMailboxDepositFrameV2(request, admission),
      )));
      socket.on('message', (data: Buffer) => {
        try {
          const message = parseMessage(data.toString('utf8'));
          if (!verifyMessage(message)) throw new Error('Relay relationship mailbox ACK signature is invalid');
          if (message.type !== MessageTypes.ACK) return;
          const ack = message.payload as AckPayload;
          if (ack.ref !== request.requestId) return;
          if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected relationship mailbox deposit');
          finish(undefined, ack);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) finish(new Error('Relay closed before acknowledging relationship mailbox deposit'));
      });
    });
  }

  async function sendRelationshipMailboxRequest(request: RelationshipMailboxRequestV2): Promise<Message> {
    let lastError: unknown;
    for (const url of allUrls) {
      try { return await sendRelationshipMailboxRequestToUrl(url, request); } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
  }

  function searchV2ToUrl(url: string, request: SearchRequestV2): Promise<SearchResponsePayloadV2> {
    return new Promise((resolve, reject) => {
      const admission = admissionFor(url, 'search', request);
      const searchSocket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Protocol v2 search timeout')), 10_000);

      function finish(error?: Error, response?: SearchResponsePayloadV2): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (searchSocket.readyState === WebSocket.OPEN) searchSocket.close();
        if (error) reject(error);
        else resolve(response!);
      }

      searchSocket.on('open', () => {
        searchSocket.send(serializeSearchRequestFrameV2(createSearchRequestFrameV2(request, admission)));
      });
      searchSocket.on('message', (data: Buffer) => {
        try {
          const message = parseMessage(data.toString('utf8'));
          if (!verifyMessage(message)) throw new Error('Relay search response signature is invalid');
          if (message.type === MessageTypes.ACK) {
            const ack = message.payload as AckPayload;
            if (ack.ref !== request.searchId) return;
            throw new Error(ack.message ?? 'Relay rejected protocol v2 search');
          }
          if (message.type !== SEARCH_RESPONSE_MESSAGE_TYPE) return;
          if (!verifySearchResponsePayloadV2(message.payload)
            || message.payload.searchId !== request.searchId
            || message.payload.results.length > request.k) {
            throw new Error('Relay search response does not match the request');
          }
          finish(undefined, message.payload);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      searchSocket.on('error', (error) => finish(error));
      searchSocket.on('close', () => {
        if (!settled) finish(new Error('Relay closed before answering protocol v2 search'));
      });
    });
  }

  async function sendMailboxRequest(request: MailboxRequest): Promise<Message> {
    let lastError: unknown;
    for (const url of allUrls) {
      try { return await sendMailboxRequestToUrl(url, request); } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
  }

  return {
    async connect(): Promise<void> {
      intentionalDisconnect = false;
      // Try all URLs in order
      for (let i = 0; i < allUrls.length; i++) {
        try {
          currentUrl = allUrls[i];
          await doConnect(currentUrl);
          urlIndex = i;
          return;
        } catch {
          // Try next
        }
      }
      throw new Error('All relay URLs failed');
    },

    disconnect(): void {
      intentionalDisconnect = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        ws.close();
        ws = null;
        connected = false;
      }
    },

    async submitPublicationOperation(operation: PublicationOperation): Promise<AckPayload> {
      let lastError: unknown;
      for (const url of allUrls) {
        try {
          return await submitToUrl(url, operation);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    async fetchMailbox(record: PublicationRecord, keys: PublicationKeyMaterial): Promise<MailboxFetchResult> {
      const request = createMailboxRequest('fetch', record, keys);
      const response = await sendMailboxRequest(request);
      if (response.type === MessageTypes.ACK) {
        const ack = response.payload as AckPayload;
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
      let lastError: unknown;
      for (const url of allUrls) {
        try { return await sendMailboxDepositToUrl(url, request); } catch (error) { lastError = error; }
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
      const ack = response.payload as AckPayload;
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected mailbox acknowledgement');
      return ack;
    },

    async fetchRelationshipMailbox(keys: RelationshipKeyMaterial): Promise<RelationshipMailboxFetchResult> {
      const request = createRelationshipMailboxRequestV2('fetch', keys);
      const response = await sendRelationshipMailboxRequest(request);
      if (response.type === MessageTypes.ACK) {
        const ack = response.payload as AckPayload;
        throw new Error(ack.message ?? 'Relay rejected relationship mailbox fetch');
      }
      if (response.type !== MAILBOX_RESPONSE_MESSAGE_TYPE) throw new Error('Unexpected relationship mailbox response');
      const payload = response.payload as MailboxResponsePayload;
      if (payload.requestId !== request.requestId
        || payload.mailboxId !== keys.mailboxId
        || !Array.isArray(payload.envelopes)) throw new Error('Relationship mailbox response does not match request');
      return {
        envelopes: payload.envelopes,
      };
    },

    async depositRelationshipMailboxEnvelope(recipientRelationshipId, keys, envelope): Promise<AckPayload> {
      const request = createRelationshipMailboxDepositV2(recipientRelationshipId, keys, envelope);
      let lastError: unknown;
      for (const url of allUrls) {
        try { return await sendRelationshipMailboxDepositToUrl(url, request); } catch (error) { lastError = error; }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    async acknowledgeRelationshipMailbox(keys, envelopeIds): Promise<AckPayload> {
      const request = createRelationshipMailboxRequestV2('ack', keys, envelopeIds);
      const response = await sendRelationshipMailboxRequest(request);
      if (response.type !== MessageTypes.ACK) throw new Error('Unexpected relationship mailbox acknowledgement');
      const ack = response.payload as AckPayload;
      if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected relationship mailbox acknowledgement');
      return ack;
    },

    async searchV2(input: CreateSearchRequestInputV2): Promise<SearchResponsePayloadV2> {
      // createSearchRequestV2 generates fresh signing material on every call.
      const request = createSearchRequestV2(input);
      let lastError: unknown;
      for (const url of allUrls) {
        try { return await searchV2ToUrl(url, request); } catch (error) { lastError = error; }
      }
      throw lastError instanceof Error ? lastError : new Error('All relay URLs failed');
    },

    search(payload: SearchPayload): Promise<SearchResultsPayload> {
      return new Promise((resolve, reject) => {
        pendingSearchResolve = resolve;
        send(MessageTypes.SEARCH, payload);
        // Also wait for the ACK
        waitForAck('search').catch(() => {});
        setTimeout(() => {
          if (pendingSearchResolve) {
            pendingSearchResolve = null;
            reject(new Error('Search timeout'));
          }
        }, 10_000);
      });
    },

    async sendConsent(payload: ConsentPayload): Promise<AckPayload> {
      send(MessageTypes.CONSENT, payload);
      return waitForAck(payload.matchId);
    },

    sendChannelMessage(payload: ChannelMessagePayload): void {
      send(MessageTypes.CHANNEL_MESSAGE, payload);
    },

    isConnected(): boolean {
      return connected;
    },

    on(newEvents: Partial<RelayClientEvents>): void {
      Object.assign(events, newEvents);
    },
  };
}
