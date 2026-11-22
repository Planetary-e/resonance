import {
  createChannelMessageOperationV2,
  decryptChannelContentV2,
  verifyChannelOperationV2,
  type ChannelMessageOperationV2,
} from './channel-v2.js';
import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  sha512,
  sign,
  verify,
} from './crypto.js';
import type { RelationshipKeyMaterial } from './relationship-v2.js';
import {
  createLeasedIndexGenerationIdV1,
  verifyOriginalCommitmentV1,
  verifyLeasedIndexV1,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from './leased-index-v1.js';

export const CONTENT_REQUEST_KIND = 'content-request' as const;
export const CONTENT_GRANT_KIND = 'content-grant' as const;
export const CONTENT_RESPONSE_KIND = 'content-response' as const;
export const MAX_CONTENT_ORIGINAL_BYTES = 8192;

const REQUEST_DOMAIN = 'resonance:content-request:v1';
const GRANT_DOMAIN = 'resonance:content-grant:v1';
const RESPONSE_DOMAIN = 'resonance:content-response:v1';

export interface ContentRequestBodyV1 {
  version: 1;
  kind: typeof CONTENT_REQUEST_KIND;
  requestId: string;
  channelId: string;
  requesterPublicationId: string;
  requesterRelationshipId: string;
  publicationId: string;
  generationId: string;
  contentCommitment: string;
  requesterPublicationKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface ContentRequestV1 extends ContentRequestBodyV1 {
  signature: string;
}

export interface ContentGrantBodyV1 {
  version: 1;
  kind: typeof CONTENT_GRANT_KIND;
  grantId: string;
  requestId: string;
  channelId: string;
  requesterPublicationId: string;
  requesterRelationshipId: string;
  publicationId: string;
  generationId: string;
  contentCommitment: string;
  ownerPublicationKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface ContentGrantV1 extends ContentGrantBodyV1 {
  signature: string;
}

export interface ContentResponseBodyV1 {
  version: 1;
  kind: typeof CONTENT_RESPONSE_KIND;
  responseId: string;
  requestId: string;
  grantId: string;
  channelId: string;
  requesterPublicationId: string;
  requesterRelationshipId: string;
  publicationId: string;
  generationId: string;
  contentCommitment: string;
  originalBytes: string;
  commitmentKey: string;
  grant: ContentGrantV1;
  ownerPublicationKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface ContentResponseV1 extends ContentResponseBodyV1 {
  signature: string;
}

export type ContentChannelRecordV1 = ContentRequestV1 | ContentGrantV1 | ContentResponseV1;

export function createContentRequestV1(input: {
  channelId: string;
  requesterRelationshipId: string;
  index: LeasedIndexV1;
  createdAt: number;
  expiresAt: number;
}, requester: LeasedIndexKeyMaterialV1): ContentRequestV1 {
  if (!verifyLeasedIndexV1(input.index)) throw new Error('Invalid content request index');
  const base = {
    version: 1 as const,
    kind: CONTENT_REQUEST_KIND,
    channelId: input.channelId,
    requesterPublicationId: requester.publicationId,
    requesterRelationshipId: input.requesterRelationshipId,
    publicationId: input.index.publicationId,
    generationId: createLeasedIndexGenerationIdV1(input.index),
    contentCommitment: input.index.original.commitment,
    requesterPublicationKey: encodeBase64(requester.signingKeyPair.publicKey),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const body = { ...base, requestId: derivedId('creq', `${REQUEST_DOMAIN}:id\n${canonicalize(base)}`) };
  const request = {
    ...body,
    signature: encodeBase64(sign(signable(REQUEST_DOMAIN, body), requester.signingKeyPair.secretKey)),
  };
  if (!verifyContentRequestV1(request)) throw new Error('Invalid content request input');
  return request;
}

export function verifyContentRequestV1(value: unknown): value is ContentRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [...REQUEST_KEYS, 'signature'])) return false;
  const { signature, ...body } = value;
  if (!isRequestBody(body) || !isBase64(signature, 64)) return false;
  const { requestId, ...stable } = body;
  if (requestId !== derivedId('creq', `${REQUEST_DOMAIN}:id\n${canonicalize(stable)}`)) return false;
  try {
    return verify(signable(REQUEST_DOMAIN, body), decodeBase64(signature), decodeBase64(body.requesterPublicationKey));
  } catch {
    return false;
  }
}

export function createContentGrantV1(
  request: ContentRequestV1,
  index: LeasedIndexV1,
  owner: LeasedIndexKeyMaterialV1,
  createdAt: number,
  expiresAt: number,
): ContentGrantV1 {
  if (!verifyContentRequestV1(request) || !verifyLeasedIndexV1(index)
    || request.generationId !== createLeasedIndexGenerationIdV1(index)
    || request.publicationId !== index.publicationId
    || owner.publicationId !== index.publicationId
    || encodeBase64(owner.signingKeyPair.publicKey) !== index.publicationKey
    || createdAt < request.createdAt
    || expiresAt > index.expiresAt || expiresAt > request.expiresAt) {
    throw new Error('Invalid content grant input');
  }
  const base = {
    version: 1 as const,
    kind: CONTENT_GRANT_KIND,
    requestId: request.requestId,
    channelId: request.channelId,
    requesterPublicationId: request.requesterPublicationId,
    requesterRelationshipId: request.requesterRelationshipId,
    publicationId: request.publicationId,
    generationId: request.generationId,
    contentCommitment: request.contentCommitment,
    ownerPublicationKey: index.publicationKey,
    createdAt,
    expiresAt,
  };
  const body = { ...base, grantId: derivedId('cgrant', `${GRANT_DOMAIN}:id\n${canonicalize(base)}`) };
  const grant = {
    ...body,
    signature: encodeBase64(sign(signable(GRANT_DOMAIN, body), owner.signingKeyPair.secretKey)),
  };
  if (!verifyContentGrantV1(grant)) throw new Error('Invalid content grant input');
  return grant;
}

export function verifyContentGrantV1(value: unknown): value is ContentGrantV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [...GRANT_KEYS, 'signature'])) return false;
  const { signature, ...body } = value;
  if (!isGrantBody(body) || !isBase64(signature, 64)) return false;
  const { grantId, ...stable } = body;
  if (grantId !== derivedId('cgrant', `${GRANT_DOMAIN}:id\n${canonicalize(stable)}`)) return false;
  try {
    return verify(signable(GRANT_DOMAIN, body), decodeBase64(signature), decodeBase64(body.ownerPublicationKey));
  } catch {
    return false;
  }
}

