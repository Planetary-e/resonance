/** Relay-side opaque storage for encrypted protocol v2 mailbox envelopes. */

import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  verifyMailboxEnvelope,
  type EncryptedMailboxEnvelope,
} from '@resonance/core';

const STORE_FILENAME = 'mailboxes.json';

export class MailboxStore {
  private mailboxes = new Map<string, Map<string, EncryptedMailboxEnvelope>>();
  /** Prevent an acknowledged envelope from being delivered again on retry. */
  private acknowledged = new Map<string, Map<string, number>>();
  private retainedByteCount = 0;
  private activeEnvelopeCount = 0;

  hasEnvelope(mailboxId: string, envelopeId: string): boolean {
    return this.mailboxes.get(mailboxId)?.has(envelopeId) ?? false;
  }

  hasAcknowledgedEnvelope(mailboxId: string, envelopeId: string, now = Date.now()): boolean {
    return (this.acknowledged.get(mailboxId)?.get(envelopeId) ?? 0) > now;
  }

  acknowledgedEnvelopeIds(now = Date.now()): Set<string> {
    const result = new Set<string>();
    for (const [mailboxId, ids] of this.acknowledged) {
      for (const [envelopeId, expiresAt] of ids) {
        if (expiresAt > now) result.add(`${mailboxId}:${envelopeId}`);
      }
    }
    return result;
  }

  /** Retained envelope and acknowledgement bytes, excluding historical journal rows. */
  get retainedBytes(): number {
    return this.retainedByteCount;
  }

