import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import {
  createAdmissionRequestBindingV2,
  createConsentOfferV2,
  createDeterministicMatchId,
  createPublicationRecord,
  createPublicationTombstone,
  encryptRelationshipMessage,
  generateIdentity,
  generatePublicationKeyMaterial,
  generateRelationshipKeyMaterial,
} from '@resonance/core';
import {
  createRelayServer,
  RELAY_OPERATION_LOG_FILENAME,
  type RelayServer,
} from '@resonance/relay';
import { createRelayClient } from '../relay-client.js';
import { createPairwiseChannelManagerV2 } from '../pairwise-channel-v2.js';
import { openStoreAsync } from '../store.js';

const PORT = 39090 + Math.floor(Math.random() * 1000);
const PERSIST_DIR = `/tmp/resonance-e2e-${Date.now()}`;
let server: RelayServer;

beforeAll(async () => {
  server = createRelayServer({
    port: PORT,
    host: '127.0.0.1',
    persistDir: PERSIST_DIR,
    maxAuthAttemptsPerMin: 100,
    maxPublishesPerMin: 100,
    maxSearchesPerMin: 100,
    persistIntervalMs: 999_999,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(PERSIST_DIR, { recursive: true, force: true });
});

describe('protocol v2 node-to-relay flow', () => {
  it('asks a capability wallet for a proof bound to the exact relay request', async () => {
    const now = Date.now();
    const publication = createPublicationRecord({
      groupId: `admission-client-${now}`,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x2a),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, generatePublicationKeyMaterial());
    const contexts: Array<{ relayUrl: string; action: string; requestBinding: string }> = [];
    const client = createRelayClient({
      relayUrl: `ws://localhost:${PORT}`,
      admissionCapabilityProvider(context) {
        contexts.push(context);
        return {
          version: 2,
          kind: 'admission-capability',
          scheme: 'test-v1',
          issuer: 'community:test',
          token: 'C'.repeat(43),
          requestProof: context.requestBinding,
        };
      },
    });

    expect((await client.submitPublicationOperation(publication)).status).toBe('ok');
    expect(contexts).toEqual([{
      relayUrl: `ws://localhost:${PORT}`,
      action: 'publication-write',
      requestBinding: createAdmissionRequestBindingV2('publication-write', publication),
    }]);
  });

  it('publishes and withdraws using encrypted local publication keys and no client connection', async () => {
    const publicationsBefore = server.getStats().stored_publications;
    const identity = generateIdentity();
    const store = await openStoreAsync(':memory:', nacl.randomBytes(nacl.secretbox.keyLength));
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x7e),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, keys);
    store.insertItem({
      id: 'local-item',
      type: 'offer',
      rawText: 'Bicycle repair available',
      embedding: new Float32Array([0.25, 0.75]),
      privacyLevel: 'medium',
    });
    store.insertPublication('local-item', record, keys);

    const client = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity });
    const publishAck = await client.submitPublicationOperation(record);
    expect(publishAck.status).toBe('ok');
    expect(client.isConnected()).toBe(false);

    const persisted = store.getPublicationForItem('local-item')!;
    const tombstone = createPublicationTombstone(
      persisted.record,
      'withdrawn',
      persisted.keys.signingKeyPair,
      now + 1,
    );
    store.setPublicationTombstone('local-item', tombstone);
    const withdrawAck = await client.submitPublicationOperation(tombstone);
    expect(withdrawAck.status).toBe('ok');
    expect(client.isConnected()).toBe(false);
    expect(server.getStats().stored_publications).toBe(publicationsBefore + 1);
    store.close();
  });

  it('uses a fresh unlinkable identity for every short-lived search', async () => {
    const publicationKeys = generatePublicationKeyMaterial();
    const now = Date.now();
    const groupId = `search-integration-${now}`;
    const fingerprint = new Uint8Array(64).fill(0x61);
    const publication = createPublicationRecord({
      groupId,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint,
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, publicationKeys);
    const publisher = createRelayClient({
      relayUrl: `ws://localhost:${PORT}`,
      identity: generateIdentity(),
    });
    await publisher.submitPublicationOperation(publication);

    const searcher = createRelayClient({ relayUrl: `ws://localhost:${PORT}` });
    const input = {
      groupId,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint,
      itemType: 'need' as const,
      k: 5,
      threshold: 0.7,
    };
    const first = await searcher.searchV2(input);
    const second = await searcher.searchV2(input);

    expect(first.searchId).not.toBe(second.searchId);
    expect(first.results).toEqual([{
      publicationId: publication.publicationId,
      similarity: 1,
      itemType: 'offer',
    }]);
    expect(second.results).toEqual(first.results);
    expect(searcher.isConnected()).toBe(false);
  });

  it('keeps two publications from one device independently renewable, withdrawable, and unlinkable from its root', async () => {
    const identity = generateIdentity();
    const store = await openStoreAsync(':memory:', nacl.randomBytes(nacl.secretbox.keyLength));
    const client = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity });
    const firstKeys = generatePublicationKeyMaterial();
    const secondKeys = generatePublicationKeyMaterial();
    const now = Date.now();
    const firstGroup = `multi-publication-a-${now}`;
    const secondGroup = `multi-publication-b-${now}`;
    const firstFingerprint = new Uint8Array(64).fill(0x15);
    const secondFingerprint = new Uint8Array(64).fill(0xea);
    const first = createPublicationRecord({
      groupId: firstGroup,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: firstFingerprint,
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, firstKeys);
    const second = createPublicationRecord({
      groupId: secondGroup,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: secondFingerprint,
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, secondKeys);

    for (const [id, text, record, keys] of [
      ['private-local-first', 'Private first offer', first, firstKeys],
      ['private-local-second', 'Private second offer', second, secondKeys],
    ] as const) {
      store.insertItem({
        id,
        type: 'offer',
        rawText: text,
        embedding: new Float32Array([1, 0]),
        privacyLevel: 'medium',
      });
      store.insertPublication(id, record, keys);
      expect((await client.submitPublicationOperation(record)).status).toBe('ok');
      store.updateItemStatus(id, 'published');
    }

    expect(first.publicationId).not.toBe(second.publicationId);
    expect(first.mailbox.id).not.toBe(second.mailbox.id);

    const firstSearch = await client.searchV2({
      groupId: firstGroup,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: firstFingerprint,
      itemType: 'need',
      k: 5,
      threshold: 0.9,
    });
    const secondSearch = await client.searchV2({
      groupId: secondGroup,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: secondFingerprint,
      itemType: 'need',
      k: 5,
      threshold: 0.9,
    });
    expect(firstSearch.results.map(result => result.publicationId)).toEqual([first.publicationId]);
    expect(secondSearch.results.map(result => result.publicationId)).toEqual([second.publicationId]);
    expect(firstSearch.searchId).not.toBe(secondSearch.searchId);

    const renewedFirst = createPublicationRecord({
      groupId: first.groupId,
      fingerprintEpoch: first.fingerprint.epoch,
      fingerprint: firstFingerprint,
      itemType: first.itemType,
      sequence: first.sequence + 1,
      createdAt: now,
      expiresAt: now + 2 * 86_400_000,
    }, firstKeys);
    expect((await client.submitPublicationOperation(renewedFirst)).status).toBe('ok');

    const withdrawnSecond = createPublicationTombstone(
      second,
      'withdrawn',
      secondKeys.signingKeyPair,
      Date.now(),
    );
    expect((await client.submitPublicationOperation(withdrawnSecond)).status).toBe('ok');
    store.setPublicationTombstone('private-local-second', withdrawnSecond);
    store.updateItemStatus('private-local-second', 'withdrawn');

    const firstAfterUpdate = await client.searchV2({
      groupId: firstGroup,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: firstFingerprint,
      itemType: 'need',
      k: 5,
      threshold: 0.9,
    });
    const secondAfterWithdrawal = await client.searchV2({
      groupId: secondGroup,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: secondFingerprint,
      itemType: 'need',
      k: 5,
      threshold: 0.9,
    });
    expect(firstAfterUpdate.results.map(result => result.publicationId)).toEqual([first.publicationId]);
    expect(secondAfterWithdrawal.results).toEqual([]);
    expect(store.getItem('private-local-first')?.status).toBe('published');
    expect(store.getItem('private-local-second')?.status).toBe('withdrawn');

    const journal = readFileSync(join(PERSIST_DIR, RELAY_OPERATION_LOG_FILENAME), 'utf8');
    expect(journal).not.toContain(identity.did);
    expect(journal).not.toContain('private-local-first');
    expect(journal).not.toContain('private-local-second');
    expect(journal).not.toContain('Private first offer');
    expect(journal).not.toContain('Private second offer');
    expect(client.isConnected()).toBe(false);
    store.close();
  });

  it('fetches, decrypts, persists, and independently acknowledges both match envelopes', async () => {
    const aliceIdentity = generateIdentity();
    const bobIdentity = generateIdentity();
    const aliceStore = await openStoreAsync(':memory:', nacl.randomBytes(nacl.secretbox.keyLength));
    const bobStore = await openStoreAsync(':memory:', nacl.randomBytes(nacl.secretbox.keyLength));
    const aliceKeys = generatePublicationKeyMaterial();
    const bobKeys = generatePublicationKeyMaterial();
    const now = Date.now();
    const aliceRecord = createPublicationRecord({
      groupId: 'mailbox-integration', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x42), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, aliceKeys);
    const bobRecord = createPublicationRecord({
      groupId: 'mailbox-integration', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x42), itemType: 'need',
      createdAt: now, expiresAt: now + 86_400_000,
    }, bobKeys);
    for (const [store, id, type, record, keys] of [
      [aliceStore, 'alice-item', 'offer', aliceRecord, aliceKeys],
      [bobStore, 'bob-item', 'need', bobRecord, bobKeys],
    ] as const) {
      store.insertItem({
        id, type, rawText: id, embedding: new Float32Array([1, 0]), privacyLevel: 'medium',
      });
      store.insertPublication(id, record, keys);
    }

    const aliceClient = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity: aliceIdentity });
    const bobClient = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity: bobIdentity });
    await aliceClient.submitPublicationOperation(aliceRecord);
    await bobClient.submitPublicationOperation(bobRecord);
    expect(server.getStats().mailbox_envelopes).toBe(2);

    const aliceInbox = await aliceClient.fetchMailbox(aliceRecord, aliceKeys);
    expect(aliceInbox.notices).toHaveLength(1);
    expect(aliceInbox.notices[0].payload.partnerPublicationId).toBe(bobRecord.publicationId);
    aliceStore.insertMailboxMatch('alice-item', aliceInbox.notices[0]);
    await aliceClient.acknowledgeMailbox(
      aliceRecord, aliceKeys, aliceInbox.envelopes.map((envelope) => envelope.envelopeId),
    );
    expect(server.getStats().mailbox_envelopes).toBe(1);

    const bobInbox = await bobClient.fetchMailbox(bobRecord, bobKeys);
    expect(bobInbox.notices).toHaveLength(1);
    expect(bobInbox.notices[0].payload.partnerPublicationId).toBe(aliceRecord.publicationId);
    bobStore.insertMailboxMatch('bob-item', bobInbox.notices[0]);
    await bobClient.acknowledgeMailbox(
      bobRecord, bobKeys, bobInbox.envelopes.map((envelope) => envelope.envelopeId),
    );
    expect(server.getStats().mailbox_envelopes).toBe(0);
    expect((await aliceClient.fetchMailbox(aliceRecord, aliceKeys)).notices).toEqual([]);
    expect(aliceStore.listMailboxMatches()).toHaveLength(1);
    expect(bobStore.listMailboxMatches()).toHaveLength(1);

    aliceStore.close();
    bobStore.close();
  });

  it('establishes the same durable pairwise channel through encrypted mailboxes', async () => {
    const aliceIdentity = generateIdentity();
    const bobIdentity = generateIdentity();
    const aliceStoreKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const bobStoreKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const aliceDb = `/tmp/resonance-alice-channel-${Date.now()}.db`;
    const bobDb = `/tmp/resonance-bob-channel-${Date.now()}.db`;
    let aliceStore = await openStoreAsync(aliceDb, aliceStoreKey);
    const bobStore = await openStoreAsync(bobDb, bobStoreKey);
    const aliceKeys = generatePublicationKeyMaterial();
    const bobKeys = generatePublicationKeyMaterial();
    const now = Date.now();
    const groupId = `channel-integration-${now}`;
    const aliceRecord = createPublicationRecord({
      groupId, fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x33), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, aliceKeys);
    const bobRecord = createPublicationRecord({
      groupId, fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x33), itemType: 'need',
      createdAt: now, expiresAt: now + 86_400_000,
    }, bobKeys);
    for (const [store, id, type, record, keys] of [
      [aliceStore, 'alice-channel-item', 'offer', aliceRecord, aliceKeys],
      [bobStore, 'bob-channel-item', 'need', bobRecord, bobKeys],
    ] as const) {
      store.insertItem({
        id, type, rawText: id, embedding: new Float32Array([1, 0]), privacyLevel: 'medium',
      });
      store.insertPublication(id, record, keys);
    }

    const aliceClient = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity: aliceIdentity });
    const bobClient = createRelayClient({ relayUrl: `ws://localhost:${PORT}`, identity: bobIdentity });
    await aliceClient.submitPublicationOperation(aliceRecord);
    await bobClient.submitPublicationOperation(bobRecord);

    const discovery = await aliceClient.searchV2({
      groupId,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x33),
      itemType: 'offer',
      k: 5,
      threshold: 0.9,
    });
    expect(discovery.results).toContainEqual({
      publicationId: bobRecord.publicationId,
      similarity: 1,
      itemType: 'need',
    });

    let aliceChannels = createPairwiseChannelManagerV2(aliceStore, aliceClient);
    const bobChannels = createPairwiseChannelManagerV2(bobStore, bobClient);
    await aliceChannels.syncMailboxes();
    await bobChannels.syncMailboxes();
    const matchId = aliceStore.listMailboxMatches()[0].matchId;

    const offered = await aliceChannels.initiate(matchId);
    expect(offered.status).toBe('offer-sent');
    expect(aliceClient.isConnected()).toBe(false);

    // The relationship identity and offer survive a process/store restart.
    const relationshipId = offered.localKeys.relationshipId;
    aliceStore.close();
    aliceStore = await openStoreAsync(aliceDb, aliceStoreKey);
    aliceChannels = createPairwiseChannelManagerV2(aliceStore, aliceClient);
    expect(aliceChannels.getByMatchId(matchId)?.localKeys.relationshipId).toBe(relationshipId);

    const bobSync = await bobChannels.syncMailboxes();
    expect(bobSync.channelsActivated).toBe(1);
    const aliceSync = await aliceChannels.syncMailboxes();
    expect(aliceSync.channelsActivated).toBe(1);

    const aliceChannel = aliceChannels.getByMatchId(matchId)!;
    const bobChannel = bobChannels.getByMatchId(matchId)!;
    expect(aliceChannel.status).toBe('active');
    expect(bobChannel.status).toBe('active');
    expect(aliceChannel.channelId).toBe(bobChannel.channelId);
    expect(Array.from(aliceChannel.sharedKey!)).toEqual(Array.from(bobChannel.sharedKey!));
    expect(aliceChannel.localKeys.relationshipId).not.toBe(bobChannel.localKeys.relationshipId);
    expect(aliceChannel.localKeys.relationshipId).not.toContain(aliceIdentity.did);
    expect(bobChannel.localKeys.relationshipId).not.toContain(bobIdentity.did);
    expect(new Set([
      aliceRecord.publicationId,
      aliceRecord.mailbox.id,
      bobRecord.publicationId,
      bobRecord.mailbox.id,
      discovery.searchId,
      aliceChannel.localKeys.relationshipId,
      aliceChannel.localKeys.mailboxId,
      bobChannel.localKeys.relationshipId,
      bobChannel.localKeys.mailboxId,
      aliceChannel.channelId!,
    ]).size).toBe(10);
    expect(JSON.stringify({ aliceRecord, bobRecord, discovery })).not.toContain(aliceIdentity.did);
    expect(JSON.stringify({ aliceRecord, bobRecord, discovery })).not.toContain(bobIdentity.did);
    expect(aliceClient.isConnected()).toBe(false);
    expect(bobClient.isConnected()).toBe(false);
    expect(server.getStats().mailbox_envelopes).toBe(0);

    const offlineAlice = createPairwiseChannelManagerV2(aliceStore, {
      ...aliceClient,
      async depositRelationshipMailboxEnvelope() {
        throw new Error('simulated network failure after local commit');
      },
    });
    await expect(offlineAlice.sendDisclosure(
      aliceChannel.channelId!,
      'I can bring the repair tools on Saturday.',
      'specific',
    )).rejects.toThrow('simulated network failure');
    expect(offlineAlice.getByMatchId(matchId)?.pendingOutbound?.kind).toBe('channel-message');
    expect(offlineAlice.listMessages(aliceChannel.channelId!)).toHaveLength(1);
    expect(server.getStats().mailbox_envelopes).toBe(0);

    // A restart retains the exact pending operation and retries it idempotently.
    aliceStore.close();
    aliceStore = await openStoreAsync(aliceDb, aliceStoreKey);
    aliceChannels = createPairwiseChannelManagerV2(aliceStore, aliceClient);
    expect(aliceChannels.getByMatchId(matchId)?.pendingOutbound?.kind).toBe('channel-message');
    expect(aliceChannels.listMessages(aliceChannel.channelId!)[0].direction).toBe('sent');
    await aliceChannels.syncMailboxes();
    expect(aliceChannels.getByMatchId(matchId)?.pendingOutbound).toBeNull();
    expect(server.getStats().mailbox_envelopes).toBe(1);
    const bobMessageSync = await bobChannels.syncMailboxes();
    expect(bobMessageSync.channelOperationsProcessed).toBe(1);
    expect(bobChannels.listMessages(bobChannel.channelId!)).toEqual([
      expect.objectContaining({
        direction: 'received',
        sequence: 0,
        kind: 'disclosure',
        content: expect.objectContaining({
          text: 'I can bring the repair tools on Saturday.',
          level: 'specific',
        }),
      }),
    ]);
    expect(server.getStats().mailbox_envelopes).toBe(0);

    const closedByBob = await bobChannels.close(bobChannel.channelId!);
    expect(closedByBob.status).toBe('closed');
    expect(server.getStats().mailbox_envelopes).toBe(1);
    const aliceCloseSync = await aliceChannels.syncMailboxes();
    expect(aliceCloseSync.channelOperationsProcessed).toBe(1);
    expect(aliceChannels.getByMatchId(matchId)?.status).toBe('closed');
    expect(aliceChannels.listMessages(aliceChannel.channelId!)).toEqual([
      expect.objectContaining({ direction: 'sent', sequence: 0, kind: 'disclosure' }),
      expect.objectContaining({ direction: 'received', sequence: 0, kind: 'close' }),
    ]);
    expect(aliceClient.isConnected()).toBe(false);
    expect(bobClient.isConnected()).toBe(false);
    expect(server.getStats().mailbox_envelopes).toBe(0);

    aliceStore.close();
    bobStore.close();
  }, 15_000);

  it('rejects consent deposits between publications that did not match', async () => {
    const senderKeys = generatePublicationKeyMaterial();
    const recipientKeys = generatePublicationKeyMaterial();
    const now = Date.now();
    const groupId = `unauthorized-channel-${now}`;
    const sender = createPublicationRecord({
      groupId, fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x00), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, senderKeys);
    const recipient = createPublicationRecord({
      groupId, fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xff), itemType: 'need',
      createdAt: now, expiresAt: now + 86_400_000,
    }, recipientKeys);
    const client = createRelayClient({
      relayUrl: `ws://localhost:${PORT}`,
      identity: generateIdentity(),
    });
    await client.submitPublicationOperation(sender);
    await client.submitPublicationOperation(recipient);

    const matchId = createDeterministicMatchId(sender.publicationId, recipient.publicationId);
    const offer = createConsentOfferV2(
      matchId,
      sender,
      recipient,
      senderKeys,
      generateRelationshipKeyMaterial(),
      now + 1,
      now + 60_000,
    );
    const envelope = encryptRelationshipMessage(offer, recipient);

    await expect(client.depositMailboxEnvelope(
      matchId,
      sender,
      recipient,
      senderKeys,
      envelope,
    )).rejects.toThrow('match_not_authorized');
    expect(client.isConnected()).toBe(false);
  });
});
