import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createOfflineDiscoveryReceiptV1,
  createOriginalCommitmentV1,
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  parseOfflineDiscoveryDepositV1,
  type AdmissionCapabilityV2,
  type LeasedIndexV1,
} from '@resonance/core';
import { MailboxGenerationStore } from '@resonance/relay';
import { OfflineRequestStore } from '../offline-request-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const openStores: OfflineRequestStore[] = [];
const ADMISSION: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'fixed-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-offline-request-'));
  directories.push(directory);
  const keys = generateLeasedIndexKeyMaterialV1();
  const commitment = createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1());
  const makeIndex = (leaseSequence: number) => createLeasedIndexV1({
    leaseSequence,
    semanticRevision: 0,
    groupId: 'public',
    itemType: 'need',
    derivationId: 'fixed-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(1),
    originalCommitment: commitment,
    createdAt: NOW + leaseSequence * 1_000,
    expiresAt: NOW + 7 * DAY + leaseSequence * 1_000,
  }, keys);
  const indexes = [makeIndex(0), makeIndex(1), makeIndex(2)];
  const historical = new Map(indexes.map(index => [createLeasedIndexGenerationIdV1(index), index]));
  let current = indexes[0];
  const relayIdentity = generateIdentity();
  const relay = new MailboxGenerationStore({
    directory: join(directory, 'relay'),
    relayIdentity,
    currentIndex: () => current,
    indexForGeneration: id => historical.get(id),
    verifyAdmission: () => true,
  });
  let now = NOW;
  const senderKey = randomBytes(32);
  const recipientKey = randomBytes(32);
  const sender = open(OfflineRequestStore.open({
    path: join(directory, 'sender.json'),
    encryptionKey: senderKey,
    now: () => now,
  }));
  const recipient = open(OfflineRequestStore.open({
    path: join(directory, 'recipient.json'),
    encryptionKey: recipientKey,
    now: () => now,
  }));
  for (const index of indexes) recipient.retainGeneration(index, keys);
  const selectedRelays = [relayIdentity, generateIdentity(), generateIdentity()];
  return {
    directory,
    senderKey,
    recipientKey,
    keys,
    indexes,
    relay,
    relayIdentity,
    sender,
    recipient,
    selectedRelays,
    setCurrent(index: LeasedIndexV1) { current = index; },
    setNow(value: number) { now = value; },
    now: () => now,
  };
}

function open<T extends OfflineRequestStore>(store: T): T {
  openStores.push(store);
  return store;
}