  canEnqueue(envelopes: readonly EncryptedMailboxEnvelope[], quotaBytes: number): boolean {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) return false;
    let additional = 0;
    const included = new Set<string>();
    for (const envelope of envelopes) {
      const key = `${envelope.mailboxId}:${envelope.envelopeId}`;
      if (included.has(key) || this.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
        || this.hasAcknowledgedEnvelope(envelope.mailboxId, envelope.envelopeId)) continue;
      included.add(key);
      additional += envelopeBytes(envelope);
    }
    return this.retainedBytes + additional <= quotaBytes;
  }

  presentEnvelopeIds(mailboxId: string, envelopeIds: readonly string[]): string[] {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) return [];
    return envelopeIds.filter(id => mailbox.has(id));
  }

  enqueue(envelope: EncryptedMailboxEnvelope): 'accepted' | 'duplicate' {
    if (!verifyMailboxEnvelope(envelope)) throw new Error('Invalid mailbox envelope');
    if (this.hasAcknowledgedEnvelope(envelope.mailboxId, envelope.envelopeId)) return 'duplicate';
    let mailbox = this.mailboxes.get(envelope.mailboxId);
    if (!mailbox) {
      mailbox = new Map();
      this.mailboxes.set(envelope.mailboxId, mailbox);
    }
    if (mailbox.has(envelope.envelopeId)) return 'duplicate';
    mailbox.set(envelope.envelopeId, envelope);
    this.retainedByteCount += envelopeBytes(envelope);
    this.activeEnvelopeCount++;
    return 'accepted';
  }

  fetch(mailboxId: string, now = Date.now(), limit = 100): EncryptedMailboxEnvelope[] {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) return [];
    return Array.from(mailbox.values())
      .filter(envelope => envelope.expiresAt > now)
      .sort((a, b) => a.envelopeId.localeCompare(b.envelopeId))
      .slice(0, Math.max(0, Math.min(limit, 100)));
  }

  purgeExpired(now = Date.now()): number {
    let removed = 0;
    for (const [mailboxId, mailbox] of this.mailboxes) {
      for (const [id, envelope] of mailbox) {
        if (envelope.expiresAt <= now) {
          mailbox.delete(id);
          this.retainedByteCount -= envelopeBytes(envelope);
          this.activeEnvelopeCount--;
          removed++;
        }
      }
      if (mailbox.size === 0) this.mailboxes.delete(mailboxId);
    }
    for (const [mailboxId, ids] of this.acknowledged) {
      for (const [id, expiresAt] of ids) {
        if (expiresAt <= now) {
          ids.delete(id);
          this.retainedByteCount -= acknowledgementBytes(mailboxId, id, expiresAt);
          removed++;
        }
      }
      if (ids.size === 0) this.acknowledged.delete(mailboxId);
    }
    return removed;
  }

  acknowledge(mailboxId: string, envelopeIds: readonly string[]): number {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) return 0;
    let removed = 0;
    for (const id of envelopeIds) {
      const envelope = mailbox.get(id);
      if (!envelope) continue;
      mailbox.delete(id);
      this.retainedByteCount -= envelopeBytes(envelope);
      this.activeEnvelopeCount--;
      removed++;
      if (envelope.expiresAt > Date.now()) {
        let acknowledgements = this.acknowledged.get(mailboxId);
        if (!acknowledgements) {
          acknowledgements = new Map();
          this.acknowledged.set(mailboxId, acknowledgements);
        }
        acknowledgements.set(id, envelope.expiresAt);
        this.retainedByteCount += acknowledgementBytes(mailboxId, id, envelope.expiresAt);
      }
    }
    if (mailbox.size === 0) this.mailboxes.delete(mailboxId);
    return removed;
  }

  get envelopeCount(): number {
    return this.activeEnvelopeCount;
  }

  save(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const mailboxes = Array.from(this.mailboxes.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mailboxId, envelopes]) => ({
        mailboxId,
        envelopes: Array.from(envelopes.values()).sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)),
      }));
    const acknowledged = Array.from(this.acknowledged.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([mailboxId, ids]) => Array.from(ids.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([envelopeId, expiresAt]) => ({ mailboxId, envelopeId, expiresAt })));
    writeFileSync(join(dir, STORE_FILENAME), JSON.stringify({ version: 2, mailboxes, acknowledged }));
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
    const acknowledged = new Map<string, Map<string, number>>();
    for (const entry of parsed.version === 2 ? parsed.acknowledged : []) {
      if (!isAcknowledgedEntry(entry) || restored.get(entry.mailboxId)?.has(entry.envelopeId)) {
        throw new Error('Invalid persisted mailbox acknowledgement');
      }
      let ids = acknowledged.get(entry.mailboxId);
      if (!ids) {
        ids = new Map();
        acknowledged.set(entry.mailboxId, ids);
      }
      if (ids.has(entry.envelopeId)) throw new Error('Duplicate persisted mailbox acknowledgement');
      ids.set(entry.envelopeId, entry.expiresAt);
    }
    this.mailboxes = restored;
    this.acknowledged = acknowledged;
    this.retainedByteCount = 0;
    this.activeEnvelopeCount = 0;
    for (const mailbox of restored.values()) {
      for (const envelope of mailbox.values()) {
        this.retainedByteCount += envelopeBytes(envelope);
        this.activeEnvelopeCount++;
      }
    }
    for (const [mailboxId, ids] of acknowledged) {
      for (const [envelopeId, expiresAt] of ids) {
        this.retainedByteCount += acknowledgementBytes(mailboxId, envelopeId, expiresAt);
      }
    }
  }
}

function envelopeBytes(envelope: EncryptedMailboxEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

function acknowledgementBytes(mailboxId: string, envelopeId: string, expiresAt: number): number {
  return Buffer.byteLength(JSON.stringify({ mailboxId, envelopeId, expiresAt }), 'utf8');
}

function isStoredFile(value: unknown): value is
  | { version: 1; mailboxes: unknown[] }
  | { version: 2; mailboxes: unknown[]; acknowledged: unknown[] } {
  return isObject(value)
    && Array.isArray(value.mailboxes)
    && ((value.version === 1 && Object.keys(value).sort().join(',') === 'mailboxes,version')
      || (value.version === 2 && Array.isArray(value.acknowledged)
        && Object.keys(value).sort().join(',') === 'acknowledged,mailboxes,version'));
}

function isAcknowledgedEntry(value: unknown): value is {
  mailboxId: string; envelopeId: string; expiresAt: number;
} {
  return isObject(value)
    && typeof value.mailboxId === 'string'
    && typeof value.envelopeId === 'string'
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) >= 0
    && Object.keys(value).sort().join(',') === 'envelopeId,expiresAt,mailboxId';
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
