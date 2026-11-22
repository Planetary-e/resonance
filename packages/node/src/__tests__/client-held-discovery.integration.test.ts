import { mkdtempSync, rmSync } from 'node:fs';
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
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  offlineDiscoveryAdmissionBindingV1,
  parseOfflineDiscoveryDepositV1,
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { LeasedIndexStore, MailboxGenerationStore } from '@resonance/relay';
import { ContentGrantStore } from '../content-grant-store.js';
import { LeasedIndexLocalStore } from '../leased-index-store.js';
import { OfflineRequestStore } from '../offline-request-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const openStores: Array<{ close(): void }> = [];
const ADMISSION: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'fixed-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

function open<T extends { close(): void }>(store: T): T {
  openStores.push(store);
  return store;
}

function indexInput(index: LeasedIndexV1) {
  return {
    groupId: index.groupId,
    itemType: index.itemType,
    derivationId: index.derivationId,
    fingerprintEpoch: index.fingerprint.epoch,
    fingerprint: new Uint8Array(64).fill(1),
    createdAt: index.createdAt,
    expiresAt: index.expiresAt,
  };
}

function composedFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-client-held-composed-'));
  directories.push(directory);
  const originalBytes = new TextEncoder().encode('composed exact original');
  const keys = generateLeasedIndexKeyMaterialV1();
  const ownerEncryptionKey = randomBytes(32);
  const local = open(LeasedIndexLocalStore.create({
    path: join(directory, 'owner-lease.json'),
    encryptionKey: ownerEncryptionKey,
    keys,
    originalBytes,
    input: {
      groupId: 'public',
      itemType: 'need',
      derivationId: 'fixed-composed-derivation-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1),
      createdAt: NOW,
      expiresAt: NOW + 7 * DAY,
    },
  }));
  const initial = local.currentOperation();
  if (initial.kind !== 'leased-discovery-index') throw new Error('Expected initial index');
  const initialIndex = initial;
  const relayA = new LeasedIndexStore();
  const relayB = new LeasedIndexStore();
  const partnerKeys = generateLeasedIndexKeyMaterialV1();
  const partner = createLeasedIndexV1({
    groupId: 'public',
    itemType: 'offer',
    derivationId: 'fixed-composed-derivation-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(1),
    originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, partnerKeys);

  let currentIndex = initialIndex;
  let withdrawn = false;
  const historical = new Map([[createLeasedIndexGenerationIdV1(initialIndex), initialIndex]]);
  const allowedBindings = new Set<string>();
  const identities = [generateIdentity(), generateIdentity(), generateIdentity()];
  const mailboxOptions = (name: string, relayIdentity: (typeof identities)[number]) => ({
    directory: join(directory, name),
    relayIdentity,
    currentIndex: () => withdrawn ? undefined : currentIndex,
    authorizedIndex: () => currentIndex,
    indexForGeneration: (id: string) => historical.get(id),
    verifyAdmission: (capability: AdmissionCapabilityV2, binding: string) => (
      verifyAdmissionCapabilityV2(capability) && allowedBindings.has(binding)
    ),
  });
  const mailboxes = identities.map((identity, index) => new MailboxGenerationStore(
    mailboxOptions(`mailbox-${index}`, identity),
  ));
  let now = NOW;
  const senderKey = randomBytes(32);
  const recipientKey = randomBytes(32);
  const sender = open(OfflineRequestStore.open({
    path: join(directory, 'sender-requests.json'),
    encryptionKey: senderKey,
    now: () => now,
  }));
  const recipient = open(OfflineRequestStore.open({
    path: join(directory, 'recipient-requests.json'),
    encryptionKey: recipientKey,
    now: () => now,
  }));
  recipient.retainGeneration(initialIndex, keys);

  const ownerRelationship = generateRelationshipKeyMaterial();
  const requesterRelationship = generateRelationshipKeyMaterial();
  const ownerShared = deriveSharedSecret(
    ownerRelationship.channelKeyPair.secretKey,
    requesterRelationship.channelKeyPair.publicKey,
  );
  const requesterShared = deriveSharedSecret(
    requesterRelationship.channelKeyPair.secretKey,
    ownerRelationship.channelKeyPair.publicKey,
  );
  const channelId = createPairwiseChannelId(
    `match_${'M'.repeat(43)}`,
    ownerRelationship.relationshipId,
    requesterRelationship.relationshipId,
  );
  const ownerContent = open(ContentGrantStore.open({
    path: join(directory, 'owner-content.json'),
    encryptionKey: randomBytes(32),
    now: () => now,
  }));
  const requesterContent = open(ContentGrantStore.open({
    path: join(directory, 'requester-content.json'),
    encryptionKey: randomBytes(32),
    now: () => now,
  }));
  const requesterKeys = generateLeasedIndexKeyMaterialV1();
  ownerContent.registerChannel({
    channelId,
    localPublicationId: keys.publicationId,
    partnerPublicationId: requesterKeys.publicationId,
    localRelationshipKeys: ownerRelationship,
    publicationKeys: keys,
    partnerRelationshipId: requesterRelationship.relationshipId,
    partnerRelationshipKey: encodePublicKey(requesterRelationship.signingKeyPair.publicKey),
    sharedKey: ownerShared,
  });
  requesterContent.registerChannel({
    channelId,
    localPublicationId: requesterKeys.publicationId,
    partnerPublicationId: keys.publicationId,
    localRelationshipKeys: requesterRelationship,
    publicationKeys: requesterKeys,
    partnerRelationshipId: ownerRelationship.relationshipId,
    partnerRelationshipKey: encodePublicKey(ownerRelationship.signingKeyPair.publicKey),
    sharedKey: requesterShared,
  });
  const originalState = local.read().originals[0];
  ownerContent.retainOriginal(
    initialIndex,
    originalBytes,
    Uint8Array.from(Buffer.from(originalState.commitmentKey, 'base64url')),
  );
  return {
    directory,
    originalBytes,
    keys,
    ownerEncryptionKey,
    local,
    initialIndex,
    relayA,
    relayB,
    partner,
    mailboxes,
    identities,
    sender,
    recipient,
    recipientKey,
    ownerContent,
    requesterContent,
    channelId,
    requesterKeys,
    allowedBindings,
    historical,
    setCurrent(index: LeasedIndexV1) {
      currentIndex = index;
      historical.set(createLeasedIndexGenerationIdV1(index), index);
      recipient.retainGeneration(index, keys);
    },
    withdraw() { withdrawn = true; },
    setNow(value: number) { now = value; },
    now: () => now,
  };
}

function encodePublicKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function deposit(
  env: ReturnType<typeof composedFixture>,
  mailbox: MailboxGenerationStore,
  value: { depositBytes: string },
  now: number,
) {
  env.allowedBindings.add(offlineDiscoveryAdmissionBindingV1(parseOfflineDiscoveryDepositV1(value.depositBytes)));
  return mailbox.deposit(value.depositBytes, ADMISSION, now);
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('composed client-held discovery prototype', () => {
  it('composes durable publication, encrypted mailbox, receipts, and authorized content delivery', () => {
    const env = composedFixture();
    expect(env.relayA.apply(serializeIndex(env.partner), NOW).status).toBe('accepted');
    const initialBytes = env.local.pendingOperation()!;
    expect(env.relayA.apply(initialBytes, NOW).status).toBe('accepted');
    expect(env.relayA.apply(initialBytes, NOW).status).toBe('duplicate');
    expect(env.relayA.matching.getPendingForDID(env.keys.clientLeaseId)).toHaveLength(1);

    const repaired = env.relayB.repairFrom(env.relayA, env.keys.publicationId, NOW);
    expect(repaired.map(result => result.status)).toEqual(['accepted']);
    expect(env.relayB.getExactBytes(env.keys.publicationId)).toBe(initialBytes);
    expect(env.relayB.matching.getPendingForDID(env.keys.clientLeaseId)).toEqual([]);

    const firstRequest = env.sender.createDeposit({
      index: env.initialIndex,
      requestNonce: new Uint8Array(16).fill(21),
      payload: 'composed private request',
      replyCapability: 'reply-capability',
      createdAt: NOW,
      expiresAt: NOW + 2 * DAY,
      admission: ADMISSION,
      selectedRelayIds: env.identities.map(identity => identity.did),
    });
    for (const mailbox of env.mailboxes) expect(deposit(env, mailbox, firstRequest, NOW).status).toBe('stored');

    env.local.acknowledge(initialBytes);
    const writer = env.local.reconcile([env.relayA.exportReplicaState(env.keys.publicationId)]);
    expect(writer.status).toBe('ready');
    const refreshedBytes = env.local.refresh(writer.writerLeaseId!, NOW + DAY, NOW + 8 * DAY);
    const refreshed = env.local.currentOperation();
    if (refreshed.kind !== 'leased-discovery-index') throw new Error('Expected refreshed index');
    env.setCurrent(refreshed);
    env.ownerContent.retainOriginal(
      refreshed,
      env.originalBytes,
      Uint8Array.from(Buffer.from(env.local.read().originals[0].commitmentKey, 'base64url')),
    );
    const refreshResult = env.relayA.apply(refreshedBytes, NOW + DAY);
    expect(refreshResult.status).toBe('accepted');
    expect(refreshResult.notifications).toEqual([]);
    expect(env.relayA.matching.getPendingForDID(env.keys.clientLeaseId)).toHaveLength(1);
    env.local.acknowledge(refreshedBytes);
    const refreshedWriter = env.local.reconcile([env.relayA.exportReplicaState(env.keys.publicationId)]);
    expect(refreshedWriter.status).toBe('ready');

    const refreshedRequest = env.sender.redeposit({
      requestId: firstRequest.requestId,
      index: refreshed,
      admission: ADMISSION,
    });
    expect(refreshedRequest.requestId).toBe(firstRequest.requestId);
    expect(env.sender.retry(firstRequest.requestId, firstRequest.generationId).depositBytes)
      .toBe(firstRequest.depositBytes);
    for (const [index, mailbox] of env.mailboxes.entries()) {
      const result = deposit(env, mailbox, refreshedRequest, NOW + DAY);
      expect(result.status).toBe('stored');
      expect(env.sender.recordReceipt(firstRequest.requestId, result.receipt!)).toBe(
        index < 2 ? 'stored' : 'queued',
      );
    }
    const fullQuota = env.mailboxes[0].quota(env.keys.clientLeaseId);
    expect(fullQuota.logicalRequests).toBe(1);
    expect(deposit(env, env.mailboxes[0], refreshedRequest, NOW + DAY).status).toBe('duplicate');
    expect(env.mailboxes[0].quota(env.keys.clientLeaseId)).toEqual(fullQuota);

    const firstReceived = env.recipient.receive(firstRequest.depositBytes, NOW + DAY + 1_000);
    expect(firstReceived.status).toBe('committed');
    expect(env.recipient.pendingAcks()).toHaveLength(1);
    env.recipient.close();
    const reopenedRecipient = open(OfflineRequestStore.open({
      path: join(env.directory, 'recipient-requests.json'),
      encryptionKey: env.recipientKey,
      now: env.now,
    }));
    const received = reopenedRecipient.receiveMany([
      refreshedRequest.depositBytes,
      firstRequest.depositBytes,
    ], NOW + DAY + 1_000);
    expect(received).toHaveLength(2);
    expect(reopenedRecipient.listInbox()).toHaveLength(1);
    expect(reopenedRecipient.pendingAcks()).toHaveLength(2);
    const oldAck = received.find(item => item.request.generationId === firstRequest.generationId)!;
    const newAck = received.find(item => item.request.generationId === refreshedRequest.generationId)!;
    expect(env.mailboxes[0].acknowledge(oldAck.ackBytes, NOW + DAY + 2_000).status).toBe('acknowledged');
    expect(env.mailboxes[0].fetch(env.initialIndex.mailbox.id, NOW + DAY + 2_000))
      .toEqual([refreshedRequest.depositBytes]);
    expect(env.mailboxes[0].acknowledge(newAck.ackBytes, NOW + DAY + 2_000).status).toBe('acknowledged');
    expect(env.mailboxes[0].fetch(env.initialIndex.mailbox.id, NOW + DAY + 2_000)).toEqual([]);
    env.sender.recordGenerationAck(firstRequest.requestId, oldAck.ackBytes);
    env.sender.recordGenerationAck(firstRequest.requestId, newAck.ackBytes);

    env.setNow(NOW + DAY + 2_000);
    const contentRequest = env.requesterContent.createRequest({
      channelId: env.channelId,
      index: refreshed,
      createdAt: NOW + DAY + 2_000,
      expiresAt: NOW + 2 * DAY,
    });
    const encryptedRequest = env.requesterContent.prepareRequest(contentRequest);
    expect(env.ownerContent.receiveRequest(encryptedRequest.operationBytes, NOW + DAY + 3_000).status)
      .toBe('received');
    env.setNow(NOW + DAY + 3_000);
    const granted = env.ownerContent.grantRequest({
      requestId: contentRequest,
      createdAt: NOW + DAY + 3_000,
      expiresAt: NOW + 2 * DAY - 1_000,
    });
    expect(granted.status).toBe('granted');
    env.setNow(NOW + DAY + 4_000);
    const encryptedResponse = env.ownerContent.prepareResponse(granted.grantId!);
    expect(encryptedResponse.operationBytes).not.toContain('composed exact original');
    const content = env.requesterContent.receiveResponse(encryptedResponse.operationBytes, NOW + DAY + 4_000);
    expect(new TextDecoder().decode(content.originalBytes)).toBe('composed exact original');
    expect(env.requesterContent.receiveResponse(encryptedResponse.operationBytes, NOW + DAY + 4_000).status)
      .toBe('duplicate');

    env.setNow(NOW + DAY + 5_000);
    const laterRequest = env.requesterContent.createRequest({
      channelId: env.channelId,
      index: refreshed,
      createdAt: NOW + DAY + 5_000,
      expiresAt: NOW + 2 * DAY,
    });
    const laterOperation = env.requesterContent.prepareRequest(laterRequest);
    env.ownerContent.receiveRequest(laterOperation.operationBytes, NOW + DAY + 5_000);
    const laterGrant = env.ownerContent.grantRequest({
      requestId: laterRequest,
      createdAt: NOW + DAY + 5_000,
      expiresAt: NOW + 2 * DAY - 1_000,
    });
    env.ownerContent.prepareResponse(laterGrant.grantId!);
    env.ownerContent.withdrawPublication(env.keys.publicationId);
    expect(() => env.ownerContent.prepareResponse(laterGrant.grantId!)).toThrow('not active');
    expect(env.requesterContent.receivedContent(laterRequest)).toBeUndefined();
    expect(new TextDecoder().decode(env.requesterContent.receivedContent(contentRequest)))
      .toBe('composed exact original');

    const withdrawal = env.local.withdraw(refreshedWriter.writerLeaseId!, NOW + 2 * DAY);
    expect(env.relayA.apply(withdrawal, NOW + 2 * DAY).status).toBe('accepted');
    env.withdraw();
    expect(env.mailboxes[0].withdraw(parseWithdrawal(withdrawal)).status).toBe('acknowledged');
    expect(deposit(env, env.mailboxes[0], refreshedRequest, NOW + 2 * DAY).status).toBe('withdrawn');
  });

  it('enforces the composed 16-request quota and refuses the 17th without disturbing replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-client-held-quota-'));
    directories.push(directory);
    const keys = generateLeasedIndexKeyMaterialV1();
    const original = new Uint8Array(16);
    const index = createLeasedIndexV1({
      groupId: 'public',
      itemType: 'need',
      derivationId: 'fixed-composed-derivation-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1),
      originalCommitment: createOriginalCommitmentV1(original, generateOriginalCommitmentKeyV1()),
      createdAt: NOW,
      expiresAt: NOW + 7 * DAY,
    }, keys);
    const identity = generateIdentity();
    const mailbox = new MailboxGenerationStore({
      directory: join(directory, 'relay'),
      relayIdentity: identity,
      currentIndex: () => index,
      indexForGeneration: () => index,
      verifyAdmission: () => true,
    });
    const sender = open(OfflineRequestStore.open({
      path: join(directory, 'sender.json'),
      encryptionKey: randomBytes(32),
      now: () => NOW,
    }));
    const values = Array.from({ length: 17 }, (_, sequence) => sender.createDeposit({
      index,
      requestNonce: new Uint8Array(16).fill(sequence),
      payload: `fixed composed request ${sequence}`,
      replyCapability: 'reply-capability',
      createdAt: NOW,
      expiresAt: NOW + DAY,
      admission: ADMISSION,
      selectedRelayIds: [identity.did],
    }));
    for (const value of values.slice(0, 16)) {
      expect(mailbox.deposit(value.depositBytes, ADMISSION, NOW).status).toBe('stored');
    }
    const full = mailbox.quota(keys.clientLeaseId);
    expect(full.logicalRequests).toBe(16);
    expect(full.reservedBytes).toBe(3_624_960);
    expect(mailbox.deposit(values[16].depositBytes, ADMISSION, NOW).status).toBe('request_limit');
    expect(mailbox.quota(keys.clientLeaseId)).toEqual(full);
    expect(mailbox.deposit(values[0].depositBytes, ADMISSION, NOW).status).toBe('duplicate');
    expect(mailbox.quota(keys.clientLeaseId)).toEqual(full);
  });
});

function serializeIndex(index: LeasedIndexV1): string {
  const { serializeLeasedIndexOperationV1 } = indexSerializer;
  return serializeLeasedIndexOperationV1(index);
}
import { serializeLeasedIndexOperationV1 } from '@resonance/core';
const indexSerializer = { serializeLeasedIndexOperationV1 };

function parseWithdrawal(raw: string) {
  const { parseLeasedIndexOperationV1 } = operationParser;
  const operation = parseLeasedIndexOperationV1(raw);
  if (operation.kind !== 'leased-discovery-withdrawal') throw new Error('Expected withdrawal');
  return operation;
}
import { parseLeasedIndexOperationV1 } from '@resonance/core';
const operationParser = { parseLeasedIndexOperationV1 };
