import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  createPairwiseChannelId,
  deriveSharedSecret,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  type LeasedIndexV1,
} from '@resonance/core';
import { ContentGrantStore, type ContentChannelContextV1 } from '../content-grant-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const stores: ContentGrantStore[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-content-grant-'));
  directories.push(directory);
  const owner = generateLeasedIndexKeyMaterialV1();
  const requester = generateLeasedIndexKeyMaterialV1();
  const ownerRelationship = generateRelationshipKeyMaterial();
  const requesterRelationship = generateRelationshipKeyMaterial();
  const ownerSharedKey = deriveSharedSecret(
    ownerRelationship.channelKeyPair.secretKey,
    requesterRelationship.channelKeyPair.publicKey,
  );
  const requesterSharedKey = deriveSharedSecret(
    requesterRelationship.channelKeyPair.secretKey,
    ownerRelationship.channelKeyPair.publicKey,
  );
  const channelId = createPairwiseChannelId(
    `match_${'M'.repeat(43)}`,
    ownerRelationship.relationshipId,
    requesterRelationship.relationshipId,
  );
  let now = NOW + 4;
  const ownerKey = randomBytes(32);
  const requesterKey = randomBytes(32);
  const ownerStore = open(ContentGrantStore.open({
    path: join(directory, 'owner.json'),
    encryptionKey: ownerKey,
    now: () => now,
  }));
  const requesterStore = open(ContentGrantStore.open({
    path: join(directory, 'requester.json'),
    encryptionKey: requesterKey,
    now: () => now,
  }));
  const ownerContext: ContentChannelContextV1 = {
    channelId,
    localPublicationId: owner.publicationId,
    partnerPublicationId: requester.publicationId,
    localRelationshipKeys: ownerRelationship,
    publicationKeys: owner,
    partnerRelationshipId: requesterRelationship.relationshipId,
    partnerRelationshipKey: encodeKey(requesterRelationship),
    sharedKey: ownerSharedKey,
  };
  const requesterContext: ContentChannelContextV1 = {
    channelId,
    localPublicationId: requester.publicationId,
    partnerPublicationId: owner.publicationId,
    localRelationshipKeys: requesterRelationship,
    publicationKeys: requester,
    partnerRelationshipId: ownerRelationship.relationshipId,
    partnerRelationshipKey: encodeKey(ownerRelationship),
    sharedKey: requesterSharedKey,
  };
  ownerStore.registerChannel(ownerContext);
  requesterStore.registerChannel(requesterContext);

  const originalBytes = new TextEncoder().encode('exact original revision zero');
  const revisedBytes = new TextEncoder().encode('exact original revision one');
  const key0 = generateOriginalCommitmentKeyV1();
  const key1 = generateOriginalCommitmentKeyV1();
  const makeIndex = (leaseSequence: number, semanticRevision: number, bytes: Uint8Array, key: Uint8Array) =>
    createLeasedIndexV1({
      leaseSequence,
      semanticRevision,
      groupId: 'public',
      itemType: 'offer',
      derivationId: `fixed-v${semanticRevision + 1}`,
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(semanticRevision + 1),
      originalCommitment: createOriginalCommitmentV1(bytes, key),
      createdAt: NOW + leaseSequence * 1_000,
      expiresAt: NOW + 7 * DAY + leaseSequence * 1_000,
    }, owner);
  const index0 = makeIndex(0, 0, originalBytes, key0);
  const index1 = makeIndex(1, 1, revisedBytes, key1);
  ownerStore.retainOriginal(index0, originalBytes, key0);
  ownerStore.retainOriginal(index1, revisedBytes, key1);
  return {
    directory,
    owner,
    requester,
    ownerRelationship,
    requesterRelationship,
    ownerStore,
    requesterStore,
    ownerContext,
    requesterContext,
    ownerKey,
    requesterKey,
    originalBytes,
    revisedBytes,
    index0,
    index1,
    setNow(value: number) { now = value; },
    now: () => now,
  };
}

function encodeKey(keys: ReturnType<typeof generateRelationshipKeyMaterial>): string {
  return Buffer.from(keys.signingKeyPair.publicKey).toString('base64');
}

function open(store: ContentGrantStore): ContentGrantStore {
  stores.push(store);
  return store;
}

function request(env: ReturnType<typeof fixture>, index: LeasedIndexV1) {
  return env.requesterStore.createRequest({
    channelId: createPairwiseChannelId(
      `match_${'M'.repeat(43)}`,
      env.ownerRelationship.relationshipId,
      env.requesterRelationship.relationshipId,
    ),
    index,
    createdAt: NOW + 1,
    expiresAt: NOW + DAY,
  });
}

