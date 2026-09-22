/** Drop mailbox journal history that can no longer affect delivery or deduplication. */

import type { RelayOperationLogRecord } from './operation-log.js';
import type { MailboxStore } from './mailbox-store.js';

export function compactMailboxHistory(
  records: readonly Pick<RelayOperationLogRecord, 'committedAt' | 'entry'>[],
  mailboxes: MailboxStore,
  now = Date.now(),
): Pick<RelayOperationLogRecord, 'committedAt' | 'entry'>[] {
  const acknowledged = mailboxes.acknowledgedEnvelopeIds(now);
  const retainedDeposits = new Set<string>();
  const retainedReplicaAcks = new Set<string>();
  return records.filter(({ entry }) => {
    if (entry.kind === 'mailbox-ack') {
      return entry.request.envelopeIds.some(id => acknowledged.has(`${entry.request.mailboxId}:${id}`));
    }
    if (entry.kind === 'mailbox-replica-event') {
      const event = entry.event;
      if (event.kind === 'ack') {
        const key = `${event.mailboxId}:${event.envelopeId}`;
        if (!acknowledged.has(key) || retainedReplicaAcks.has(key)) return false;
        retainedReplicaAcks.add(key);
        return true;
      }
      const envelope = event.envelope;
      const key = `${envelope.mailboxId}:${envelope.envelopeId}`;
      if (retainedDeposits.has(key)
        || (!mailboxes.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
          && !acknowledged.has(key))) return false;
      retainedDeposits.add(key);
      return true;
    }
    if (entry.kind !== 'mailbox-deposit') return true;
    const { envelope } = entry.request;
    const key = `${envelope.mailboxId}:${envelope.envelopeId}`;
    if (retainedDeposits.has(key)
      || (!mailboxes.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
        && !acknowledged.has(key))) return false;
    retainedDeposits.add(key);
    return true;
  });
}
