/** Drop mailbox journal history that can no longer affect delivery or deduplication. */

import type { RelayOperationLogRecord } from './operation-log.js';
import type { MailboxStore } from './mailbox-store.js';
import type { EncryptedMailboxEnvelope } from '@resonance/core';

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
  const retained = new Set<number>();
  records.forEach(({ entry }, index) => {
    if (entry.kind === 'mailbox-ack') return;
    if (entry.kind === 'mailbox-replica-event') {
      const event = entry.event;
      if (event.kind === 'ack') return;
      const envelope = event.envelope;
      const key = `${envelope.mailboxId}:${envelope.envelopeId}`;
      if (retainedDeposits.has(key)
        || (!mailboxes.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
          && !acknowledged.has(key))) return;
      retainedDeposits.add(key);
      retained.add(index); return;
    }
    if (entry.kind !== 'mailbox-deposit') { retained.add(index); return; }
    const { envelope } = entry.request;
    const key = `${envelope.mailboxId}:${envelope.envelopeId}`;
    if (retainedDeposits.has(key)
      || (!mailboxes.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
        && !acknowledged.has(key))) return;
    retainedDeposits.add(key);
    retained.add(index);
  });

  // Startup enqueues even expired envelopes and purges after the whole replay.
  // Track possible presence after every retained introduction, even if a live
  // barrier blocks it today: that barrier may expire before a future restart.
  // Keep each possible early release, including expired match envelopes, so
  // replay need not retain their ciphertext until a later redundant ACK.
  const present = new Map<string, number>();
  const barriers = new Map<string, { expiresAt: number; index: number }>();
  const introduce = (envelope: EncryptedMailboxEnvelope) => {
    const key = `${envelope.mailboxId}:${envelope.envelopeId}`;
    const barrier = barriers.get(key);
    if (barrier) {
      // An unknown-ID replica ACK is necessary only when a later introduction
      // actually relies on it. Its complete original row stays at its position.
      retained.add(barrier.index);
    }
    if (!present.has(key)) present.set(key, envelope.expiresAt);
  };
  records.forEach(({ entry }, index) => {
    if (entry.kind === 'mailbox-ack') {
      for (const id of entry.request.envelopeIds) {
        const key = `${entry.request.mailboxId}:${id}`, expiresAt = present.get(key);
        if (expiresAt === undefined) continue;
        retained.add(index); present.delete(key);
        if (expiresAt > now && expiresAt > (barriers.get(key)?.expiresAt ?? 0)) barriers.set(key, { expiresAt, index });
      }
      return;
    }
    if (entry.kind === 'mailbox-replica-event' && entry.event.kind === 'ack') {
      const event = entry.event, key = `${event.mailboxId}:${event.envelopeId}`;
      const previous = barriers.get(key), envelopeExpiry = present.get(key);
      const needed = envelopeExpiry !== undefined || latestReplicaAck.get(key)?.index === index;
      if (needed) retained.add(index);
      const expiresAt = Math.max(event.expiresAt, envelopeExpiry ?? 0, previous?.expiresAt ?? 0);
      present.delete(key);
      // A later reopen can outlive an earlier, shorter barrier. Depend on the
      // strongest preceding proof, including its retained introduction/ACK
      // dependencies when the effective expiry came from an envelope.
      if (expiresAt > now) barriers.set(key, { expiresAt, index: !previous || expiresAt > previous.expiresAt ? index : previous.index });
      return;
    }
    if (!retained.has(index)) return;
    if (entry.kind === 'match') entry.envelopes.forEach(introduce);
    else if (entry.kind === 'mailbox-deposit') introduce(entry.request.envelope);
    else if (entry.kind === 'mailbox-replica-event' && entry.event.kind === 'envelope') introduce(entry.event.envelope);
  });
  return records.filter((_record, index) => retained.has(index));
}
