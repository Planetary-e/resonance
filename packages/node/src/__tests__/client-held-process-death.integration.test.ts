import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createClientHeldRepairRequestV1,
  createContentPollRequestV1,
  createLeasedIndexLookupRequestV1,
  createLeasedIndexSearchRequestV1,
  createLeasedIndexV1,
  createLeasedIndexWithdrawalV1,
  createOfflineFetchRequestV1,
  createOfflineSyncRequestV1,
  createOriginalCommitmentV1,
  createPairwiseChannelId,
  deriveSharedSecret,
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  generateSigningKeyPair,
  serializeOfflineDiscoveryDepositV1,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { ContentGrantStore } from '../content-grant-store.js';
import { OfflineRequestStore } from '../offline-request-store.js';
import { createRelayClient } from '../relay-client.js';
import {
  ADMISSION_FOR_LOCAL,
  LocalProcess,
  ProcessRelay,
  admissionProvider,
  fixedIndex,
  type ProcessDeathEvidence,
} from './fixtures/client-held-process-harness.js';

const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const relays: ProcessRelay[] = [];
const locals: LocalProcess[] = [];
const clients: Array<{ disconnect(): void }> = [];
const stores: Array<{ close(): void }> = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'resonance-client-held-process-'));
  directories.push(value);
  return value;
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

function lookup(publicationId: string, generationId?: string) {
  return createLeasedIndexLookupRequestV1({
    publicationId,
    ...(generationId ? { generationId } : {}),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  }, generateSigningKeyPair());
}

function fetchRequest(index: LeasedIndexV1) {
  return createOfflineFetchRequestV1({
    index,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  }, keysFor(index));
}

const keyByPublication = new Map<string, LeasedIndexKeyMaterialV1>();
function keysFor(index: LeasedIndexV1): LeasedIndexKeyMaterialV1 {
  return keyByPublication.get(index.publicationId)!;
}

function retainKeys(keys: LeasedIndexKeyMaterialV1): LeasedIndexKeyMaterialV1 {
  keyByPublication.set(keys.publicationId, keys);
  return keys;
}

function repairRequest(relay: ProcessRelay, operationBytes: string, identity: ReturnType<typeof generateIdentity>) {
  return createClientHeldRepairRequestV1({
    targetRelayId: relay.descriptor.relayId,
    operationBytes,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  }, identity);
}

function syncRequest(
  relay: ProcessRelay,
  index: LeasedIndexV1,
  events: any[],
  identity: ReturnType<typeof generateIdentity>,
) {
  return createOfflineSyncRequestV1({
    targetRelayId: relay.descriptor.relayId,
    clientLeaseId: index.clientLeaseId,
    cursor: 0,
    events,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
  }, identity);
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

function recordEvidence(test: string, deaths: ProcessDeathEvidence[], extra: Record<string, unknown> = {}): void {
  console.log(`PROCESS_DEATH_QUALIFICATION ${JSON.stringify({ test, sigkills: deaths.length, deaths, ...extra })}`);
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const value of clients.splice(0)) value.disconnect();
  await Promise.allSettled(locals.splice(0).map(value => value.stop()));
  await Promise.allSettled(relays.splice(0).map(value => value.stop()));
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
  keyByPublication.clear();
});

