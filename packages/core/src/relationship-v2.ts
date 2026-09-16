/** Publication-bound consent messages for protocol v2 pairwise channels. */

import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  generateEphemeralKeyPair,
  generateSigningKeyPair,
  sha512,
  sign,
  verify,
  type KeyPair,
  type SigningKeyPair,
} from './crypto.js';
import {
  PROTOCOL_V2_VERSION,
  verifyPublicationRecord,
  type PublicationKeyMaterial,
  type PublicationRecord,
} from './protocol-v2.js';

const CONSENT_SIGNATURE_DOMAIN = 'resonance:discovery:v2:pairwise-consent';

export interface RelationshipKeyMaterial {
  relationshipId: string;
  signingKeyPair: SigningKeyPair;
  channelKeyPair: KeyPair;
  mailboxId: string;
  mailboxKeyPair: KeyPair;
}

export interface RelationshipMailboxV2 {
  id: string;
  encryptionKey: string;
}

export interface PublicationReferenceV2 {
  publicationId: string;
}

export interface ConsentOfferBodyV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'consent-offer';
  messageId: string;
  matchId: string;
  senderPublicationId: string;
  senderPublicationKey: string;
  recipientPublicationId: string;
  senderRelationshipId: string;
  senderRelationshipKey: string;
  senderChannelKey: string;
  senderMailbox: RelationshipMailboxV2;
  createdAt: number;
  expiresAt: number;
}

export interface ConsentOfferV2 extends ConsentOfferBodyV2 {
  signature: string;
}

export interface ConsentAcceptBodyV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'consent-accept';
  messageId: string;
  offerId: string;
  matchId: string;
  channelId: string;
  senderPublicationId: string;
  senderPublicationKey: string;
  recipientPublicationId: string;
  senderRelationshipId: string;
  senderRelationshipKey: string;
  senderChannelKey: string;
  senderMailbox: RelationshipMailboxV2;
  recipientRelationshipId: string;
  createdAt: number;
  expiresAt: number;
}

export interface ConsentAcceptV2 extends ConsentAcceptBodyV2 {
  signature: string;
}

export type RelationshipMessageV2 = ConsentOfferV2 | ConsentAcceptV2;

export function generateRelationshipKeyMaterial(): RelationshipKeyMaterial {
  const signingKeyPair = generateSigningKeyPair();
  const mailboxKeyPair = generateEphemeralKeyPair();
  return {
    relationshipId: idFromKey('rel', signingKeyPair.publicKey),
    signingKeyPair,
    channelKeyPair: generateEphemeralKeyPair(),
    mailboxId: idFromKey('rmbx', signingKeyPair.publicKey),
    mailboxKeyPair,
  };
}

export function createConsentOfferV2(
  matchId: string,
  sender: PublicationRecord,
  recipient: PublicationReferenceV2,
  publicationKeys: PublicationKeyMaterial,
  relationshipKeys: RelationshipKeyMaterial,
  createdAt = Date.now(),
  expiresAt = createdAt + 7 * 24 * 60 * 60 * 1000,
): ConsentOfferV2 {
  assertPublicationOwnership(sender, publicationKeys);
  if (!isOpaqueId(recipient.publicationId, 'pub')) throw new Error('Consent recipient publication is invalid');
  if (matchId !== deterministicMatchId(sender.publicationId, recipient.publicationId)) {
    throw new Error('Consent offer does not belong to these publications');
  }
  assertRelationshipKeys(relationshipKeys);
  const bodyWithoutId = {
    version: PROTOCOL_V2_VERSION,
    kind: 'consent-offer' as const,
    matchId,
    senderPublicationId: sender.publicationId,
    senderPublicationKey: sender.publicationKey,
    recipientPublicationId: recipient.publicationId,
    senderRelationshipId: relationshipKeys.relationshipId,
    senderRelationshipKey: encodeBase64(relationshipKeys.signingKeyPair.publicKey),
    senderChannelKey: encodeBase64(relationshipKeys.channelKeyPair.publicKey),
    senderMailbox: {
      id: relationshipKeys.mailboxId,
      encryptionKey: encodeBase64(relationshipKeys.mailboxKeyPair.publicKey),
    },
    createdAt,
    expiresAt,
  };
  const body: ConsentOfferBodyV2 = {
    ...bodyWithoutId,
    messageId: derivedId('cns', `resonance:discovery:v2:consent-message\n${canonicalize(bodyWithoutId)}`),
  };
  if (!isConsentOfferBody(body)) throw new Error('Invalid consent offer input');
  return signConsentBody(body, publicationKeys);
}

