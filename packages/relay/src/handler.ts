/**
 * Message handlers: dispatch verified messages to type-specific logic.
 */

import type WebSocket from 'ws';
import {
  MessageTypes,
  createMessage,
  generateIdentity,
  serializeMessage,
  type Message,
  type PublishPayload,
  type SearchPayload,
  type ConsentPayload,
  type WithdrawPayload,
  type AckPayload,
  type MatchPayload,
  type SearchResultsPayload,
  type ConsentForwardPayload,
  type ChannelMessagePayload,
  type ChannelForwardPayload,
  type Identity,
} from '@resonance/core';
import { MatchingEngine, type MatchNotification } from './matching-engine.js';
import { RateLimiter } from './rate-limiter.js';
import { log } from './logger.js';

export interface ClientState {
  did: string;
  ws: WebSocket;
  authenticated: boolean;
}

export interface HandlerContext {
  engine: MatchingEngine;
  rateLimiter: RateLimiter;
  clients: Map<string, ClientState>;
  relayIdentity: Identity;
  matchThreshold: number;
  matchK: number;
  matchExpiryMs: number;
  /** Map from matchId → { publisherDID, matchedDID } for consent forwarding */
  matchRegistry: Map<string, { publisherDID: string; matchedDID: string; createdAt: number }>;
}

function sendAck(ctx: HandlerContext, ws: WebSocket, ref: string, status: 'ok' | 'error', message?: string): void {
  const ack = createMessage<AckPayload>(MessageTypes.ACK, { ref, status, message }, ctx.relayIdentity);
  ws.send(serializeMessage(ack));
}

function sendToClient(ctx: HandlerContext, did: string, msg: Message): void {
  const client = ctx.clients.get(did);
  if (client?.ws.readyState === 1 /* OPEN */) {
    client.ws.send(serializeMessage(msg));
  }
}

export function handlePublish(ctx: HandlerContext, client: ClientState, msg: Message<PublishPayload>): void {
  const { payload } = msg;

  if (!ctx.rateLimiter.check(client.did, 'publish')) {
    sendAck(ctx, client.ws, payload.itemId, 'error', 'rate_limited');
    return;
  }

  const notifications = ctx.engine.insertAndMatch(
    payload.vector,
    { did: client.did, itemType: payload.itemType, itemId: payload.itemId },
    ctx.matchK,
    ctx.matchThreshold,
  );

  // Send match notifications to both parties
  for (const n of notifications) {
    ctx.matchRegistry.set(n.matchId, { publisherDID: n.publisherDID, matchedDID: n.matchedDID, createdAt: Date.now() });

    // Notify the publisher (current client)
    const publisherMatch = createMessage<MatchPayload>(MessageTypes.MATCH, {
      matchId: n.matchId,
      partnerDID: n.matchedDID,
      similarity: n.similarity,
      yourItemId: n.publisherItemId,
      partnerItemType: n.matchedItemType,
      expiry: n.expiry,
    }, ctx.relayIdentity);
    sendToClient(ctx, n.publisherDID, publisherMatch);

    // Notify the matched partner
    const partnerMatch = createMessage<MatchPayload>(MessageTypes.MATCH, {
      matchId: n.matchId,
      partnerDID: n.publisherDID,
      similarity: n.similarity,
      yourItemId: n.matchedItemId,
      partnerItemType: n.publisherItemType,
      expiry: n.expiry,
    }, ctx.relayIdentity);
    sendToClient(ctx, n.matchedDID, partnerMatch);

    log('info', 'match', { matchId: n.matchId, similarity: n.similarity });
  }

  sendAck(ctx, client.ws, payload.itemId, 'ok');
  log('info', 'publish', { did: client.did, itemType: payload.itemType, itemId: payload.itemId });
}

export function handleSearch(ctx: HandlerContext, client: ClientState, msg: Message<SearchPayload>): void {
  const { payload } = msg;

  if (!ctx.rateLimiter.check(client.did, 'search')) {
    sendAck(ctx, client.ws, 'search', 'error', 'rate_limited');
    return;
  }

  // Ephemeral search — infer queryType from the search context (default: 'need' searches offers)
  const results = ctx.engine.search(payload.vector, 'need', payload.k, payload.threshold);

  const response = createMessage<SearchResultsPayload>(MessageTypes.SEARCH_RESULTS, {
    results: results.map(r => ({ did: r.did, similarity: r.similarity, itemType: r.itemType })),
  }, ctx.relayIdentity);
  sendToClient(ctx, client.did, response);

  sendAck(ctx, client.ws, 'search', 'ok');
  log('info', 'search', { did: client.did, resultCount: results.length });
}

export function handleConsent(ctx: HandlerContext, client: ClientState, msg: Message<ConsentPayload>): void {
  const { payload } = msg;
  const match = ctx.matchRegistry.get(payload.matchId);

  if (!match) {
    sendAck(ctx, client.ws, payload.matchId, 'error', 'unknown_match');
    return;
  }

  // Determine the partner DID
  const partnerDID = client.did === match.publisherDID ? match.matchedDID : match.publisherDID;

  // Forward consent to partner
  const forward = createMessage<ConsentForwardPayload>(MessageTypes.CONSENT_FORWARD, {
    matchId: payload.matchId,
    fromDID: client.did,
    encrypted: payload.encryptedForPartner,
  }, ctx.relayIdentity);
  sendToClient(ctx, partnerDID, forward);

  sendAck(ctx, client.ws, payload.matchId, 'ok');
  log('info', 'consent', { matchId: payload.matchId, from: client.did, accept: payload.accept });
}

export function handleWithdraw(ctx: HandlerContext, client: ClientState, msg: Message<WithdrawPayload>): void {
  const { payload } = msg;
  ctx.engine.withdraw(client.did, payload.itemId);
  sendAck(ctx, client.ws, payload.itemId, 'ok');
  log('info', 'withdraw', { did: client.did, itemId: payload.itemId });
}

export function handleChannelMessage(ctx: HandlerContext, client: ClientState, msg: Message<ChannelMessagePayload>): void {
  const { payload } = msg;
  const match = ctx.matchRegistry.get(payload.matchId);

  if (!match) {
    sendAck(ctx, client.ws, payload.matchId, 'error', 'unknown_match');
    return;
  }

  const partnerDID = client.did === match.publisherDID ? match.matchedDID : match.publisherDID;

  const forward = createMessage<ChannelForwardPayload>(MessageTypes.CHANNEL_FORWARD, {
    matchId: payload.matchId,
    fromDID: client.did,
    encrypted: payload.encrypted,
    nonce: payload.nonce,
  }, ctx.relayIdentity);
  sendToClient(ctx, partnerDID, forward);

  log('info', 'channel_forward', { matchId: payload.matchId, from: client.did });
}