function grantCurrent(env: ReturnType<typeof fixture>, requestId: string, allowSuperseded = false) {
  return env.ownerStore.grantRequest({
    requestId,
    createdAt: NOW + 2,
    expiresAt: NOW + 3_600_000,
    allowSuperseded,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('authorized online original delivery', () => {
  it('delivers exact content only after explicit grant and deduplicates replay', () => {
    const env = fixture();
    const requestId = request(env, env.index1);
    const outbound = env.requesterStore.prepareRequest(requestId);
    expect(outbound.operationBytes).not.toContain('exact original revision one');
    expect(env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2).status).toBe('received');
    expect(env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2).status).toBe('duplicate');
    env.requesterStore.markRequestSent(requestId);
    expect(env.requesterStore.prepareRequest(requestId).operationBytes).toBe(outbound.operationBytes);
    const granted = grantCurrent(env, requestId);
    expect(granted.status).toBe('granted');

    const response = env.ownerStore.prepareResponse(granted.grantId!);
    expect(response.operationBytes).not.toContain('exact original revision one');
    const received = env.requesterStore.receiveResponse(response.operationBytes, NOW + 4);
    expect(received.status).toBe('received');
    expect(new TextDecoder().decode(received.originalBytes)).toBe('exact original revision one');
    const duplicate = env.requesterStore.receiveResponse(response.operationBytes, NOW + 4);
    expect(duplicate.status).toBe('duplicate');
    expect(new TextDecoder().decode(duplicate.originalBytes)).toBe('exact original revision one');
    env.ownerStore.markResponseSent(granted.grantId!);
    expect(env.ownerStore.grantState(granted.grantId!)).toBe('used');
    expect(() => env.ownerStore.prepareResponse(granted.grantId!)).toThrow('not active');
    expect(env.requesterStore.requestState(requestId)).toBe('completed');
  });

  it('does not treat relationship consent as original-content authorization', () => {
    const env = fixture();
    const requestId = request(env, env.index1);
    const outbound = env.requesterStore.prepareRequest(requestId);
    env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2);
    expect(() => env.ownerStore.prepareResponse(`cgrant_${'A'.repeat(43)}`)).toThrow('not found');
    env.ownerStore.setConsent(env.ownerContext.channelId, false);
    expect(() => grantCurrent(env, requestId)).toThrow('consent');
  });

  it('returns superseded by default but can explicitly grant a retained old revision', () => {
    const env = fixture();
    const requestId = request(env, env.index0);
    const outbound = env.requesterStore.prepareRequest(requestId);
    env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2);
    expect(grantCurrent(env, requestId).status).toBe('superseded');
    expect(env.ownerStore.requestState(requestId)).toBe('superseded');

    const granted = grantCurrent(env, requestId, true);
    expect(granted.status).toBe('granted');
    const response = env.ownerStore.prepareResponse(granted.grantId!);
    const received = env.requesterStore.receiveResponse(response.operationBytes, NOW + 4);
    expect(new TextDecoder().decode(received.originalBytes)).toBe('exact original revision zero');
  });

  it('denies withdrawal before transmission without revoking already received content', () => {
    const env = fixture();
    const requestId = request(env, env.index1);
    const outbound = env.requesterStore.prepareRequest(requestId);
    env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2);
    const granted = grantCurrent(env, requestId);
    env.ownerStore.prepareResponse(granted.grantId!);
    env.ownerStore.withdrawPublication(env.owner.publicationId);
    expect(env.ownerStore.grantState(granted.grantId!)).toBe('denied');
    expect(() => env.ownerStore.prepareResponse(granted.grantId!)).toThrow('not active');

    const delivered = fixture();
    const deliveredRequest = request(delivered, delivered.index1);
    const deliveredOutbound = delivered.requesterStore.prepareRequest(deliveredRequest);
    delivered.ownerStore.receiveRequest(deliveredOutbound.operationBytes, NOW + 2);
    const deliveredGrant = grantCurrent(delivered, deliveredRequest);
    const deliveredResponse = delivered.ownerStore.prepareResponse(deliveredGrant.grantId!);
    delivered.requesterStore.receiveResponse(deliveredResponse.operationBytes, NOW + 4);
    delivered.ownerStore.withdrawPublication(delivered.owner.publicationId);
    expect(new TextDecoder().decode(delivered.requesterStore.receivedContent(deliveredRequest)))
      .toBe('exact original revision one');
  });
});

describe('durable pending content operations', () => {
  it('reopens a response as uncertain and replays the exact signed ciphertext', () => {
    const env = fixture();
    const requestId = request(env, env.index1);
    const outbound = env.requesterStore.prepareRequest(requestId);
    env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2);
    const granted = grantCurrent(env, requestId);
    const prepared = env.ownerStore.prepareResponse(granted.grantId!);
    env.ownerStore.close();

    const reopened = open(ContentGrantStore.open({
      path: join(env.directory, 'owner.json'),
      encryptionKey: env.ownerKey,
      now: env.now,
    }));
    expect(reopened.grantState(granted.grantId!)).toBe('outcome-unknown');
    const replay = reopened.prepareResponse(granted.grantId!);
    expect(replay.operationBytes).toBe(prepared.operationBytes);
    const received = env.requesterStore.receiveResponse(replay.operationBytes, NOW + 4);
    expect(received.status).toBe('received');
    reopened.markResponseSent(granted.grantId!);
    expect(reopened.grantState(granted.grantId!)).toBe('used');
  });

  it('rejects a tampered channel sequence without committing or exposing content', () => {
    const env = fixture();
    const requestId = request(env, env.index1);
    const outbound = env.requesterStore.prepareRequest(requestId);
    env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2);
    const granted = grantCurrent(env, requestId);
    const prepared = env.ownerStore.prepareResponse(granted.grantId!);
    const tampered = JSON.stringify({
      ...JSON.parse(prepared.operationBytes),
      sequence: 99,
    });

    expect(() => env.requesterStore.receiveResponse(tampered, NOW + 4)).toThrow();
    expect(env.requesterStore.receivedContent(requestId)).toBeUndefined();
  });

  it('keeps private keys, originals, and plaintext responses out of the local snapshot file', () => {
    const env = fixture();
    const requestId = request(env, env.index1);
    const outbound = env.requesterStore.prepareRequest(requestId);
    env.ownerStore.receiveRequest(outbound.operationBytes, NOW + 2);
    const granted = grantCurrent(env, requestId);
    env.ownerStore.prepareResponse(granted.grantId!);
    const disk = readFileSync(join(env.directory, 'owner.json'), 'utf8');
    expect(disk).not.toContain('exact original revision one');
    expect(disk).not.toContain(Buffer.from(env.owner.signingKeyPair.secretKey).toString('base64'));
  });
});
