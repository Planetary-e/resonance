/** Destination key discovery through an entry relay, without a client-to-destination socket. */

import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { createMessage, parseMessage, serializeMessage, verifyMessage, type Message } from './protocol.js';
import {
  createRelayPeerRequestV1, isRelayDescriptorActiveV1,
  isRelayPeerRequestActiveV1, isRelayPeerResponseActiveV1,
  type RelayDescriptorV1, type RelayPeerRequestV1, type RelayPeerResponseV1,
} from './relay-discovery.js';
import { isRelayTransportKeyActiveV1, type RelayTransportKeyV1 } from './private-envelope.js';
import { assertSecureRelayTransportEndpoint } from './relay-transport.js';
import type { Identity } from './crypto.js';

export const PRIVATE_DISCOVERY_REQUEST_TYPE = 'private_discovery_request' as const;
export const PRIVATE_DISCOVERY_RESPONSE_TYPE = 'private_discovery_response' as const;
export const MAX_PRIVATE_DISCOVERY_FRAME_BYTES = 1024 * 1024;
const MAX_REQUEST_LIFETIME_MS = 15_000;

export interface PrivateDiscoveryRequestV1 {
  type: typeof PRIVATE_DISCOVERY_REQUEST_TYPE;
  version: 1;
  requestId: string;
  targetEndpoint: string;
  /** Signed one-use challenge forwarded unchanged to the destination. */
  peerRequest: RelayPeerRequestV1;
  createdAt: number;
  expiresAt: number;
}

export interface PrivateDiscoveryResponsePayloadV1 {
  version: 1;
  requestId: string;
  targetEndpoint: string;
  /** IP observed by the entry on its authenticated destination socket. */
  destinationRemoteAddress: string;
  peerResponse: RelayPeerResponseV1;
}

export interface VerifiedPrivateDiscoveryV1 {
  descriptor: RelayDescriptorV1;
  transportKey: RelayTransportKeyV1;
  destinationRemoteAddress: string;
}

export function createPrivateDiscoveryRequestV1(targetEndpoint: string, now = Date.now()): PrivateDiscoveryRequestV1 {
  assertSecureRelayTransportEndpoint(targetEndpoint);
  const request: PrivateDiscoveryRequestV1 = {
    type: PRIVATE_DISCOVERY_REQUEST_TYPE, version: 1,
    requestId: randomBytes(16).toString('base64url'),
    targetEndpoint,
    peerRequest: createRelayPeerRequestV1({
      supportedGroups: [], maxPeers: 1,
      createdAt: now, expiresAt: now + MAX_REQUEST_LIFETIME_MS,
    }),
    createdAt: now, expiresAt: now + MAX_REQUEST_LIFETIME_MS,
  };
  if (!isPrivateDiscoveryRequestV1(request, now)) throw new Error('Invalid private discovery request');
  return request;
}

export function parsePrivateDiscoveryRequestV1(raw: string, now = Date.now()): PrivateDiscoveryRequestV1 {
  if (Buffer.byteLength(raw) > 2048) throw new Error('Private discovery request is too large');
  const value: unknown = JSON.parse(raw);
  if (!isPrivateDiscoveryRequestV1(value, now)) throw new Error('Invalid private discovery request');
  return value;
}

export function serializePrivateDiscoveryRequestV1(request: PrivateDiscoveryRequestV1): string {
  if (!isPrivateDiscoveryRequestV1(request, request.createdAt)) {
    throw new Error('Invalid private discovery request');
  }
  return JSON.stringify(request);
}

export function createPrivateDiscoveryResponseV1(
  request: PrivateDiscoveryRequestV1,
  destinationRemoteAddress: string,
  peerResponse: RelayPeerResponseV1,
  entry: Identity,
  now = Date.now(),
): string {
  if (!isPrivateDiscoveryRequestV1(request, now)) throw new Error('Private discovery request expired');
  const payload: PrivateDiscoveryResponsePayloadV1 = {
    version: 1, requestId: request.requestId, targetEndpoint: request.targetEndpoint,
    destinationRemoteAddress, peerResponse,
  };
  if (!validResponsePayload(payload, request.peerRequest, now)) {
    throw new Error('Invalid destination discovery response');
  }
  const raw = serializeMessage(createMessage(PRIVATE_DISCOVERY_RESPONSE_TYPE, payload, entry));
  if (Buffer.byteLength(raw) > MAX_PRIVATE_DISCOVERY_FRAME_BYTES) {
    throw new Error('Private discovery response is too large');
  }
  return raw;
}