export function verifyContentGrantForRequestV1(
  grant: ContentGrantV1,
  request: ContentRequestV1,
): boolean {
  return verifyContentGrantV1(grant) && verifyContentRequestV1(request)
    && grant.requestId === request.requestId
    && grant.channelId === request.channelId
    && grant.requesterPublicationId === request.requesterPublicationId
    && grant.requesterRelationshipId === request.requesterRelationshipId
    && grant.publicationId === request.publicationId
    && grant.generationId === request.generationId
    && grant.contentCommitment === request.contentCommitment
    && grant.createdAt >= request.createdAt
    && grant.expiresAt <= request.expiresAt;
}

export function createContentResponseV1(input: {
  grant: ContentGrantV1;
  index: LeasedIndexV1;
  originalBytes: Uint8Array;
  commitmentKey: Uint8Array;
  owner: LeasedIndexKeyMaterialV1;
  createdAt: number;
}): ContentResponseV1 {
  const { grant, index, originalBytes, commitmentKey, owner } = input;
  if (!verifyContentGrantV1(grant) || !verifyLeasedIndexV1(index)
    || grant.generationId !== createLeasedIndexGenerationIdV1(index)
    || grant.publicationId !== index.publicationId
    || owner.publicationId !== index.publicationId
    || encodeBase64(owner.signingKeyPair.publicKey) !== index.publicationKey
    || !verifyOriginalCommitmentV1(originalBytes, commitmentKey, grant.contentCommitment)
    || input.createdAt < grant.createdAt || input.createdAt >= grant.expiresAt) {
    throw new Error('Invalid content response input');
  }
  const base = {
    version: 1 as const,
    kind: CONTENT_RESPONSE_KIND,
    requestId: grant.requestId,
    grantId: grant.grantId,
    channelId: grant.channelId,
    requesterPublicationId: grant.requesterPublicationId,
    requesterRelationshipId: grant.requesterRelationshipId,
    publicationId: grant.publicationId,
    generationId: grant.generationId,
    contentCommitment: grant.contentCommitment,
    originalBytes: encodeBase64(originalBytes),
    commitmentKey: encodeBase64(commitmentKey),
    grant,
    ownerPublicationKey: grant.ownerPublicationKey,
    createdAt: input.createdAt,
    expiresAt: grant.expiresAt,
  };
  const body = { ...base, responseId: derivedId('cresp', `${RESPONSE_DOMAIN}:id\n${canonicalize(base)}`) };
  const response = {
    ...body,
    signature: encodeBase64(sign(signable(RESPONSE_DOMAIN, body), owner.signingKeyPair.secretKey)),
  };
  if (!verifyContentResponseV1(response)) throw new Error('Invalid content response input');
  return response;
}

