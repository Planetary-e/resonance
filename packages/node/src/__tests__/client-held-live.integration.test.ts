import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createClientHeldRepairRequestV1,
  createContentPollRequestV1,
  createLeasedIndexGenerationIdV1,
  createLeasedIndexLookupRequestV1,
  createLeasedIndexSearchRequestV1,
  createLeasedIndexV1,
  createLeasedIndexWithdrawalV1,
  createOfflineDiscoveryDepositV1,
  createOfflineDiscoveryRequestV1,
  createOfflineFetchRequestV1,
  createOfflineSyncRequestV1,
  createOriginalCommitmentV1,
  createPairwiseChannelId,
  deriveSharedSecret,
  encryptOfflineDiscoveryRequestV1,
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  generateSigningKeyPair,
  serializeOfflineDiscoveryDepositV1,
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from '@resonance/core';
import {
  createRelayServer,
  discoverRelayContactV1,
  type RelayServer,
} from '@resonance/relay';
import { ContentGrantStore } from '../content-grant-store.js';
import { LeasedIndexLocalStore } from '../leased-index-store.js';
import { OfflineRequestStore } from '../offline-request-store.js';
import {
  createRelayClient,
  type AdmissionCapabilityProviderV2,
  type AdmissionCapabilityRequestContextV2,
} from '../relay-client.js';
import { createRelayContactHintV1 } from '@resonance/core';

const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const servers: RelayServer[] = [];
const clients: Array<{ disconnect(): void }> = [];
const stores: Array<{ close(): void }> = [];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

const admissionProvider: AdmissionCapabilityProviderV2 = Object.assign(
  (context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2 => ({
    version: 2,
    kind: 'admission-capability',
    scheme: 'live-test-v1',
    issuer: 'community:test',
    token: digest(`token:${context.requestBinding}`),
    requestProof: digest(context.requestBinding),
  }),
  { assertMaintenanceDestination: () => {} },
);

function admissionVerifier() {
  const spent = new Map<string, string>();
  return {
    verifyAndSpend(capability: AdmissionCapabilityV2, context: { requestBinding: string }) {
      if (!verifyAdmissionCapabilityV2(capability)
        || capability.requestProof !== digest(context.requestBinding)
        || capability.token !== digest(`token:${context.requestBinding}`)) return { status: 'rejected' as const };
      const prior = spent.get(capability.token);
      if (prior) return prior === context.requestBinding ? { status: 'replay' as const } : { status: 'rejected' as const };
      spent.set(capability.token, context.requestBinding);
      return { status: 'accepted' as const };
    },
  };
}

async function relay(
  directory: string,
  options: { approvedRelays?: string[]; ipv6?: boolean } = {},
): Promise<{ server: RelayServer; endpoint: string }> {
  const host = options.ipv6 ? '::1' : '127.0.0.1';
  const server = createRelayServer({
    port: 0,
    host,
    persistDir: directory,
    admissionVerifier: admissionVerifier(),
    inboundReplicaTargetIds: options.approvedRelays,
    privateEntryMix: false,
    privateReplyMix: false,
    relayDiscovery: {
      endpoints: [`ws://${options.ipv6 ? '[::1]' : '127.0.0.1'}:0/`],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 32 * 1024 * 1024, availableBytes: 16 * 1024 * 1024 },
    },
  });
  servers.push(server);
  await server.start();
  return {
    server,
    endpoint: `ws://${options.ipv6 ? '[::1]' : '127.0.0.1'}:${server.getListeningPort()!}/`,
  };
}

function client(endpoint: string) {
  const value = createRelayClient({ relayUrl: endpoint, admissionCapabilityProvider: admissionProvider });
  clients.push(value);
  return value;
}

function open<T extends { close(): void }>(store: T): T {
  stores.push(store);
  return store;
}

