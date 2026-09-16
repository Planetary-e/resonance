/** Fsynced append-only authority for relay protocol state. */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  verifyMailboxEnvelope,
  verifyMailboxDepositRequest,
  verifyMailboxRequest,
  verifyMatchOperationV2,
  verifyPublicationOperation,
  verifyRelationshipMailboxDepositV2,
  verifyRelationshipMailboxRequestV2,
  type EncryptedMailboxEnvelope,
  type MailboxDepositRequest,
  type MailboxRequest,
  type MatchOperationV2,
  type PublicationOperation,
  type RelationshipMailboxDepositV2,
  type RelationshipMailboxRequestV2,
} from '@resonance/core';

export const RELAY_OPERATION_LOG_FILENAME = 'relay-operations.ndjson';

export type RelayOperationLogEntry =
  | { kind: 'publication'; operation: PublicationOperation }
  | { kind: 'match'; operation: MatchOperationV2; envelopes: [EncryptedMailboxEnvelope, EncryptedMailboxEnvelope] }
  | { kind: 'mailbox-deposit'; request: MailboxDepositRequest | RelationshipMailboxDepositV2 }
  | { kind: 'mailbox-ack'; request: MailboxRequest | RelationshipMailboxRequestV2 };

export interface RelayOperationLogRecord {
  version: 1;
  sequence: number;
  committedAt: number;
  entry: RelayOperationLogEntry;
  recordId: string;
}

export class RelayOperationLog {
  private readonly directory: string;
  private readonly path: string;
  private records: RelayOperationLogRecord[] = [];
  private failed = false;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.path = join(directory, RELAY_OPERATION_LOG_FILENAME);
  }

  load(): readonly RelayOperationLogRecord[] {
    this.failed = false;
    if (!existsSync(this.path)) {
      this.records = [];
      return this.records;
    }
    const data = readFileSync(this.path);
    if (data.length === 0) {
      this.records = [];
      return this.records;
    }

    const lastNewline = data.lastIndexOf(0x0a);
    const completeLength = lastNewline + 1;
    if (completeLength !== data.length) truncateSync(this.path, completeLength);
    if (completeLength === 0) {
      this.records = [];
      return this.records;
    }

    const lines = data.subarray(0, completeLength).toString('utf8').split('\n');
    lines.pop();
    const restored: RelayOperationLogRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        throw new Error(`Corrupt relay operation log at sequence ${index + 1}`);
      }
      if (!isLogRecord(parsed) || parsed.sequence !== index + 1) {
        throw new Error(`Invalid relay operation log at sequence ${index + 1}`);
      }
      restored.push(parsed);
    }
    this.records = restored;
    return this.records;
  }

  append(entry: RelayOperationLogEntry, committedAt = Date.now()): RelayOperationLogRecord {
    if (this.failed) throw new Error('Relay operation log requires restart after an append failure');
    if (!isLogEntry(entry) || !isTimestamp(committedAt)) throw new Error('Invalid relay operation log entry');
    const base = {
      version: 1 as const,
      sequence: this.records.length + 1,
      committedAt,
      entry,
    };
    const record: RelayOperationLogRecord = { ...base, recordId: recordId(base) };
    const existed = existsSync(this.path);
    const descriptor = openSync(this.path, 'a', 0o600);
    try {
      appendFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fsyncSync(descriptor);
      if (!existed) {
        const directoryDescriptor = openSync(this.directory, 'r');
        try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      }
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      closeSync(descriptor);
    }
    this.records.push(record);
    return record;
  }

  get entries(): readonly RelayOperationLogRecord[] {
    return this.records;
  }

  get length(): number {
    return this.records.length;
  }
}

function isLogRecord(value: unknown): value is RelayOperationLogRecord {
  if (!isObject(value) || !hasOnlyKeys(value, ['committedAt', 'entry', 'recordId', 'sequence', 'version'])) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return false;
  if (!isTimestamp(value.committedAt) || !isOpaqueId(value.recordId, 'jrn') || !isLogEntry(value.entry)) return false;
  const { recordId: expected, ...base } = value;
  return expected === recordId(base);
}

function isLogEntry(value: unknown): value is RelayOperationLogEntry {
  if (!isObject(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'publication') {
    return hasOnlyKeys(value, ['kind', 'operation']) && verifyPublicationOperation(value.operation);
  }
  if (value.kind === 'match') {
    if (!hasOnlyKeys(value, ['envelopes', 'kind', 'operation']) || !verifyMatchOperationV2(value.operation)) return false;
    if (!Array.isArray(value.envelopes) || value.envelopes.length !== 2
      || !value.envelopes.every(verifyMailboxEnvelope)) return false;
    return value.envelopes.every(envelope => envelope.payloadType === 'match-notice')
      && value.envelopes[0].mailboxId !== value.envelopes[1].mailboxId
      && value.envelopes[0].envelopeId !== value.envelopes[1].envelopeId;
  }
  if (value.kind === 'mailbox-deposit') {
    return hasOnlyKeys(value, ['kind', 'request'])
      && (verifyMailboxDepositRequest(value.request)
        || verifyRelationshipMailboxDepositV2(value.request));
  }
  if (value.kind === 'mailbox-ack') {
    return hasOnlyKeys(value, ['kind', 'request'])
      && ((verifyMailboxRequest(value.request) && value.request.action === 'ack')
        || (verifyRelationshipMailboxRequestV2(value.request) && value.request.action === 'ack'));
  }
  return false;
}

function recordId(value: object): string {
  const digest = createHash('sha256').update(canonicalize(value)).digest('base64url');
  return `jrn_${digest}`;
}

function isOpaqueId(value: unknown, prefix: 'jrn'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}