export function createConsentAcceptV2(
  offer: ConsentOfferV2,
  sender: PublicationRecord,
  publicationKeys: PublicationKeyMaterial,
  relationshipKeys: RelationshipKeyMaterial,
  createdAt = Date.now(),
  expiresAt = offer.expiresAt,
): ConsentAcceptV2 {
  if (!verifyConsentOfferV2(offer)) throw new Error('Cannot accept an invalid consent offer');
  assertPublicationOwnership(sender, publicationKeys);
  assertRelationshipKeys(relationshipKeys);
  if (sender.publicationId !== offer.recipientPublicationId) {
    throw new Error('Consent acceptance sender is not the offer recipient');
  }
  const channelId = createPairwiseChannelId(
    offer.matchId,
    offer.senderRelationshipId,
    relationshipKeys.relationshipId,
  );
  const bodyWithoutId = {
    version: PROTOCOL_V2_VERSION,
    kind: 'consent-accept' as const,
    offerId: offer.messageId,
    matchId: offer.matchId,
    channelId,
    senderPublicationId: sender.publicationId,
    senderPublicationKey: sender.publicationKey,
    recipientPublicationId: offer.senderPublicationId,
    senderRelationshipId: relationshipKeys.relationshipId,
    senderRelationshipKey: encodeBase64(relationshipKeys.signingKeyPair.publicKey),
    senderChannelKey: encodeBase64(relationshipKeys.channelKeyPair.publicKey),
    senderMailbox: {
      id: relationshipKeys.mailboxId,
      encryptionKey: encodeBase64(relationshipKeys.mailboxKeyPair.publicKey),
    },
    recipientRelationshipId: offer.senderRelationshipId,
    createdAt,
    expiresAt,
  };
  const body: ConsentAcceptBodyV2 = {
    ...bodyWithoutId,
    messageId: derivedId('cns', `resonance:discovery:v2:consent-message\n${canonicalize(bodyWithoutId)}`),
  };
  if (!isConsentAcceptBody(body)) throw new Error('Invalid consent acceptance input');
  return signConsentBody(body, publicationKeys);
}

export function verifyConsentOfferV2(value: unknown): value is ConsentOfferV2 {
  return verifyConsentMessage(value, isConsentOfferBody);
}

export function verifyConsentAcceptV2(value: unknown): value is ConsentAcceptV2 {
  return verifyConsentMessage(value, isConsentAcceptBody);
}

export function verifyRelationshipMessageV2(value: unknown): value is RelationshipMessageV2 {
  return verifyConsentOfferV2(value) || verifyConsentAcceptV2(value);
}

export function createPairwiseChannelId(
  matchId: string,
  firstRelationshipId: string,
  secondRelationshipId: string,
): string {
  const pair = [firstRelationshipId, secondRelationshipId].sort();
  return derivedId('chn', `resonance:discovery:v2:channel\n${matchId}\n${pair[0]}\n${pair[1]}`);
}

function signConsentBody<T extends ConsentOfferBodyV2 | ConsentAcceptBodyV2>(
  body: T,
  keys: PublicationKeyMaterial,
): T & { signature: string } {
  return {
    ...body,
    signature: encodeBase64(sign(signableConsentBody(body), keys.signingKeyPair.secretKey)),
  };
}

function verifyConsentMessage<T extends ConsentOfferBodyV2 | ConsentAcceptBodyV2>(
  value: unknown,
  bodyGuard: (body: unknown) => body is T,
): value is T & { signature: string } {
  if (!isObject(value) || typeof value.signature !== 'string') return false;
  const { signature, ...body } = value;
  if (!bodyGuard(body)) return false;
  try {
    return verify(
      signableConsentBody(body),
      decodeBase64(signature),
      decodeBase64(body.senderPublicationKey),
    );
  } catch {
    return false;
  }
}

function isConsentOfferBody(value: unknown): value is ConsentOfferBodyV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'kind', 'matchId', 'messageId', 'recipientPublicationId',
    'senderChannelKey', 'senderMailbox', 'senderPublicationId', 'senderPublicationKey',
    'senderRelationshipId', 'senderRelationshipKey', 'version',
  ])) return false;
  if (!isCommonConsentBody(value) || value.kind !== 'consent-offer') return false;
  const { messageId: _messageId, ...bodyWithoutId } = value;
  return value.messageId === derivedId(
    'cns',
    `resonance:discovery:v2:consent-message\n${canonicalize(bodyWithoutId)}`,
  );
}