export function verifyContentResponseV1(value: unknown): value is ContentResponseV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [...RESPONSE_KEYS, 'signature'])) return false;
  const { signature, ...body } = value;
  if (!isResponseBody(body) || !isBase64(signature, 64)) return false;
  const { responseId, ...stable } = body;
  if (responseId !== derivedId('cresp', `${RESPONSE_DOMAIN}:id\n${canonicalize(stable)}`)) return false;
  try {
    if (!verify(signable(RESPONSE_DOMAIN, body), decodeBase64(signature), decodeBase64(body.ownerPublicationKey))) {
      return false;
    }
    return verifyOriginalCommitmentV1(
      decodeBase64(body.originalBytes),
      decodeBase64(body.commitmentKey),
      body.contentCommitment,
    );
  } catch {
    return false;
  }
}

export function verifyContentResponseForRequestV1(
  response: ContentResponseV1,
  request: ContentRequestV1,
): boolean {
  return verifyContentResponseV1(response) && verifyContentRequestV1(request)
    && verifyContentGrantForRequestV1(response.grant, request)
    && response.requestId === request.requestId
    && response.grantId === response.grant.grantId
    && response.channelId === request.channelId
    && response.requesterPublicationId === request.requesterPublicationId
    && response.requesterRelationshipId === request.requesterRelationshipId
    && response.publicationId === request.publicationId
    && response.generationId === request.generationId
    && response.contentCommitment === request.contentCommitment
    && response.ownerPublicationKey === response.grant.ownerPublicationKey
    && response.expiresAt <= response.grant.expiresAt;
}

export function createContentChannelOperationV2(input: {
  record: ContentChannelRecordV1;
  recipientRelationshipId: string;
  sequence: number;
  sharedKey: Uint8Array;
  relationshipKeys: RelationshipKeyMaterial;
  createdAt: number;
  expiresAt: number;
}): ChannelMessageOperationV2 {
  if (!verifyContentChannelRecordV1(input.record)
    || input.createdAt !== input.record.createdAt
    || input.expiresAt > input.record.expiresAt) throw new Error('Invalid content channel input');
  const content = {
    kind: 'disclosure' as const,
    level: 'specific' as const,
    text: canonicalize(input.record),
    createdAt: input.record.createdAt,
  };
  return createChannelMessageOperationV2(
    input.record.channelId,
    input.recipientRelationshipId,
    input.sequence,
    content,
    input.sharedKey,
    input.relationshipKeys,
    input.createdAt,
    input.expiresAt,
  );
}

export function decryptContentChannelOperationV2(
  operation: ChannelMessageOperationV2,
  sharedKey: Uint8Array,
): ContentChannelRecordV1 {
  if (!verifyChannelOperationV2(operation)) throw new Error('Invalid content channel operation');
  const content = decryptChannelContentV2(operation, sharedKey);
  if (content.level !== 'specific' || content.createdAt !== operation.createdAt) {
    throw new Error('Content channel metadata mismatch');
  }
  let value: unknown;
  try { value = JSON.parse(content.text); } catch { throw new Error('Invalid content channel plaintext'); }
  if (!verifyContentChannelRecordV1(value) || value.channelId !== operation.channelId
    || value.createdAt !== operation.createdAt) throw new Error('Content channel binding mismatch');
  return value;
}

export function verifyContentChannelRecordV1(value: unknown): value is ContentChannelRecordV1 {
  return verifyContentRequestV1(value) || verifyContentGrantV1(value) || verifyContentResponseV1(value);
}

export function serializeContentChannelOperationV2(operation: ChannelMessageOperationV2): string {
  if (!verifyChannelOperationV2(operation)) throw new Error('Invalid content channel operation');
  return canonicalize(operation);
}

export function parseContentChannelOperationV2(raw: string): ChannelMessageOperationV2 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32 * 1024) {
    throw new Error('Invalid content channel operation');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid content channel operation'); }
  if (!verifyChannelOperationV2(value) || value.kind !== 'channel-message') {
    throw new Error('Invalid content channel operation');
  }
  return value;
}