function contentChannels(
  owner: LeasedIndexKeyMaterialV1,
  requester: LeasedIndexKeyMaterialV1,
  ownerStore: ContentGrantStore,
  requesterStore: ContentGrantStore,
) {
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
  ownerStore.registerChannel({
    channelId,
    localPublicationId: owner.publicationId,
    partnerPublicationId: requester.publicationId,
    localRelationshipKeys: ownerRelationship,
    publicationKeys: owner,
    partnerRelationshipId: requesterRelationship.relationshipId,
    partnerRelationshipKey: Buffer.from(requesterRelationship.signingKeyPair.publicKey).toString('base64'),
    sharedKey: ownerShared,
  });
  requesterStore.registerChannel({
    channelId,
    localPublicationId: requester.publicationId,
    partnerPublicationId: owner.publicationId,
    localRelationshipKeys: requesterRelationship,
    publicationKeys: requester,
    partnerRelationshipId: ownerRelationship.relationshipId,
    partnerRelationshipKey: Buffer.from(ownerRelationship.signingKeyPair.publicKey).toString('base64'),
    sharedKey: requesterShared,
  });
  return { channelId, ownerRelationship, requesterRelationship };
}

function contentStores(directory: string) {
  const owner = open(ContentGrantStore.open({
    path: join(directory, 'content-owner.json'),
    encryptionKey: randomBytes(32),
  }));
  const requester = open(ContentGrantStore.open({
    path: join(directory, 'content-requester.json'),
    encryptionKey: randomBytes(32),
  }));
  return { owner, requester };
}

async function sendOnline(
  network: ReturnType<typeof client>,
  operationBytes: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await network.sendContentOperation(operationBytes);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('counterparty_offline')) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('Counterparty did not become online within the bounded poll-start window');
}

async function deliverContent(
  network: ReturnType<typeof client>,
  owner: ContentGrantStore,
  requester: ContentGrantStore,
  channel: ReturnType<typeof contentChannels>,
  index: LeasedIndexV1,
  createdAt: number,
): Promise<Uint8Array | undefined> {
  const requestId = requester.createRequest({
    channelId: channel.channelId,
    index,
    createdAt,
    expiresAt: createdAt + 60_000,
  });
  const requestOperation = requester.prepareRequest(requestId).operationBytes;
  const ownerPoll = network.pollContent(createContentPollRequestV1({
    channelId: channel.channelId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  }, channel.ownerRelationship));
  await new Promise(resolve => setTimeout(resolve, 30));
  await sendOnline(network, requestOperation);
  owner.receiveRequest(await ownerPoll, Date.now());
  const grant = owner.grantRequest({
    requestId,
    createdAt,
    expiresAt: createdAt + 30_000,
  });
  expect(grant.status).toBe('granted');
  const responseOperation = owner.prepareResponse(grant.grantId!).operationBytes;
  const requesterPoll = network.pollContent(createContentPollRequestV1({
    channelId: channel.channelId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  }, channel.requesterRelationship));
  await new Promise(resolve => setTimeout(resolve, 30));
  await sendOnline(network, responseOperation);
  const response = requester.receiveResponse(await requesterPoll, Date.now());
  return response.originalBytes;
}

function changedOfflineDeposit(sender: OfflineRequestStore, index: LeasedIndexV1): string {
  const entry = sender.listOutbox()[0];
  const original = JSON.parse(entry.originalRequestBytes);
  const secretKey = Uint8Array.from(Buffer.from(entry.senderSecretKey, 'base64url'));
  const senderKeys = { publicKey: secretKey.slice(32), secretKey };
  const request = createOfflineDiscoveryRequestV1({
    requestNonce: Uint8Array.from(Buffer.from(original.requestNonce, 'base64')),
    createdAt: original.createdAt,
    expiresAt: original.expiresAt,
    payload: original.payload,
    replyCapability: original.replyCapability,
    ...(original.previousGenerationId ? {
      previousGenerationId: original.previousGenerationId,
      previousEnvelopeId: original.previousEnvelopeId,
    } : {}),
  }, index, senderKeys);
  return serializeOfflineDiscoveryDepositV1(createOfflineDiscoveryDepositV1(
    encryptOfflineDiscoveryRequestV1(request), request, senderKeys,
  ));
}