function isConsentAcceptBody(value: unknown): value is ConsentAcceptBodyV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'channelId', 'createdAt', 'expiresAt', 'kind', 'matchId', 'messageId', 'offerId',
    'recipientPublicationId', 'recipientRelationshipId', 'senderChannelKey', 'senderMailbox',
    'senderPublicationId', 'senderPublicationKey', 'senderRelationshipId',
    'senderRelationshipKey', 'version',
  ])) return false;
  if (!isCommonConsentBody(value) || value.kind !== 'consent-accept') return false;
  if (!isOpaqueId(value.offerId, 'cns') || !isOpaqueId(value.recipientRelationshipId, 'rel')) return false;
  if (value.channelId !== createPairwiseChannelId(
    value.matchId as string,
    value.senderRelationshipId as string,
    value.recipientRelationshipId,
  )) return false;
  const { messageId: _messageId, ...bodyWithoutId } = value;
  return value.messageId === derivedId(
    'cns',
    `resonance:discovery:v2:consent-message\n${canonicalize(bodyWithoutId)}`,
  );
}

function isCommonConsentBody(value: Record<string, unknown>): boolean {
  return value.version === PROTOCOL_V2_VERSION
    && isOpaqueId(value.messageId, 'cns')
    && isOpaqueId(value.matchId, 'match')
    && isOpaqueId(value.senderPublicationId, 'pub')
    && isBase64OfLength(value.senderPublicationKey, 32)
    && idMatchesKey(value.senderPublicationId as string, 'pub', value.senderPublicationKey as string)
    && isOpaqueId(value.recipientPublicationId, 'pub')
    && value.matchId === deterministicMatchId(
      value.senderPublicationId as string,
      value.recipientPublicationId as string,
    )
    && isOpaqueId(value.senderRelationshipId, 'rel')
    && isBase64OfLength(value.senderRelationshipKey, 32)
    && idMatchesKey(value.senderRelationshipId as string, 'rel', value.senderRelationshipKey as string)
    && isBase64OfLength(value.senderChannelKey, 32)
    && isRelationshipMailbox(value.senderMailbox, value.senderRelationshipKey as string)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.expiresAt)
    && (value.expiresAt as number) > (value.createdAt as number);
}

function assertPublicationOwnership(record: PublicationRecord, keys: PublicationKeyMaterial): void {
  if (!verifyPublicationRecord(record)
    || record.publicationId !== keys.publicationId
    || record.publicationKey !== encodeBase64(keys.signingKeyPair.publicKey)) {
    throw new Error('Consent signing keys do not own the sender publication');
  }
}

function assertRelationshipKeys(keys: RelationshipKeyMaterial): void {
  if (keys.relationshipId !== idFromKey('rel', keys.signingKeyPair.publicKey)
    || keys.signingKeyPair.secretKey.length !== 64
    || keys.channelKeyPair.publicKey.length !== 32
    || keys.channelKeyPair.secretKey.length !== 32
    || keys.mailboxId !== idFromKey('rmbx', keys.signingKeyPair.publicKey)
    || keys.mailboxKeyPair.publicKey.length !== 32
    || keys.mailboxKeyPair.secretKey.length !== 32) {
    throw new Error('Invalid relationship key material');
  }
}

function signableConsentBody(body: ConsentOfferBodyV2 | ConsentAcceptBodyV2): Uint8Array {
  return decodeUTF8(`${CONSENT_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function deterministicMatchId(first: string, second: string): string {
  const pair = [first, second].sort();
  return derivedId('match', `resonance:discovery:v2:match\n${pair[0]}\n${pair[1]}`);
}

function idFromKey(prefix: 'rel' | 'rmbx', key: Uint8Array): string {
  return `${prefix}_${encodeBase64(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function derivedId(prefix: 'match' | 'cns' | 'chn', input: string): string {
  const bytes = sha512(decodeUTF8(input)).slice(0, 32);
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function idMatchesKey(id: string, prefix: 'pub' | 'rel', encodedKey: string): boolean {
  try {
    const base64url = encodeBase64(decodeBase64(encodedKey))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return id === `${prefix}_${base64url}`;
  } catch {
    return false;
  }
}

function isOpaqueId(value: unknown, prefix: 'pub' | 'match' | 'rel' | 'cns' | 'chn'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isRelationshipMailbox(value: unknown, relationshipKey: string): value is RelationshipMailboxV2 {
  if (!isObject(value)
    || !hasOnlyKeys(value, ['encryptionKey', 'id'])
    || typeof value.id !== 'string'
    || !/^rmbx_[A-Za-z0-9_-]{43}$/.test(value.id)
    || !isBase64OfLength(value.encryptionKey, 32)) return false;
  try {
    return value.id === idFromKey('rmbx', decodeBase64(relationshipKey));
  } catch {
    return false;
  }
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 100_000) return false;
  try { return decodeBase64(value).length === length; } catch { return false; }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}
