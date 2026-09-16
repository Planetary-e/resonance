/** In-place semantic upgrade from v0.1 items to scoped v2 publications. */

import {
  createPublicationRecord,
  generatePublicationKeyMaterial,
  getSharedProjectionMatrix,
  hashEmbedding,
  type PublicationRecord,
} from '@resonance/core';
import type { LocalStore } from './store.js';

export interface UpgradeV2Options {
  groupId?: string;
  fingerprintEpoch?: string;
  now?: number;
  ttlMs?: number;
  submit?: (record: PublicationRecord) => Promise<{ status: 'ok' | 'error'; message?: string }>;
}

export interface UpgradeV2Report {
  discovered: number;
  created: number;
  published: number;
  pending: number;
  alreadyV2: number;
  withdrawnSkipped: number;
  errors: Array<{ itemId: string; message: string }>;
}

/**
 * Create one unrelated v2 publication per active legacy item. The operation is
 * rerunnable: existing v2 keys are reused, and locally pending records retry
 * the exact same signed publication rather than rotating identity.
 */
export async function upgradeLegacyItemsToV2(
  store: LocalStore,
  options: UpgradeV2Options = {},
): Promise<UpgradeV2Report> {
  const report: UpgradeV2Report = {
    discovered: 0,
    created: 0,
    published: 0,
    pending: 0,
    alreadyV2: 0,
    withdrawnSkipped: 0,
    errors: [],
  };
  const groupId = options.groupId ?? 'public';
  const fingerprintEpoch = options.fingerprintEpoch ?? 'pilot-static-v1';
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  if (
    !groupId
    || groupId.length > 128
    || !fingerprintEpoch
    || fingerprintEpoch.length > 128
    || !Number.isSafeInteger(now)
    || now < 0
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || !Number.isSafeInteger(now + ttlMs)
  ) {
    throw new Error('Invalid protocol v2 upgrade options');
  }

  for (const item of store.listItems()) {
    let publication = store.getPublicationForItem(item.id);
    if (!publication) {
      report.discovered += 1;
      if (item.status === 'withdrawn') {
        report.withdrawnSkipped += 1;
        continue;
      }
      try {
        const keys = generatePublicationKeyMaterial();
        try {
          const record = createPublicationRecord({
            groupId,
            fingerprintEpoch,
            fingerprint: hashEmbedding(item.embedding, getSharedProjectionMatrix()),
            itemType: item.type,
            createdAt: now,
            expiresAt: now + ttlMs,
          }, keys);
          store.insertPublication(item.id, record, keys);
        } finally {
          keys.signingKeyPair.secretKey.fill(0);
          keys.mailboxKeyPair.secretKey.fill(0);
        }
        publication = store.getPublicationForItem(item.id);
        if (!publication) throw new Error('Stored publication could not be reloaded');
        report.created += 1;
      } catch (error) {
        report.errors.push({ itemId: item.id, message: String(error) });
        continue;
      }
    } else {
      report.alreadyV2 += 1;
    }

    try {
      if (publication.tombstone) continue;
      const current = store.getItem(item.id);
      if (!current || current.status === 'published') continue;
      if (!options.submit) {
        report.pending += 1;
        continue;
      }
      try {
        const ack = await options.submit(publication.record);
        if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected publication');
        store.updateItemStatus(item.id, 'published');
        report.published += 1;
      } catch (error) {
        report.pending += 1;
        report.errors.push({ itemId: item.id, message: String(error) });
      }
    } finally {
      publication.keys.signingKeyPair.secretKey.fill(0);
      publication.keys.mailboxKeyPair.secretKey.fill(0);
    }
  }

  return report;
}
