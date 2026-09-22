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
  const latestReplicaAck = new Map<string, { index: number; expiresAt: number }>();
  records.forEach(({ entry }, index) => {
    if (entry.kind !== 'mailbox-replica-event' || entry.event.kind !== 'ack') return;
    const { mailboxId, envelopeId, expiresAt } = entry.event;
    const key = `${mailboxId}:${envelopeId}`;
    if (!acknowledged.has(key)) return;
    if (expiresAt > (latestReplicaAck.get(key)?.expiresAt ?? 0)) {
      latestReplicaAck.set(key, { index, expiresAt });
    }
  });
  return records.filter(({ entry }, index) => {
    if (entry.kind === 'mailbox-ack') {
      return entry.request.envelopeIds.some(id => acknowledged.has(`${entry.request.mailboxId}:${id}`));
    }
    if (entry.kind === 'mailbox-replica-event') {
      const event = entry.event;
      if (event.kind === 'ack') {
        const key = `${event.mailboxId}:${event.envelopeId}`;
        // One maximum-expiry event restores every extension on replay.
        return latestReplicaAck.get(key)?.index === index;
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