function fixedLiveIndex(
  keys: LeasedIndexKeyMaterialV1,
  createdAt: number,
  expiresAt: number,
  fill = 1,
): LeasedIndexV1 {
  return createLeasedIndexV1({
    groupId: 'public', itemType: 'need', derivationId: 'fixed-live-control-v1', fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(fill),
    originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
    createdAt, expiresAt,
  }, keys);
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const value of clients.splice(0)) value.disconnect();
  for (const server of servers.splice(0)) await server.stop({ graceful: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('live client-held discovery integration', () => {
  it('composes real publish/search/repair/restart, queued mailbox, ACK, and online content operations', async () => {
    const base = Date.now();
    const directory = mkdtempSync(join(tmpdir(), 'resonance-client-held-live-'));
    directories.push(directory);
    const repairIdentity = generateIdentity();
    const relayA = await relay(join(directory, 'relay-a'), { approvedRelays: [repairIdentity.did] });
    const relayB = await relay(join(directory, 'relay-b'), { approvedRelays: [repairIdentity.did] });
    const relayC = await relay(join(directory, 'relay-c'));
    const relayD = await relay(join(directory, 'relay-d'), { approvedRelays: [repairIdentity.did] });
    const clientA = client(relayA.endpoint);
    const clientB = client(relayB.endpoint);
    const clientC = client(relayC.endpoint);
    const clientD = client(relayD.endpoint);
    const keys = generateLeasedIndexKeyMaterialV1();
    const originalBytes = new TextEncoder().encode('live exact original');
    const local = open(LeasedIndexLocalStore.create({
      path: join(directory, 'lease.json'),
      encryptionKey: randomBytes(32),
      keys,
      originalBytes,
      input: {
        groupId: 'public', itemType: 'need', derivationId: 'fixed-live-v1', fingerprintEpoch: 'epoch-1',
        fingerprint: new Uint8Array(64).fill(1), createdAt: base - DAY, expiresAt: base + 6 * DAY,
      },
    }));
    const initial = local.currentOperation();
    if (initial.kind !== 'leased-discovery-index') throw new Error('Expected live index');
    const initialBytes = local.pendingOperation()!;

    expect((await clientA.submitLeasedIndexOperation(initialBytes)).status).toBe('ok');
    expect((await clientA.submitLeasedIndexOperation(initialBytes)).status).toBe('ok');
    const search = createLeasedIndexSearchRequestV1({
      groupId: 'public', itemType: 'offer', fingerprintEpoch: 'epoch-1', fingerprint: new Uint8Array(64).fill(1),
      limit: 10, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair());
    expect(await clientA.searchLeasedIndexes(search)).toEqual([initialBytes]);

    const lookup = createLeasedIndexLookupRequestV1({
      publicationId: keys.publicationId,
      generationId: createLeasedIndexGenerationIdV1(initial),
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair());
    expect(await clientB.lookupLeasedIndex(lookup)).toBeNull();
    const repair = createClientHeldRepairRequestV1({
      targetRelayId: relayB.server.getRelayDescriptor()?.relayId ?? '',
      operationBytes: initialBytes,
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, repairIdentity);
    expect((await clientB.repairClientHeld(repair)).status).toBe('ok');
    expect(await clientB.lookupLeasedIndex(createLeasedIndexLookupRequestV1({
      publicationId: keys.publicationId,
      generationId: createLeasedIndexGenerationIdV1(initial),
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair()))).toBe(initialBytes);

    await relayB.server.stop({ graceful: false });
    servers.splice(servers.indexOf(relayB.server), 1);
    const restartedB = await relay(join(directory, 'relay-b'), { approvedRelays: [repairIdentity.did] });
    const restartedClientB = client(restartedB.endpoint);
    expect(await restartedClientB.lookupLeasedIndex(createLeasedIndexLookupRequestV1({
      publicationId: keys.publicationId,
      generationId: createLeasedIndexGenerationIdV1(initial),
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair()))).toBe(initialBytes);
    expect((await clientC.submitLeasedIndexOperation(initialBytes)).status).toBe('ok');
    expect((await clientD.submitLeasedIndexOperation(initialBytes)).status).toBe('ok');

    const sender = open(OfflineRequestStore.open({
      path: join(directory, 'sender.json'), encryptionKey: randomBytes(32),
    }));
    const recipientKey = randomBytes(32);
    const recipient = open(OfflineRequestStore.open({
      path: join(directory, 'recipient.json'), encryptionKey: recipientKey,
    }));
    recipient.retainGeneration(initial, keys);
    const first = sender.createDeposit({
      index: initial, requestNonce: new Uint8Array(16).fill(1), payload: 'live private request',
      replyCapability: 'reply-capability', createdAt: base - DAY, expiresAt: base + DAY,
      admission: ADMISSION_FOR_LOCAL,
      selectedRelayIds: [relayA.server, restartedB.server, relayC.server].map(server => (
        server.getRelayDescriptor()!.relayId
      )),
    });
    const receipts = [clientA, restartedClientB, clientC];
    for (const network of receipts) {
      const result = await network.depositOfflineDiscovery(first.depositBytes);
      expect(result.status).toBe('stored');
      expect(result.receipt).toBeDefined();
      sender.recordReceipt(first.requestId, result.receipt!);
    }
    expect(sender.listOutbox()[0].state).toBe('queued');

    const sourcePage = await clientA.syncOfflineDiscovery(createOfflineSyncRequestV1({
      targetRelayId: relayA.server.getRelayDescriptor()!.relayId,
      clientLeaseId: keys.clientLeaseId,
      cursor: 0,
      events: [],
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, repairIdentity));
    expect(sourcePage.events.length).toBeGreaterThan(0);
    const synced = await clientD.syncOfflineDiscovery(createOfflineSyncRequestV1({
      targetRelayId: relayD.server.getRelayDescriptor()!.relayId,
      clientLeaseId: keys.clientLeaseId,
      cursor: 0,
      events: sourcePage.events,
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, repairIdentity));
    expect(synced.events.length).toBeGreaterThan(0);
    expect(await clientD.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index: initial, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).toEqual([first.depositBytes]);

    local.acknowledge(initialBytes);
    const currentEvidence = await clientA.lookupLeasedIndex(createLeasedIndexLookupRequestV1({
      publicationId: keys.publicationId, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair()));
    const writer = local.reconcile([[currentEvidence!]]);
    expect(writer.status).toBe('ready');
    const refreshedBytes = local.refresh(writer.writerLeaseId!, base, base + 7 * DAY);
    expect((await clientA.submitLeasedIndexOperation(refreshedBytes)).status).toBe('ok');
    expect((await restartedClientB.submitLeasedIndexOperation(refreshedBytes)).status).toBe('ok');
    expect((await clientC.submitLeasedIndexOperation(refreshedBytes)).status).toBe('ok');
    const refreshed = local.currentOperation();
    if (refreshed.kind !== 'leased-discovery-index') throw new Error('Expected refreshed index');
    local.acknowledge(refreshedBytes);
    const refreshedEvidence = await clientA.lookupLeasedIndex(createLeasedIndexLookupRequestV1({
      publicationId: keys.publicationId, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair()));
    expect(refreshedEvidence).not.toBeNull();
    const refreshedWriter = local.reconcile([[refreshedEvidence!]]);
    expect(refreshedWriter.status).toBe('ready');
    recipient.retainGeneration(refreshed, keys);
    const refreshedRequest = sender.redeposit({
      requestId: first.requestId, index: refreshed, admission: ADMISSION_FOR_LOCAL,
    });
    for (const network of receipts) {
      const result = await network.depositOfflineDiscovery(refreshedRequest.depositBytes);
      expect(result.status).toBe('stored');
      sender.recordReceipt(first.requestId, result.receipt!);
    }
    expect(sender.listOutbox()[0].state).toBe('queued');

    recipient.close();
    const reopenedRecipient = open(OfflineRequestStore.open({
      path: join(directory, 'recipient.json'), encryptionKey: recipientKey,
    }));
    const fetch = createOfflineFetchRequestV1({
      index: refreshed, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys);
    const deposits = await clientA.fetchOfflineDiscovery(fetch);
    expect(deposits.sort()).toEqual([first.depositBytes, refreshedRequest.depositBytes].sort());
    const received = reopenedRecipient.receiveMany(deposits, Date.now());
    expect(received).toHaveLength(2);
    expect(reopenedRecipient.listInbox()).toHaveLength(1);
    const oldAck = received.find(item => item.request.generationId === first.generationId)!;
    const newAck = received.find(item => item.request.generationId === refreshedRequest.generationId)!;
    expect((await clientA.acknowledgeOfflineDiscovery(oldAck.ackBytes)).status).toBe('ok');
    expect(await clientA.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index: refreshed, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).toEqual([refreshedRequest.depositBytes]);
    expect((await clientA.acknowledgeOfflineDiscovery(newAck.ackBytes)).status).toBe('ok');
    expect(await clientA.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index: refreshed, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).toEqual([]);

    const content = contentStores(directory);
    const channel = contentChannels(keys, generateLeasedIndexKeyMaterialV1(), content.owner, content.requester);
    content.owner.retainOriginal(
      refreshed,
      originalBytes,
      Uint8Array.from(Buffer.from(local.read().originals[0].commitmentKey, 'base64url')),
    );
    const contentRequester = content.requester;
    const delivered = await deliverContent(clientA, content.owner, contentRequester, channel, refreshed, Date.now());
    expect(new TextDecoder().decode(delivered)).toBe('live exact original');
    const offlineContentRequest = contentRequester.createRequest({
      channelId: channel.channelId,
      index: refreshed,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    const offlineContentOperation = contentRequester.prepareRequest(offlineContentRequest).operationBytes;
    await expect(clientA.sendContentOperation(offlineContentOperation)).rejects.toThrow('counterparty_offline');
    expect(contentRequester.receivedContent(offlineContentRequest)).toBeUndefined();

    const withdrawal = local.withdraw(refreshedWriter.writerLeaseId!, Date.now());
    expect((await clientA.submitLeasedIndexOperation(withdrawal)).status).toBe('ok');
    expect((await clientA.depositOfflineDiscovery(refreshedRequest.depositBytes)).status).toBe('withdrawn');
    clientA.disconnect();
    await expect(clientA.submitLeasedIndexOperation(withdrawal)).rejects.toThrow('disconnected');
  }, 45_000);

  it('delivers online content through the existing two-relay private forward path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-client-held-private-'));
    directories.push(directory);
    const entry = await relay(join(directory, 'entry'));
    const destination = await relay(join(directory, 'destination'), { ipv6: true });
    const destinationContact = await discoverRelayContactV1(createRelayContactHintV1('configured', destination.endpoint));
    expect(entry.server.observeRelayDescriptor(destinationContact.responder)).toBe('accepted');
    const privateClient = createRelayClient({
      relayUrl: destination.endpoint,
      privateEntryUrls: [entry.endpoint],
      admissionCapabilityProvider: admissionProvider,
    });
    clients.push(privateClient);
    const ownerKeys = generateLeasedIndexKeyMaterialV1();
    const requesterKeys = generateLeasedIndexKeyMaterialV1();
    const original = new TextEncoder().encode('private live original');
    const commitmentKey = generateOriginalCommitmentKeyV1();
    const index = createLeasedIndexV1({
      groupId: 'public', itemType: 'offer', derivationId: 'fixed-private-live-v1', fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1), originalCommitment: createOriginalCommitmentV1(original, commitmentKey),
      createdAt: Date.now() - 1_000, expiresAt: Date.now() + DAY,
    }, ownerKeys);
    const content = contentStores(directory);
    const channel = contentChannels(ownerKeys, requesterKeys, content.owner, content.requester);
    content.owner.retainOriginal(index, original, commitmentKey);
    const delivered = await deliverContent(privateClient, content.owner, content.requester, channel, index, Date.now());
    expect(new TextDecoder().decode(delivered)).toBe('private live original');
    privateClient.disconnect();
    await expect(privateClient.pollContent(createContentPollRequestV1({
      channelId: channel.channelId,
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, channel.requesterRelationship))).rejects.toThrow('disconnected');
  }, 45_000);

  it('retains an RPC conflict after ACK and restart without delivery or another logical request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-live-conflict-'));
    directories.push(directory);
    const repairIdentity = generateIdentity();
    let running = await relay(join(directory, 'relay'));
    let network = client(running.endpoint);
    const keys = generateLeasedIndexKeyMaterialV1();
    const index = fixedLiveIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    const indexBytes = JSON.stringify(index);
    expect((await network.submitLeasedIndexOperation(indexBytes)).status).toBe('ok');
    const sender = open(OfflineRequestStore.open({
      path: join(directory, 'sender.json'), encryptionKey: randomBytes(32),
    }));
    const recipient = open(OfflineRequestStore.open({
      path: join(directory, 'recipient.json'), encryptionKey: randomBytes(32),
    }));
    recipient.retainGeneration(index, keys);
    const value = sender.createDeposit({
      index, requestNonce: new Uint8Array(16).fill(8), payload: 'live conflict request',
      replyCapability: 'reply-capability', createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL, selectedRelayIds: [running.server.getRelayDescriptor()!.relayId],
    });
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('stored');
    const fetched = await network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys));
    const received = recipient.receive(fetched[0], Date.now());
    expect((await network.acknowledgeOfflineDiscovery(received.ackBytes)).status).toBe('ok');
    const changed = changedOfflineDeposit(sender, index);
    expect(changed).not.toBe(value.depositBytes);
    expect((await network.depositOfflineDiscovery(changed)).status).toBe('conflicting_request');

    await running.server.stop({ graceful: false });
    servers.splice(servers.indexOf(running.server), 1);
    network.disconnect();
    running = await relay(join(directory, 'relay'));
    network = client(running.endpoint);
    expect((await network.depositOfflineDiscovery(changed)).status).toBe('conflicting_request');
    await expect(network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).rejects.toThrow('conflicting_request');
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('duplicate');
  }, 30_000);

  it('propagates a repaired terminal withdrawal to the mailbox across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-live-terminal-repair-'));
    directories.push(directory);
    const repairIdentity = generateIdentity();
    let running = await relay(join(directory, 'relay'), { approvedRelays: [repairIdentity.did] });
    let network = client(running.endpoint);
    const keys = generateLeasedIndexKeyMaterialV1();
    const index = fixedLiveIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    const indexBytes = JSON.stringify(index);
    expect((await network.submitLeasedIndexOperation(indexBytes)).status).toBe('ok');
    const sender = open(OfflineRequestStore.open({
      path: join(directory, 'sender.json'), encryptionKey: randomBytes(32),
    }));
    const value = sender.createDeposit({
      index, requestNonce: new Uint8Array(16).fill(9), payload: 'terminal repair request',
      replyCapability: 'reply-capability', createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL, selectedRelayIds: [running.server.getRelayDescriptor()!.relayId],
    });
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('stored');
    const withdrawal = createLeasedIndexWithdrawalV1(index, keys, Date.now());
    const repair = createClientHeldRepairRequestV1({
      targetRelayId: running.server.getRelayDescriptor()!.relayId,
      operationBytes: JSON.stringify(withdrawal),
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, repairIdentity);
    expect((await network.repairClientHeld(repair)).status).toBe('ok');
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('withdrawn');
    await expect(network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).rejects.toThrow('stale_or_quarantined');

    await running.server.stop({ graceful: false });
    servers.splice(servers.indexOf(running.server), 1);
    network.disconnect();
    running = await relay(join(directory, 'relay'), { approvedRelays: [repairIdentity.did] });
    network = client(running.endpoint);
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('withdrawn');
    await expect(network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).rejects.toThrow('stale_or_quarantined');
  }, 30_000);

  it('fails deposit and fetch closed after a repaired current-sequence conflict, including restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-live-quarantine-'));
    directories.push(directory);
    const repairIdentity = generateIdentity();
    let running = await relay(join(directory, 'relay'), { approvedRelays: [repairIdentity.did] });
    let network = client(running.endpoint);
    const keys = generateLeasedIndexKeyMaterialV1();
    const index = fixedLiveIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    const conflict = fixedLiveIndex(keys, index.createdAt, index.expiresAt - 1);
    expect((await network.submitLeasedIndexOperation(JSON.stringify(index))).status).toBe('ok');
    const sender = open(OfflineRequestStore.open({
      path: join(directory, 'sender.json'), encryptionKey: randomBytes(32),
    }));
    const value = sender.createDeposit({
      index, requestNonce: new Uint8Array(16).fill(10), payload: 'quarantine repair request',
      replyCapability: 'reply-capability', createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL, selectedRelayIds: [running.server.getRelayDescriptor()!.relayId],
    });
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('stored');
    const repair = createClientHeldRepairRequestV1({
      targetRelayId: running.server.getRelayDescriptor()!.relayId,
      operationBytes: JSON.stringify(conflict),
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, repairIdentity);
    expect((await network.repairClientHeld(repair)).status).toBe('ok');
    await expect(network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).rejects.toThrow('stale_or_quarantined');
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('duplicate');

    await running.server.stop({ graceful: false });
    servers.splice(servers.indexOf(running.server), 1);
    network.disconnect();
    running = await relay(join(directory, 'relay'), { approvedRelays: [repairIdentity.did] });
    network = client(running.endpoint);
    await expect(network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
      index, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, keys))).rejects.toThrow('stale_or_quarantined');
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('duplicate');
  }, 30_000);

  it('isolates a repaired conflict to the exact publication sharing a client lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-live-publication-quarantine-'));
    directories.push(directory);
    const repairIdentity = generateIdentity();
    let running = await relay(join(directory, 'relay'), { approvedRelays: [repairIdentity.did] });
    let network = client(running.endpoint);
    const keysA = generateLeasedIndexKeyMaterialV1();
    const keysB = {
      ...generateLeasedIndexKeyMaterialV1(),
      clientLeaseId: keysA.clientLeaseId,
    };
    const indexA = fixedLiveIndex(keysA, Date.now() - 1_000, Date.now() + DAY, 1);
    const indexB = fixedLiveIndex(keysB, Date.now() - 1_000, Date.now() + DAY, 2);
    const conflictA = fixedLiveIndex(keysA, indexA.createdAt, indexA.expiresAt - 1, 1);
    expect(indexA.publicationId).not.toBe(indexB.publicationId);
    expect(indexA.clientLeaseId).toBe(indexB.clientLeaseId);
    expect((await network.submitLeasedIndexOperation(JSON.stringify(indexA))).status).toBe('ok');
    expect((await network.submitLeasedIndexOperation(JSON.stringify(indexB))).status).toBe('ok');
    const senderA = open(OfflineRequestStore.open({
      path: join(directory, 'sender-a.json'), encryptionKey: randomBytes(32),
    }));
    const senderB = open(OfflineRequestStore.open({
      path: join(directory, 'sender-b.json'), encryptionKey: randomBytes(32),
    }));
    const valueA = senderA.createDeposit({
      index: indexA, requestNonce: new Uint8Array(16).fill(11), payload: 'publication A request',
      replyCapability: 'reply-capability', createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL, selectedRelayIds: [running.server.getRelayDescriptor()!.relayId],
    });
    const valueB = senderB.createDeposit({
      index: indexB, requestNonce: new Uint8Array(16).fill(12), payload: 'publication B request',
      replyCapability: 'reply-capability', createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL, selectedRelayIds: [running.server.getRelayDescriptor()!.relayId],
    });
    expect((await network.depositOfflineDiscovery(valueA.depositBytes)).status).toBe('stored');
    expect((await network.depositOfflineDiscovery(valueB.depositBytes)).status).toBe('stored');
    const changedA = changedOfflineDeposit(senderA, indexA);
    const repair = createClientHeldRepairRequestV1({
      targetRelayId: running.server.getRelayDescriptor()!.relayId,
      operationBytes: JSON.stringify(conflictA),
      createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, repairIdentity);
    expect((await network.repairClientHeld(repair)).status).toBe('ok');

    const assertIsolation = async () => {
      await expect(network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
        index: indexA, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
      }, keysA))).rejects.toThrow('stale_or_quarantined');
      expect((await network.depositOfflineDiscovery(changedA)).status).toBe('stale_index');
      expect((await network.depositOfflineDiscovery(valueA.depositBytes)).status).toBe('duplicate');
      expect(await network.fetchOfflineDiscovery(createOfflineFetchRequestV1({
        index: indexB, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
      }, keysB))).toEqual([valueB.depositBytes]);
      expect((await network.depositOfflineDiscovery(valueB.depositBytes)).status).toBe('duplicate');
    };
    await assertIsolation();

    await running.server.stop({ graceful: false });
    servers.splice(servers.indexOf(running.server), 1);
    network.disconnect();
    running = await relay(join(directory, 'relay'), { approvedRelays: [repairIdentity.did] });
    network = client(running.endpoint);
    await assertIsolation();
  }, 30_000);

  it('returns independent exact operations for multiple publications sharing lease and item type', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-live-search-identity-'));
    directories.push(directory);
    const running = await relay(join(directory, 'relay'));
    const network = client(running.endpoint);
    const firstKeys = generateLeasedIndexKeyMaterialV1();
    const secondKeys = {
      ...generateLeasedIndexKeyMaterialV1(),
      clientLeaseId: firstKeys.clientLeaseId,
    };
    const first = fixedLiveIndex(firstKeys, Date.now() - 1_000, Date.now() + DAY);
    const second = fixedLiveIndex(secondKeys, Date.now() - 1_000, Date.now() + DAY);
    expect((await network.submitLeasedIndexOperation(JSON.stringify(first))).status).toBe('ok');
    expect((await network.submitLeasedIndexOperation(JSON.stringify(second))).status).toBe('ok');

    const results = await network.searchLeasedIndexes(createLeasedIndexSearchRequestV1({
      groupId: 'public', itemType: 'offer', fingerprintEpoch: 'epoch-1', fingerprint: new Uint8Array(64).fill(1),
      limit: 10, createdAt: Date.now(), expiresAt: Date.now() + 30_000,
    }, generateSigningKeyPair()));
    expect(new Set(results)).toEqual(new Set([JSON.stringify(first), JSON.stringify(second)]));
    expect(first.publicationId).not.toBe(second.publicationId);
    expect(first.clientLeaseId).toBe(second.clientLeaseId);
  }, 30_000);
});

const ADMISSION_FOR_LOCAL: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'live-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};
