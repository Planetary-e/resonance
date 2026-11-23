import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  type AdmissionCapabilityV2,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { OfflineRequestStore } from '@resonance/node';
import { MailboxState } from '../client-held-mailbox-rotation.js';
import { fixedIndex } from '../../../node/src/__tests__/fixtures/client-held-process-harness.js';

const admission: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'live-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};
const directories: string[] = [];
const stores: OfflineRequestStore[] = [];
const mailboxes: MailboxState[] = [];

function open(root: string, name: string): OfflineRequestStore {
  const store = OfflineRequestStore.open({ path: join(root, name), encryptionKey: randomBytes(32) });
  stores.push(store);
  return store;
}

function complete(
  store: OfflineRequestStore,
  index: LeasedIndexV1,
  keys: LeasedIndexKeyMaterialV1,
  relayId: string,
  nonce: number,
): void {
  const value = store.createDeposit({
    index,
    requestNonce: new Uint8Array(16).fill(nonce),
    payload: 'outbox rotation control',
    replyCapability: 'reply-capability',
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    admission,
    selectedRelayIds: [relayId],
  });
  const received = store.receive(value.depositBytes, Date.now());
  store.recordGenerationAck(value.requestId, received.ackBytes);
  store.markAcknowledged(received.ackBytes);
}

afterEach(() => {
  for (const mailbox of mailboxes.splice(0)) mailbox.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('client-held outbox retention and harness rotation', () => {
  it('confirms acknowledged entries remain retained and entry 65 respects the production cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'resonance-outbox-cap-'));
    directories.push(root);
    const store = open(root, 'store.json');
    const keys = generateLeasedIndexKeyMaterialV1();
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + 86_400_000);
    store.retainGeneration(index, keys);
    const relayId = generateIdentity().did;
    for (let nonce = 1; nonce <= 64; nonce++) complete(store, index, keys, relayId, nonce);
    expect(store.listOutbox()).toHaveLength(64);
    expect(store.listOutbox().every(entry => entry.state === 'acknowledged')).toBe(true);
    expect(() => complete(store, index, keys, relayId, 65)).toThrow('Offline request outbox is full');
    expect(store.listOutbox()).toHaveLength(64);
  });

  it('rotates before the cap using actual outbox cardinality across 65 acknowledged operations', () => {
    const root = mkdtempSync(join(tmpdir(), 'resonance-outbox-rotation-'));
    directories.push(root);
    const mailbox = new MailboxState(root, 0);
    mailboxes.push(mailbox);
    const keys = generateLeasedIndexKeyMaterialV1();
    const index = fixedIndex(keys, Date.now() - 1_000, Date.now() + 86_400_000);
    const relayId = generateIdentity().did;
    for (let nonce = 1; nonce <= 65; nonce++) {
      const store = mailbox.current();
      store.retainGeneration(index, keys);
      complete(store, index, keys, relayId, nonce);
    }
    expect(mailbox.generation).toBe(2);
    expect(mailbox.current().listOutbox()).toHaveLength(17);
    expect(mailbox.current().listOutbox().every(entry => entry.state === 'acknowledged')).toBe(true);
  });
});
