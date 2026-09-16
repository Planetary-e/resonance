import { describe, expect, it } from 'vitest';
import {
  createMatchOperationV2,
  createPublicationRecord,
  generateIdentity,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import { MatchOperationStore } from '../match-operation-store.js';

const NOW = 1_800_000_000_000;

function pair() {
  const needKeys = generatePublicationKeyMaterial();
  const offerKeys = generatePublicationKeyMaterial();
  const input = {
    groupId: 'public',
    fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0xa5),
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  };
  return {
    needKeys,
    offerKeys,
    need: createPublicationRecord({ ...input, itemType: 'need' }, needKeys),
    offer: createPublicationRecord({ ...input, itemType: 'offer' }, offerKeys),
  };
}

describe('MatchOperationStore', () => {
  it('deduplicates operations and accepts independent relay attestations once', () => {
    const { need, offer } = pair();
    const first = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });
    const second = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });
    const store = new MatchOperationStore();

    expect(store.apply(first).status).toBe('accepted');
    expect(store.apply(first).status).toBe('duplicate');
    expect(store.apply(second).status).toBe('attestation');
    expect(store.size).toBe(1);
    expect(store.operationCount).toBe(2);
  });

  it('replaces a logical match only with newer signed publication revisions', () => {
    const { need, offer, needKeys } = pair();
    const first = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });
    const revisedNeed = createPublicationRecord({
      groupId: need.groupId,
      fingerprintEpoch: need.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0xa5),
      itemType: need.itemType,
      sequence: 1,
      createdAt: NOW,
      expiresAt: need.expiresAt,
    }, needKeys);
    const next = createMatchOperationV2(revisedNeed, offer, generateIdentity(), { createdAt: NOW + 2 });
    const store = new MatchOperationStore();

    expect(store.apply(first).status).toBe('accepted');
    expect(store.apply(next).status).toBe('accepted');
    expect(store.apply(first).status).toBe('duplicate');
    expect(store.get(first.matchId)?.publications.some(value => value.sequence === 1)).toBe(true);
  });

  it('rejects invalid operations without mutating state', () => {
    const { need, offer } = pair();
    const operation = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });
    expect(new MatchOperationStore().apply({ ...operation, similarity: 0.2 }).status).toBe('invalid');
  });
});