describe('client-held process-death qualification', () => {
  it.each(['publication', 'refresh', 'withdrawal', 'repair'] as const)(
    'kills a real relay after the durable %s commit and before its reply',
    async kind => {
      const root = directory();
      const repairIdentity = generateIdentity();
      let relay = await ProcessRelay.start(join(root, 'relay'), [repairIdentity.did]);
      relays.push(relay);
      let network = client(relay.endpoint);
      const keys = retainKeys(generateLeasedIndexKeyMaterialV1());
      const initial = fixedIndex(keys, Date.now() - DAY, Date.now() + 6 * DAY);
      const initialBytes = JSON.stringify(initial);
      let operationBytes = initialBytes;
      let maintenance: ReturnType<typeof repairRequest> | undefined;
      if (kind === 'refresh' || kind === 'withdrawal') {
        expect((await network.submitLeasedIndexOperation(initialBytes)).status).toBe('ok');
      }
      if (kind === 'refresh') {
        operationBytes = JSON.stringify(createLeasedIndexV1({
          leaseSequence: initial.leaseSequence + 1,
          semanticRevision: initial.semanticRevision,
          groupId: initial.groupId,
          itemType: initial.itemType,
          derivationId: initial.derivationId,
          fingerprintEpoch: initial.fingerprint.epoch,
          fingerprint: new Uint8Array(64).fill(1),
          originalCommitment: initial.original.commitment,
          createdAt: initial.createdAt + DAY,
          expiresAt: initial.expiresAt + DAY,
        }, keys));
      }
      if (kind === 'withdrawal') {
        operationBytes = JSON.stringify(createLeasedIndexWithdrawalV1(initial, keys, Date.now()));
      }
      if (kind === 'repair') maintenance = repairRequest(relay, operationBytes, repairIdentity);
      await relay.arm('index-save', operationBytes);
      const first = maintenance
        ? network.repairClientHeld(maintenance)
        : network.submitLeasedIndexOperation(operationBytes);
      await expect(first).rejects.toThrow();
      const death = await relay.kill('index-save');
      network.disconnect();
      relay = await ProcessRelay.start(join(root, 'relay'), [repairIdentity.did]);
      relays.push(relay);
      network = client(relay.endpoint);
      const spendsBeforeRetry = await relay.authenticatedSpends();
      const retry = maintenance
        ? await network.repairClientHeld(maintenance)
        : await network.submitLeasedIndexOperation(operationBytes);
      expect(retry.status).toBe('ok');
      expect(await relay.authenticatedSpends()).toBe(spendsBeforeRetry);
      const current = await network.lookupLeasedIndex(lookup(keys.publicationId));
      expect(current).toBe(operationBytes);
      const matches = await network.searchLeasedIndexes(createLeasedIndexSearchRequestV1({
        groupId: 'public',
        itemType: 'offer',
        fingerprintEpoch: 'epoch-1',
        fingerprint: new Uint8Array(64).fill(1),
        limit: 10,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30_000,
      }, generateSigningKeyPair()));
      expect(matches).toEqual(kind === 'withdrawal' ? [] : [operationBytes]);
      recordEvidence(kind, [death], { exactRetry: 'ok', duplicateSpend: false });
    },
    30_000,
  );

  it('recovers a durable mailbox deposit after reply loss without a second allocation or spend', async () => {
    const root = directory();
    let relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    let network = client(relay.endpoint);
    const keys = retainKeys(generateLeasedIndexKeyMaterialV1());
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    expect((await network.submitLeasedIndexOperation(JSON.stringify(index))).status).toBe('ok');
    const sender = open(OfflineRequestStore.open({
      path: join(root, 'sender.json'),
      encryptionKey: randomBytes(32),
    }));
    const value = sender.createDeposit({
      index,
      requestNonce: new Uint8Array(16).fill(21),
      payload: 'durable deposit',
      replyCapability: 'reply-capability',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL,
      selectedRelayIds: [relay.descriptor.relayId],
    });
    await relay.arm('deposit-append', value.depositBytes);
    await expect(network.depositOfflineDiscovery(value.depositBytes)).rejects.toThrow();
    const death = await relay.kill('deposit-append');
    network.disconnect();
    relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    network = client(relay.endpoint);
    const spendsBeforeRetry = await relay.authenticatedSpends();
    const retry = await network.depositOfflineDiscovery(value.depositBytes);
    expect(retry.status).toBe('duplicate');
    expect(retry.receipt).toBeDefined();
    expect(await relay.authenticatedSpends()).toBe(spendsBeforeRetry);
    expect(sender.recordReceipt(value.requestId, retry.receipt!)).toBe('stored');
    expect(sender.recordReceipt(value.requestId, retry.receipt!)).toBe('stored');
    expect(await network.fetchOfflineDiscovery(fetchRequest(index))).toEqual([value.depositBytes]);
    expect(sender.listOutbox()).toHaveLength(1);
    expect(sender.listOutbox()[0].generations).toHaveLength(1);
    recordEvidence('mailbox-deposit', [death], {
      exactRetry: 'duplicate', outboxEntries: 1, generations: 1, duplicateSpend: false,
    });
  }, 30_000);

  it('recovers recipient inbox and ACK commits, then the relay ACK append and lost reply', async () => {
    const root = directory();
    let relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    let network = client(relay.endpoint);
    const keys = retainKeys(generateLeasedIndexKeyMaterialV1());
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    expect((await network.submitLeasedIndexOperation(JSON.stringify(index))).status).toBe('ok');
    const sender = open(OfflineRequestStore.open({
      path: join(root, 'sender.json'),
      encryptionKey: randomBytes(32),
    }));
    const value = sender.createDeposit({
      index,
      requestNonce: new Uint8Array(16).fill(22),
      payload: 'recipient recovery',
      replyCapability: 'reply-capability',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL,
      selectedRelayIds: [relay.descriptor.relayId],
    });
    expect((await network.depositOfflineDiscovery(value.depositBytes)).status).toBe('stored');
    const recipientPath = join(root, 'recipient.json');
    const recipientKey = randomBytes(32);
    const recipient = open(OfflineRequestStore.open({ path: recipientPath, encryptionKey: recipientKey }));
    recipient.retainGeneration(index, keys);
    recipient.close();
    const receivedAt = Date.now();
    const deaths: ProcessDeathEvidence[] = [];

    let local = await LocalProcess.start('offline', recipientPath, recipientKey);
    locals.push(local);
    await expect(local.run('inbox-commit', { raw: value.depositBytes, now: receivedAt })).rejects.toThrow();
    deaths.push(await local.kill('inbox-commit'));
    let reopened = open(OfflineRequestStore.open({ path: recipientPath, encryptionKey: recipientKey }));
    expect(reopened.listInbox()).toHaveLength(1);
    expect(reopened.pendingAcks()).toEqual([]);
    reopened.close();

    local = await LocalProcess.start('offline', recipientPath, recipientKey);
    locals.push(local);
    await expect(local.run('offline-ack-commit', { raw: value.depositBytes, now: receivedAt })).rejects.toThrow();
    deaths.push(await local.kill('offline-ack-commit'));
    reopened = open(OfflineRequestStore.open({ path: recipientPath, encryptionKey: recipientKey }));
    expect(reopened.listInbox()).toHaveLength(1);
    expect(reopened.pendingAcks()).toHaveLength(1);
    const replay = reopened.receive(value.depositBytes, receivedAt);
    expect(replay.status).toBe('duplicate');
    expect(replay.ackBytes).toBe(reopened.pendingAcks()[0]);
    expect(reopened.listInbox()).toHaveLength(1);
    expect(reopened.pendingAcks()).toHaveLength(1);

    await relay.arm('ack-append', replay.ackBytes);
    await expect(network.acknowledgeOfflineDiscovery(replay.ackBytes)).rejects.toThrow();
    deaths.push(await relay.kill('ack-append'));
    network.disconnect();
    relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    network = client(relay.endpoint);
    expect((await network.acknowledgeOfflineDiscovery(replay.ackBytes)).status).toBe('ok');
    expect(await network.fetchOfflineDiscovery(fetchRequest(index))).toEqual([]);
    reopened.markAcknowledged(replay.ackBytes);
    sender.recordGenerationAck(value.requestId, replay.ackBytes);
    expect(reopened.pendingAcks()).toEqual([]);
    expect(sender.listOutbox()[0].state).toBe('acknowledged');
    recordEvidence('recipient-and-relay-ack', deaths, {
      inboxEntries: 1, pendingAcksAfterReplay: 0, exactAckRetry: 'ok',
    });
  }, 30_000);

  it('recovers a sync deposit after target append and reply loss', async () => {
    const root = directory();
    const repairIdentity = generateIdentity();
    const source = await ProcessRelay.start(join(root, 'source'), [repairIdentity.did]);
    let target = await ProcessRelay.start(join(root, 'target'), [repairIdentity.did]);
    relays.push(source, target);
    const sourceNetwork = client(source.endpoint);
    let targetNetwork = client(target.endpoint);
    const keys = retainKeys(generateLeasedIndexKeyMaterialV1());
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    const indexBytes = JSON.stringify(index);
    expect((await sourceNetwork.submitLeasedIndexOperation(indexBytes)).status).toBe('ok');
    const sender = open(OfflineRequestStore.open({
      path: join(root, 'sender.json'),
      encryptionKey: randomBytes(32),
    }));
    const value = sender.createDeposit({
      index,
      requestNonce: new Uint8Array(16).fill(23),
      payload: 'sync recovery',
      replyCapability: 'reply-capability',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL,
      selectedRelayIds: [source.descriptor.relayId, target.descriptor.relayId],
    });
    expect((await sourceNetwork.depositOfflineDiscovery(value.depositBytes)).status).toBe('stored');
    const page = await sourceNetwork.syncOfflineDiscovery(syncRequest(source, index, [], repairIdentity));
    expect(page.events).toHaveLength(1);
    expect((await targetNetwork.repairClientHeld(repairRequest(target, indexBytes, repairIdentity))).status).toBe('ok');
    const request = syncRequest(target, index, page.events, repairIdentity);
    await target.arm('deposit-append', serializeOfflineDiscoveryDepositV1(valueDeposit(page.events)));
    await expect(targetNetwork.syncOfflineDiscovery(request)).rejects.toThrow();
    const death = await target.kill('deposit-append');
    targetNetwork.disconnect();
    target = await ProcessRelay.start(join(root, 'target'), [repairIdentity.did]);
    relays.push(target);
    targetNetwork = client(target.endpoint);
    const spendsBeforeRetry = await target.authenticatedSpends();
    const retry = await targetNetwork.syncOfflineDiscovery(request);
    expect(retry.events).toHaveLength(1);
    expect(await target.authenticatedSpends()).toBe(spendsBeforeRetry);
    expect(await targetNetwork.fetchOfflineDiscovery(fetchRequest(index))).toEqual([value.depositBytes]);
    recordEvidence('mailbox-sync', [death], {
      exactRetryEvents: retry.events.length, fetchedCopies: 1, duplicateSpend: false,
    });
  }, 30_000);

  it('repairs one and then two lost queued relay copies without premature queued state', async () => {
    const root = directory();
    const repairIdentity = generateIdentity();
    const initialRelays = await Promise.all([0, 1, 2].map(index => (
      ProcessRelay.start(join(root, `relay-${index}`), [repairIdentity.did])
    )));
    relays.push(...initialRelays);
    const networks = initialRelays.map(value => client(value.endpoint));
    const keys = retainKeys(generateLeasedIndexKeyMaterialV1());
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + DAY);
    const indexBytes = JSON.stringify(index);
    for (const network of networks) {
      expect((await network.submitLeasedIndexOperation(indexBytes)).status).toBe('ok');
    }
    const sender = open(OfflineRequestStore.open({
      path: join(root, 'sender.json'),
      encryptionKey: randomBytes(32),
    }));
    const value = sender.createDeposit({
      index,
      requestNonce: new Uint8Array(16).fill(24),
      payload: 'three-copy recovery',
      replyCapability: 'reply-capability',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      admission: ADMISSION_FOR_LOCAL,
      selectedRelayIds: initialRelays.map(value => value.descriptor.relayId),
    });
    const states: string[] = [];
    for (const network of networks) {
      const result = await network.depositOfflineDiscovery(value.depositBytes);
      expect(result.status).toBe('stored');
      states.push(sender.recordReceipt(value.requestId, result.receipt!));
    }
    expect(states).toEqual(['stored', 'stored', 'queued']);
    const deaths: ProcessDeathEvidence[] = [];
    deaths.push(await initialRelays[1].kill('queued-copy-loss-1'));
    rmSync(join(root, 'relay-1'), { recursive: true, force: true });
    const replacement1 = await ProcessRelay.start(join(root, 'replacement-1'), [repairIdentity.did]);
    relays.push(replacement1);
    const replacementNetwork1 = client(replacement1.endpoint);
    expect((await replacementNetwork1.repairClientHeld(
      repairRequest(replacement1, indexBytes, repairIdentity),
    )).status).toBe('ok');
    const page = await networks[0].syncOfflineDiscovery(syncRequest(initialRelays[0], index, [], repairIdentity));
    await replacementNetwork1.syncOfflineDiscovery(syncRequest(replacement1, index, page.events, repairIdentity));
    expect(await replacementNetwork1.fetchOfflineDiscovery(fetchRequest(index))).toEqual([value.depositBytes]);

    deaths.push(await initialRelays[2].kill('queued-copy-loss-2'));
    rmSync(join(root, 'relay-2'), { recursive: true, force: true });
    const replacement2 = await ProcessRelay.start(join(root, 'replacement-2'), [repairIdentity.did]);
    relays.push(replacement2);
    const replacementNetwork2 = client(replacement2.endpoint);
    expect((await replacementNetwork2.repairClientHeld(
      repairRequest(replacement2, indexBytes, repairIdentity),
    )).status).toBe('ok');
    await replacementNetwork2.syncOfflineDiscovery(syncRequest(replacement2, index, page.events, repairIdentity));
    expect(await replacementNetwork2.fetchOfflineDiscovery(fetchRequest(index))).toEqual([value.depositBytes]);
    expect(sender.listOutbox()[0].generations[0].receipts).toHaveLength(3);
    expect(sender.listOutbox()[0].state).toBe('queued');
    recordEvidence('queued-copy-loss-and-repair', deaths, {
      receiptStates: states, uniqueReceipts: 3, repairedCopies: 2,
    });
  }, 45_000);

  it('recovers online content request, poll, response, and receipt barriers without duplicate operations', async () => {
    const root = directory();
    let relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    let network = client(relay.endpoint);
    const ownerKeys = retainKeys(generateLeasedIndexKeyMaterialV1());
    const requesterKeys = retainKeys(generateLeasedIndexKeyMaterialV1());
    const original = new TextEncoder().encode('process death online original');
    const commitmentKey = generateOriginalCommitmentKeyV1();
    const index = createLeasedIndexV1({
      groupId: 'public',
      itemType: 'offer',
      derivationId: 'process-content-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1),
      originalCommitment: createOriginalCommitmentV1(original, commitmentKey),
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + DAY,
    }, ownerKeys);
    const ownerPath = join(root, 'content-owner.json');
    const requesterPath = join(root, 'content-requester.json');
    const ownerKey = randomBytes(32);
    const requesterKey = randomBytes(32);
    let owner = open(ContentGrantStore.open({ path: ownerPath, encryptionKey: ownerKey }));
    let requester = open(ContentGrantStore.open({ path: requesterPath, encryptionKey: requesterKey }));
    const channel = contentChannels(ownerKeys, requesterKeys, owner, requester);
    owner.retainOriginal(index, original, commitmentKey);
    const requestId = requester.createRequest({
      channelId: channel.channelId,
      index,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    requester.close();
    const deaths: ProcessDeathEvidence[] = [];

    let local = await LocalProcess.start('content', requesterPath, requesterKey);
    locals.push(local);
    await expect(local.run('content-request-commit', { recordId: requestId })).rejects.toThrow();
    deaths.push(await local.kill('content-request-commit'));
    requester = open(ContentGrantStore.open({ path: requesterPath, encryptionKey: requesterKey }));
    expect(requester.requestState(requestId)).toBe('outcome-unknown');
    const requestOperation = requester.prepareRequest(requestId).operationBytes;
    expect(requester.prepareRequest(requestId).operationBytes).toBe(requestOperation);

    const pollRequest = createContentPollRequestV1({
      channelId: channel.channelId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    }, channel.ownerRelationship);
    const interruptedPoll = network.pollContent(pollRequest);
    await new Promise(resolve => setTimeout(resolve, 50));
    deaths.push(await relay.kill('content-poll-inflight'));
    await expect(interruptedPoll).rejects.toThrow();
    network.disconnect();
    relay = await ProcessRelay.start(join(root, 'relay'));
    relays.push(relay);
    network = client(relay.endpoint);
    const ownerPoll = network.pollContent(pollRequest);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await network.sendContentOperation(requestOperation)).status).toBe('ok');
    expect(owner.receiveRequest(await ownerPoll, Date.now()).status).toBe('received');
    expect(owner.receiveRequest(requestOperation, Date.now()).status).toBe('duplicate');
    const grant = owner.grantRequest({
      requestId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    });
    expect(grant.status).toBe('granted');
    owner.close();

    local = await LocalProcess.start('content', ownerPath, ownerKey);
    locals.push(local);
    await expect(local.run('content-response-commit', { recordId: grant.grantId! })).rejects.toThrow();
    deaths.push(await local.kill('content-response-commit'));
    owner = open(ContentGrantStore.open({ path: ownerPath, encryptionKey: ownerKey }));
    expect(owner.grantState(grant.grantId!)).toBe('outcome-unknown');
    const responseOperation = owner.prepareResponse(grant.grantId!).operationBytes;
    expect(owner.prepareResponse(grant.grantId!).operationBytes).toBe(responseOperation);
    expect(owner.grantRequest({
      requestId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    })).toMatchObject({ status: 'duplicate', grantId: grant.grantId });

    const requesterPoll = network.pollContent(createContentPollRequestV1({
      channelId: channel.channelId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    }, channel.requesterRelationship));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await network.sendContentOperation(responseOperation)).status).toBe('ok');
    const rawResponse = await requesterPoll;
    requester.close();
    local = await LocalProcess.start('content', requesterPath, requesterKey);
    locals.push(local);
    await expect(local.run('content-receive-commit', { raw: rawResponse, now: Date.now() })).rejects.toThrow();
    deaths.push(await local.kill('content-receive-commit'));
    requester = open(ContentGrantStore.open({ path: requesterPath, encryptionKey: requesterKey }));
    expect(new TextDecoder().decode(requester.receivedContent(requestId))).toBe('process death online original');
    const duplicate = requester.receiveResponse(rawResponse, Date.now());
    expect(duplicate.status).toBe('duplicate');
    expect(new TextDecoder().decode(duplicate.originalBytes)).toBe('process death online original');
    recordEvidence('online-content', deaths, {
      exactRequestRetry: true, exactResponseRetry: true, duplicateRequest: true, duplicateResponse: true,
    });
  }, 45_000);
});

function valueDeposit(events: any[]) {
  return events[0].deposit;
}
