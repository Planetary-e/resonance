import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nacl from 'tweetnacl';
import { openStoreAsync, type LocalStore } from '../store.js';

function randomKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

function randomEmbedding(dims = 768): Float32Array {
  const arr = new Float32Array(dims);
  for (let i = 0; i < dims; i++) arr[i] = Math.random() * 2 - 1;
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) arr[i] /= norm;
  return arr;
}

describe('LocalStore matches', () => {
  let store: LocalStore;
  let key: Uint8Array;

  beforeEach(async () => {
    key = randomKey();
    store = await openStoreAsync(':memory:', key);
    // Insert an item so foreign key works
    store.insertItem({ id: 'item-1', type: 'need', rawText: 'test', embedding: randomEmbedding(), privacyLevel: 'medium' });
  });

  afterEach(() => {
    store.close();
  });

  it('inserts and retrieves a match', () => {
    store.insertMatch({ id: 'match-1', itemId: 'item-1', partnerDID: 'did:key:z6MkBob', similarity: 0.73 });
    const match = store.getMatch('match-1');
    expect(match).not.toBeNull();
    expect(match!.id).toBe('match-1');
    expect(match!.itemId).toBe('item-1');
    expect(match!.partnerDID).toBe('did:key:z6MkBob');
    expect(match!.similarity).toBeCloseTo(0.73);
    expect(match!.status).toBe('pending');
  });

  it('lists matches with status filter', () => {
    store.insertMatch({ id: 'm1', itemId: 'item-1', partnerDID: 'did:a', similarity: 0.6 });
    store.insertMatch({ id: 'm2', itemId: 'item-1', partnerDID: 'did:b', similarity: 0.7 });
    store.updateMatchStatus('m2', 'consented');

    expect(store.listMatches()).toHaveLength(2);
    expect(store.listMatches({ status: 'pending' })).toHaveLength(1);
    expect(store.listMatches({ status: 'consented' })).toHaveLength(1);
  });

  it('updates match status', () => {
    store.insertMatch({ id: 'm1', itemId: 'item-1', partnerDID: 'did:a', similarity: 0.6 });
    store.updateMatchStatus('m1', 'confirmed');
    expect(store.getMatch('m1')!.status).toBe('confirmed');
  });

  it('returns null for nonexistent match', () => {
    expect(store.getMatch('nope')).toBeNull();
  });
});

describe('LocalStore channels', () => {
  let store: LocalStore;
  let key: Uint8Array;

  beforeEach(async () => {
    key = randomKey();
    store = await openStoreAsync(':memory:', key);
    store.insertItem({ id: 'item-1', type: 'need', rawText: 'test', embedding: randomEmbedding(), privacyLevel: 'medium' });
    store.insertMatch({ id: 'match-1', itemId: 'item-1', partnerDID: 'did:key:z6MkBob', similarity: 0.73 });
  });

  afterEach(() => {
    store.close();
  });

  it('inserts and retrieves a channel', () => {
    store.insertChannel({ id: 'ch-1', matchId: 'match-1', partnerDID: 'did:key:z6MkBob' });
    const ch = store.getChannel('ch-1');
    expect(ch).not.toBeNull();
    expect(ch!.matchId).toBe('match-1');
    expect(ch!.partnerDID).toBe('did:key:z6MkBob');
    expect(ch!.status).toBe('pending');
    expect(ch!.sharedKey).toBeNull();
  });

  it('stores and retrieves encrypted shared key', () => {
    const sharedKey = nacl.randomBytes(32);
    store.insertChannel({ id: 'ch-2', matchId: 'match-1', partnerDID: 'did:key:z6MkBob', sharedKey });
    const ch = store.getChannel('ch-2');
    expect(ch!.sharedKey).not.toBeNull();
    expect(Buffer.from(ch!.sharedKey!)).toEqual(Buffer.from(sharedKey));
  });

  it('gets channel by matchId', () => {
    store.insertChannel({ id: 'ch-3', matchId: 'match-1', partnerDID: 'did:key:z6MkBob' });
    const ch = store.getChannelByMatchId('match-1');
    expect(ch).not.toBeNull();
    expect(ch!.id).toBe('ch-3');
  });

  it('updates channel status', () => {
    store.insertChannel({ id: 'ch-4', matchId: 'match-1', partnerDID: 'did:key:z6MkBob' });
    store.updateChannelStatus('ch-4', 'active');
    expect(store.getChannel('ch-4')!.status).toBe('active');
  });

  it('updates channel shared key', () => {
    store.insertChannel({ id: 'ch-5', matchId: 'match-1', partnerDID: 'did:key:z6MkBob' });
    const newKey = nacl.randomBytes(32);
    store.updateChannelSharedKey('ch-5', newKey);
    const ch = store.getChannel('ch-5');
    expect(ch!.sharedKey).not.toBeNull();
    expect(Buffer.from(ch!.sharedKey!)).toEqual(Buffer.from(newKey));
  });

  it('returns null for nonexistent channel', () => {
    expect(store.getChannel('nope')).toBeNull();
    expect(store.getChannelByMatchId('nope')).toBeNull();
  });
});
