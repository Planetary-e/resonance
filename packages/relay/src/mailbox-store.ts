/** Relay-side opaque storage for encrypted protocol v2 mailbox envelopes. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  verifyMailboxEnvelope,
  type EncryptedMailboxEnvelope,
} from '@resonance/core';

const STORE_FILENAME = 'mailboxes.json';

export class MailboxStore {
  private mailboxes = new Map<string, Map<string, EncryptedMailboxEnvelope>>();

  hasEnvelope(mailboxId: string, envelopeId: string): boolean {
    return this.mailboxes.get(mailboxId)?.has(envelopeId) ?? false;
  }

  presentEnvelopeIds(mailboxId: string, envelopeIds: readonly string[]): string[] {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) return [];
    return envelopeIds.filter(id => mailbox.has(id));
  }

  enqueue(envelope: EncryptedMailboxEnvelope): 'accepted' | 'duplicate' {
    if (!verifyMailboxEnvelope(envelope)) throw new Error('Invalid mailbox envelope');
    let mailbox = this.mailboxes.get(envelope.mailboxId);
    if (!mailbox) {
      mailbox = new Map();
      this.mailboxes.set(envelope.mailboxId, mailbox);
    }
    if (mailbox.has(envelope.envelopeId)) return 'duplicate';
    mailbox.set(envelope.envelopeId, envelope);
    return 'accepted';
  }

  fetch(mailboxId: string, now = Date.now(), limit = 100): EncryptedMailboxEnvelope[] {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) return [];
    for (const [id, envelope] of mailbox) {
      if (envelope.expiresAt <= now) mailbox.delete(id);
    }
    if (mailbox.size === 0) this.mailboxes.delete(mailboxId);
    return Array.from(mailbox.values())
      .sort((a, b) => a.envelopeId.localeCompare(b.envelopeId))
      .slice(0, Math.max(0, Math.min(limit, 100)));
  }

  purgeExpired(now = Date.now()): number {
    let removed = 0;
    for (const [mailboxId, mailbox] of this.mailboxes) {
      for (const [id, envelope] of mailbox) {
        if (envelope.expiresAt <= now) {
          mailbox.delete(id);
          removed++;
        }
      }
      if (mailbox.size === 0) this.mailboxes.delete(mailboxId);
    }
    return removed;
  }

  acknowledge(mailboxId: string, envelopeIds: readonly string[]): number {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) return 0;
    let removed = 0;
    for (const id of envelopeIds) {
      if (mailbox.delete(id)) removed++;
    }
    if (mailbox.size === 0) this.mailboxes.delete(mailboxId);
    return removed;
  }

  get envelopeCount(): number {
    let count = 0;
    for (const mailbox of this.mailboxes.values()) count += mailbox.size;
    return count;
  }

  save(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const mailboxes = Array.from(this.mailboxes.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mailboxId, envelopes]) => ({
        mailboxId,
        envelopes: Array.from(envelopes.values()).sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)),
      }));
    writeFileSync(join(dir, STORE_FILENAME), JSON.stringify({ version: 1, mailboxes }));
  }

  load(dir: string): void {
    const path = join(dir, STORE_FILENAME);
    if (!existsSync(path)) return;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isStoredFile(parsed)) throw new Error('Invalid persisted mailbox store');

    const restored = new Map<string, Map<string, EncryptedMailboxEnvelope>>();
    for (const entry of parsed.mailboxes) {
      if (!isMailboxEntry(entry) || restored.has(entry.mailboxId)) {
        throw new Error('Invalid persisted mailbox');
      }
      const envelopes = new Map<string, EncryptedMailboxEnvelope>();
      for (const envelope of entry.envelopes) {
        if (!verifyMailboxEnvelope(envelope)
          || envelope.mailboxId !== entry.mailboxId
          || envelopes.has(envelope.envelopeId)) {
          throw new Error('Invalid persisted mailbox envelope');
        }
        envelopes.set(envelope.envelopeId, envelope);
      }
      restored.set(entry.mailboxId, envelopes);
    }
    this.mailboxes = restored;
  }
}

function isStoredFile(value: unknown): value is { version: 1; mailboxes: unknown[] } {
  return isObject(value)
    && value.version === 1
    && Array.isArray(value.mailboxes)
    && Object.keys(value).sort().join(',') === 'mailboxes,version';
}

function isMailboxEntry(value: unknown): value is { mailboxId: string; envelopes: unknown[] } {
  return isObject(value)
    && typeof value.mailboxId === 'string'
    && Array.isArray(value.envelopes)
    && Object.keys(value).sort().join(',') === 'envelopes,mailboxId';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