const REQUEST_KEYS = [
  'channelId', 'contentCommitment', 'createdAt', 'expiresAt', 'generationId', 'kind',
  'publicationId', 'requestId', 'requesterPublicationId', 'requesterPublicationKey',
  'requesterRelationshipId', 'version',
];
const GRANT_KEYS = [
  'channelId', 'contentCommitment', 'createdAt', 'expiresAt', 'generationId', 'grantId', 'kind',
  'ownerPublicationKey', 'publicationId', 'requestId', 'requesterPublicationId',
  'requesterRelationshipId', 'version',
];
const RESPONSE_KEYS = [
  'channelId', 'commitmentKey', 'contentCommitment', 'createdAt', 'expiresAt', 'generationId',
  'grant', 'grantId', 'kind', 'originalBytes', 'ownerPublicationKey', 'publicationId',
  'requestId', 'requesterPublicationId', 'requesterRelationshipId', 'responseId', 'version',
];

function isRequestBody(value: unknown): value is ContentRequestBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, REQUEST_KEYS)) return false;
  return value.version === 1 && value.kind === CONTENT_REQUEST_KIND
    && isOpaque(value.requestId, 'creq') && isOpaque(value.channelId, 'chn')
    && isOpaque(value.requesterPublicationId, 'pub')
    && isOpaque(value.requesterRelationshipId, 'rel')
    && isOpaque(value.publicationId, 'pub') && isOpaque(value.generationId, 'gen')
    && isBase64(value.contentCommitment, 32) && isBase64(value.requesterPublicationKey, 32)
    && value.requesterPublicationId === idFromKey('pub', value.requesterPublicationKey)
    && isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt;
}

function isGrantBody(value: unknown): value is ContentGrantBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, GRANT_KEYS)) return false;
  return value.version === 1 && value.kind === CONTENT_GRANT_KIND
    && isOpaque(value.grantId, 'cgrant') && isOpaque(value.requestId, 'creq')
    && isOpaque(value.channelId, 'chn') && isOpaque(value.requesterPublicationId, 'pub')
    && isOpaque(value.requesterRelationshipId, 'rel') && isOpaque(value.publicationId, 'pub')
    && isOpaque(value.generationId, 'gen') && isBase64(value.contentCommitment, 32)
    && isBase64(value.ownerPublicationKey, 32)
    && value.publicationId === idFromKey('pub', value.ownerPublicationKey)
    && isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt;
}

function isResponseBody(value: unknown): value is ContentResponseBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RESPONSE_KEYS)) return false;
  return value.version === 1 && value.kind === CONTENT_RESPONSE_KIND
    && isOpaque(value.responseId, 'cresp') && isOpaque(value.requestId, 'creq')
    && isOpaque(value.grantId, 'cgrant') && isOpaque(value.channelId, 'chn')
    && isOpaque(value.requesterPublicationId, 'pub')
    && isOpaque(value.requesterRelationshipId, 'rel')
    && isOpaque(value.publicationId, 'pub') && isOpaque(value.generationId, 'gen')
    && isBase64(value.contentCommitment, 32) && isBase64(value.originalBytes)
    && decodeBase64(value.originalBytes).length <= MAX_CONTENT_ORIGINAL_BYTES
    && isBase64(value.commitmentKey, 32) && isBase64(value.ownerPublicationKey, 32)
    && verifyContentGrantV1(value.grant)
    && value.grantId === value.grant.grantId
    && value.requestId === value.grant.requestId
    && value.channelId === value.grant.channelId
    && value.requesterPublicationId === value.grant.requesterPublicationId
    && value.requesterRelationshipId === value.grant.requesterRelationshipId
    && value.publicationId === value.grant.publicationId
    && value.generationId === value.grant.generationId
    && value.contentCommitment === value.grant.contentCommitment
    && value.ownerPublicationKey === value.grant.ownerPublicationKey
    && value.publicationId === idFromKey('pub', value.ownerPublicationKey)
    && isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt;
}

function signable(domain: string, body: object): Uint8Array {
  return decodeUTF8(`${domain}\n${canonicalize(body)}`);
}

function derivedId(prefix: string, input: string): string {
  return `${prefix}_${base64Url(sha512(decodeUTF8(input)).slice(0, 32))}`;
}

function idFromKey(prefix: string, encoded: string): string {
  return `${prefix}_${base64Url(decodeBase64(encoded))}`;
}

function base64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw new Error('Cannot canonicalize value');
}

function isBase64(value: unknown, length?: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const bytes = decodeBase64(value);
    return encodeBase64(bytes) === value && (length === undefined || bytes.length === length);
  } catch {
    return false;
  }
}

function isOpaque(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
