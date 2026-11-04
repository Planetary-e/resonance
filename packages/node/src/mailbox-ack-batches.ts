import { MAX_FRESH_MAILBOX_ACK_IDS } from '@resonance/core';

/** Bound each signed maintenance proof to one envelope's prepaid journal space. */
export function mailboxAcknowledgementBatches(value: readonly string[]): string[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error('Invalid mailbox acknowledgement IDs');
  const ids = [...value];
  if (ids.some(id => typeof id !== 'string' || !/^env_[A-Za-z0-9_-]{43}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Invalid mailbox acknowledgement IDs');
  }
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += MAX_FRESH_MAILBOX_ACK_IDS) batches.push(ids.slice(start, start + MAX_FRESH_MAILBOX_ACK_IDS));
  return batches;
}