function create(fixtureValue: ReturnType<typeof fixture>, index = 0) {
  return fixtureValue.sender.createDeposit({
    index: fixtureValue.indexes[index],
    requestNonce: new Uint8Array(16).fill(11),
    payload: 'private fixed request',
    replyCapability: 'reply-capability',
    createdAt: NOW,
    expiresAt: NOW + DAY,
    admission: ADMISSION,
    selectedRelayIds: fixtureValue.selectedRelays.map(identity => identity.did),
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('encrypted offline outbox durability', () => {
  it('persists exact encrypted deposit/admission and reopens an interrupted send as unknown', () => {
    const env = fixture();
    const created = create(env);
    const before = env.sender.retry(created.requestId, created.generationId);
    expect(before.depositBytes).toBe(created.depositBytes);
    expect(readFileSync(join(env.directory, 'sender.json'), 'utf8')).not.toContain('private fixed request');

    env.sender.beginSend(created.requestId, created.generationId);
    env.sender.close();
    const reopened = open(OfflineRequestStore.open({
      path: join(env.directory, 'sender.json'),
      encryptionKey: env.senderKey,
      now: env.now,
    }));
    expect(reopened.listOutbox()[0].state).toBe('outcome-unknown');
    const retried = reopened.retry(created.requestId, created.generationId);
    expect(retried.depositBytes).toBe(before.depositBytes);
    expect(retried.admission).toEqual(before.admission);
    expect(retried.transportId).not.toBe(before.transportId);
  });
});

describe('stored and queued receipt evidence', () => {
  it('requires three distinct selected signed receipts for queued', () => {
    const env = fixture();
    const created = create(env);
    const deposit = env.relay.deposit(created.depositBytes, ADMISSION, NOW);
    expect(deposit.status).toBe('stored');
    expect(env.sender.recordReceipt(created.requestId, deposit.receipt!)).toBe('stored');

    for (const identity of env.selectedRelays.slice(0, 2)) {
      const receipt = createOfflineDiscoveryReceiptV1(
        parseDeposit(created.depositBytes),
        'stored',
        identity,
        NOW + 1,
      );
      expect(env.sender.recordReceipt(created.requestId, receipt)).toBe('stored');
    }
    const third = createOfflineDiscoveryReceiptV1(
      parseDeposit(created.depositBytes),
      'stored',
      env.selectedRelays[2],
      NOW + 1,
    );
    expect(env.sender.recordReceipt(created.requestId, third)).toBe('queued');
    expect(env.sender.listOutbox()[0].state).toBe('queued');
  });

  it('keeps outcome-unknown without evidence and validates receipt bindings', () => {
    const env = fixture();
    const created = create(env);
    env.sender.beginSend(created.requestId, created.generationId);
    env.sender.markOutcomeUnknown(created.requestId);
    expect(env.sender.listOutbox()[0].state).toBe('outcome-unknown');
    const receipt = createOfflineDiscoveryReceiptV1(
      parseDeposit(created.depositBytes),
      'stored',
      generateIdentity(),
      NOW + 1,
    );
    expect(() => env.sender.recordReceipt(created.requestId, receipt)).toThrow('not selected');
    expect(env.sender.listOutbox()[0].state).toBe('outcome-unknown');
  });
});

describe('recipient dedup and generation drain', () => {
  it('commits one inbox item across generations and ACKs each exact generation', () => {
    const env = fixture();
    const first = create(env);
    expect(env.relay.deposit(first.depositBytes, ADMISSION, NOW).status).toBe('stored');
    env.setCurrent(env.indexes[1]);
    const second = env.sender.redeposit({
      requestId: first.requestId,
      index: env.indexes[1],
      admission: ADMISSION,
    });
    expect(second.requestId).toBe(first.requestId);
    expect(env.relay.deposit(second.depositBytes, ADMISSION, NOW + 1_000).status).toBe('stored');

    const firstReceived = env.recipient.receive(first.depositBytes, NOW + 1_000);
    const secondReceived = env.recipient.receive(second.depositBytes, NOW + 1_000);
    expect(firstReceived.status).toBe('committed');
    expect(secondReceived.status).toBe('duplicate');
    expect(env.recipient.listInbox()).toHaveLength(1);
    expect(firstReceived.ackBytes).not.toBe(secondReceived.ackBytes);
    expect(env.recipient.receive(second.depositBytes, NOW + 1_000).ackBytes).toBe(secondReceived.ackBytes);
    expect(env.recipient.receiveMany([second.depositBytes, first.depositBytes], NOW + 1_000))
      .toHaveLength(2);
    expect(env.recipient.receiveMany([], NOW + 1_000)).toEqual([]);
    expect(env.recipient.listInbox()).toHaveLength(1);

    expect(env.relay.acknowledge(firstReceived.ackBytes, NOW + 1_000).status).toBe('acknowledged');
    expect(env.relay.fetch(env.indexes[0].mailbox.id, NOW + 1_000)).toEqual([second.depositBytes]);
    expect(env.relay.acknowledge(secondReceived.ackBytes, NOW + 1_000).status).toBe('acknowledged');
    expect(env.relay.fetch(env.indexes[0].mailbox.id, NOW + 1_000)).toEqual([]);
  });

  it('reopens an inbox commit without an ACK and retries deduplicated delivery', () => {
    const env = fixture();
    const created = create(env);
    env.relay.deposit(created.depositBytes, ADMISSION, NOW);
    const defaultRename = vi.mocked(renameSync).getMockImplementation()!;
    vi.mocked(renameSync)
      .mockImplementationOnce(defaultRename)
      .mockImplementationOnce(() => { throw new Error('injected ACK snapshot failure'); });

    expect(() => env.recipient.receive(created.depositBytes, NOW + 1)).toThrow('injected ACK snapshot failure');
    env.recipient.close();
    const reopened = open(OfflineRequestStore.open({
      path: join(env.directory, 'recipient.json'),
      encryptionKey: env.recipientKey,
      now: env.now,
    }));
    expect(reopened.listInbox()).toHaveLength(1);
    expect(reopened.pendingAcks()).toEqual([]);
    const redelivered = reopened.receive(created.depositBytes, NOW + 1);
    expect(redelivered.status).toBe('duplicate');
    expect(reopened.listInbox()).toHaveLength(1);
    expect(reopened.pendingAcks()).toEqual([redelivered.ackBytes]);
    expect(env.relay.acknowledge(redelivered.ackBytes, NOW + 1).status).toBe('acknowledged');
  });

  it('enforces two local generations and permits a third only after old ACK evidence', () => {
    const env = fixture();
    const first = create(env);
    env.relay.deposit(first.depositBytes, ADMISSION, NOW);
    env.setCurrent(env.indexes[1]);
    const second = env.sender.redeposit({ requestId: first.requestId, index: env.indexes[1], admission: ADMISSION });
    env.relay.deposit(second.depositBytes, ADMISSION, NOW + 1_000);
    env.setCurrent(env.indexes[2]);
    expect(() => env.sender.redeposit({
      requestId: first.requestId,
      index: env.indexes[2],
      admission: ADMISSION,
    })).toThrow('drain_required');

    const received = env.recipient.receive(first.depositBytes, NOW + 2_000);
    expect(env.relay.acknowledge(received.ackBytes, NOW + 2_000).status).toBe('acknowledged');
    env.sender.recordGenerationAck(first.requestId, received.ackBytes);
    const third = env.sender.redeposit({
      requestId: first.requestId,
      index: env.indexes[2],
      admission: ADMISSION,
    });
    expect(third.generationId).not.toBe(second.generationId);
    expect(env.relay.deposit(third.depositBytes, ADMISSION, NOW + 2_000).status).toBe('stored');
  });
});

describe('closed clients and immutable expiry', () => {
  it('performs no work after close and refuses new sends at request expiry', () => {
    vi.useFakeTimers();
    const env = fixture();
    const created = create(env);
    env.sender.close();
    expect(() => env.sender.retry(created.requestId)).toThrow('closed');
    expect(() => env.recipient.close()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    const other = fixture();
    const otherRequest = create(other);
    other.setNow(NOW + DAY);
    expect(() => other.sender.beginSend(otherRequest.requestId, otherRequest.generationId)).toThrow('expired');
    vi.useRealTimers();
  });
});

function parseDeposit(raw: string) {
  return parseOfflineDiscoveryDepositV1(raw);
}
