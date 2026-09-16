import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import type { PublicationRecord } from '@resonance/core';
import { openStoreAsync, type LocalStore } from '../store.js';
import { upgradeLegacyItemsToV2 } from '../upgrade-v2.js';

function embedding(): Float32Array {
  const value = new Float32Array(768);
  value[0] = 0.8;
  value[1] = 0.6;
  return value;
}

describe('v0.1 to v2 local-data upgrade', () => {
  let store: LocalStore;

  beforeEach(async () => {
    store = await openStoreAsync(':memory:', nacl.randomBytes(nacl.secretbox.keyLength));
  });

  afterEach(() => {
    store.close();
  });

  it('preserves active items under unrelated v2 identities and skips withdrawn items', async () => {
    for (const [id, type] of [['published-item', 'need'], ['local-item', 'offer'], ['withdrawn-item', 'need']] as const) {
      store.insertItem({
        id,
        type,
        rawText: `private text for ${id}`,
        embedding: embedding(),
        privacyLevel: 'medium',
      });
    }
    store.updateItemStatus('published-item', 'published');
    store.updateItemStatus('withdrawn-item', 'withdrawn');

    const report = await upgradeLegacyItemsToV2(store, { now: 1_700_000_000_000 });

    expect(report).toMatchObject({
      discovered: 3,
      created: 2,
      published: 0,
      pending: 2,
      alreadyV2: 0,
      withdrawnSkipped: 1,
      errors: [],
    });

    const formerlyPublished = store.getPublicationForItem('published-item');
    const formerlyLocal = store.getPublicationForItem('local-item');
    expect(formerlyPublished).not.toBeNull();
    expect(formerlyLocal).not.toBeNull();
    expect(store.getPublicationForItem('withdrawn-item')).toBeNull();
    expect(formerlyPublished!.publicationId).not.toBe(formerlyLocal!.publicationId);
    expect(formerlyPublished!.record.mailbox.id).not.toBe(formerlyLocal!.record.mailbox.id);
    expect(JSON.stringify(formerlyPublished!.record)).not.toContain('did:key');
    expect(store.getItem('published-item')!.status).toBe('local');
    expect(store.getItem('local-item')!.status).toBe('local');
    expect(store.getItem('withdrawn-item')!.status).toBe('withdrawn');
    expect(store.getItem('published-item')!.rawText).toBe('private text for published-item');
  });

  it('reuses a pending record after relay failure and does not republish after acknowledgement', async () => {
    store.insertItem({
      id: 'retry-item',
      type: 'need',
      rawText: 'keep this local item',
      embedding: embedding(),
      privacyLevel: 'high',
    });
    store.updateItemStatus('retry-item', 'published');

    const rejected = vi.fn(async (_record: PublicationRecord) => ({ status: 'error' as const, message: 'offline' }));
    const first = await upgradeLegacyItemsToV2(store, {
      now: 1_700_000_000_000,
      submit: rejected,
    });
    const publicationId = store.getPublicationForItem('retry-item')!.publicationId;

    expect(first).toMatchObject({ created: 1, published: 0, pending: 1 });
    expect(first.errors).toHaveLength(1);
    expect(store.getItem('retry-item')!.status).toBe('local');

    const accepted = vi.fn(async (_record: PublicationRecord) => ({ status: 'ok' as const }));
    const second = await upgradeLegacyItemsToV2(store, {
      now: 1_700_000_100_000,
      submit: accepted,
    });

    expect(second).toMatchObject({ created: 0, alreadyV2: 1, published: 1, pending: 0, errors: [] });
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted.mock.calls[0][0].publicationId).toBe(publicationId);
    expect(store.getPublicationForItem('retry-item')!.publicationId).toBe(publicationId);
    expect(store.getItem('retry-item')!.status).toBe('published');

    const shouldNotSubmit = vi.fn(async (_record: PublicationRecord) => ({ status: 'ok' as const }));
    const third = await upgradeLegacyItemsToV2(store, { submit: shouldNotSubmit });
    expect(third).toMatchObject({ created: 0, alreadyV2: 1, published: 0, pending: 0, errors: [] });
    expect(shouldNotSubmit).not.toHaveBeenCalled();
  });
});