export function verifyPrivateDiscoveryResponseV1(
  raw: string,
  request: PrivateDiscoveryRequestV1,
  entryRelayId: string,
  now = Date.now(),
): VerifiedPrivateDiscoveryV1 {
  if (Buffer.byteLength(raw) > MAX_PRIVATE_DISCOVERY_FRAME_BYTES
    || !isPrivateDiscoveryRequestV1(request, now)) {
    throw new Error('Invalid or expired private discovery exchange');
  }
  const message = parseMessage(raw) as Message<unknown>;
  if (message.type !== PRIVATE_DISCOVERY_RESPONSE_TYPE || message.from !== entryRelayId
    || !Number.isSafeInteger(message.timestamp) || message.timestamp < request.createdAt
    || message.timestamp > now + 5_000 || now - message.timestamp > MAX_REQUEST_LIFETIME_MS
    || !verifyMessage(message)) {
    throw new Error('Invalid private discovery entry signature');
  }
  const payload = message.payload;
  if (!validResponsePayload(payload, request.peerRequest, now)
    || payload.requestId !== request.requestId
    || payload.targetEndpoint !== request.targetEndpoint) {
    throw new Error('Private discovery response does not match request');
  }
  const response = payload.peerResponse;
  const descriptor = response.descriptors.find(value => value.relayId === response.responderId);
  if (!descriptor || descriptor.reachability !== 'direct'
    || descriptor.endpoints[0] !== request.targetEndpoint
    || !response.transportKey) throw new Error('Private destination did not bind its endpoint and key');
  return {
    descriptor,
    transportKey: response.transportKey,
    destinationRemoteAddress: payload.destinationRemoteAddress,
  };
}

function isPrivateDiscoveryRequestV1(value: unknown, now: number): value is PrivateDiscoveryRequestV1 {
  if (!isObject(value) || !onlyKeys(value,
    ['type', 'version', 'requestId', 'targetEndpoint', 'peerRequest', 'createdAt', 'expiresAt'])) return false;
  if (value.type !== PRIVATE_DISCOVERY_REQUEST_TYPE || value.version !== 1
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.requestId)
    || typeof value.targetEndpoint !== 'string' || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(now)) return false;
  try { assertSecureRelayTransportEndpoint(value.targetEndpoint); }
  catch { return false; }
  return isRelayPeerRequestActiveV1(value.peerRequest, now)
    && value.peerRequest.createdAt === value.createdAt
    && value.peerRequest.expiresAt === value.expiresAt
    && value.peerRequest.maxPeers === 1
    && value.peerRequest.supportedGroups.length === 0
    && value.createdAt >= 0 && value.createdAt <= now + 5_000
    && now < value.expiresAt
    && value.expiresAt - value.createdAt === MAX_REQUEST_LIFETIME_MS;
}

function validResponsePayload(
  value: unknown, request: RelayPeerRequestV1, now: number,
): value is PrivateDiscoveryResponsePayloadV1 {
  if (!isObject(value) || !onlyKeys(value, [
    'version', 'requestId', 'targetEndpoint', 'destinationRemoteAddress', 'peerResponse',
  ]) || value.version !== 1 || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9_-]{22}$/.test(value.requestId)
    || typeof value.targetEndpoint !== 'string'
    || typeof value.destinationRemoteAddress !== 'string'
    || isIP(value.destinationRemoteAddress) === 0
    || !isRelayPeerResponseActiveV1(value.peerResponse, request, now)) return false;
  try { assertSecureRelayTransportEndpoint(value.targetEndpoint); }
  catch { return false; }
  if (!observedAddressMatchesLiteralEndpoint(
    value.destinationRemoteAddress, value.targetEndpoint,
  )) return false;
  const response = value.peerResponse;
  if (response.createdAt > now + 5_000 || now >= response.expiresAt
    || !response.transportKey || !isRelayTransportKeyActiveV1(response.transportKey, now)) return false;
  const descriptor = response.descriptors.find(candidate => candidate.relayId === response.responderId);
  return !!descriptor && isRelayDescriptorActiveV1(descriptor, now)
    && descriptor.reachability === 'direct'
    && descriptor.endpoints[0] === value.targetEndpoint
    && response.transportKey.relayId === descriptor.relayId;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function observedAddressMatchesLiteralEndpoint(address: string, endpoint: string): boolean {
  const targetHost = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  if (isIP(targetHost) === 0) return true;
  const observed = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(targetHost) !== isIP(observed)) return false;
  if (isIP(targetHost) === 4) return targetHost === observed;
  return new URL(`http://[${targetHost}]/`).hostname
    === new URL(`http://[${observed}]/`).hostname;
}
