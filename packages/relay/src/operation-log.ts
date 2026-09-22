/** Fsynced append-only authority for relay protocol state. */

import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  verifyMailboxEnvelope,
  verifyMailboxDepositRequest,
  verifyMailboxRequest,
  verifyMatchOperationV2,
  verifyPublicationOperation,
  verifyRelationshipMailboxDepositV2,
  verifyRelationshipMailboxRequestV2,
  isDurabilityReceiptV1,
  isRelayReplicaReconciliationReceiptV1,
  didToPublicKey,
  publicKeyToDid,
  verifyRelayReplicaReconciliationResponseV1,
  type EncryptedMailboxEnvelope,
  type MailboxDepositRequest,
  type MailboxRequest,
  type MatchOperationV2,
  type PublicationOperation,
  type RelationshipMailboxDepositV2,
  type RelationshipMailboxRequestV2,
  type RelayReplicaReceiptV1,
  type RelayReplicaReconciliationResponseV1,
} from '@resonance/core';
import {
  verifyReplicaPlacementIntent,
  type ReplicaPlacementIntentV1,
} from './replica-placement.js';

export const RELAY_OPERATION_LOG_FILENAME = 'relay-operations.ndjson';

/**
 * The unmarked shapes are accepted only for journals written before durable
 * allocation provenance. New entries record whether the allocation was local,
 * a named inbound replica, or the conservative legacy bucket.
 */
export type RelayPublicationOperationLogEntry =
  | {
    kind: 'publication';
    operation: PublicationOperation;
    allocationOrigin?: undefined;
    allocationRelayId?: string;
  }
  | {
    kind: 'publication';
    operation: PublicationOperation;
    allocationOrigin: 'local' | 'replica';
    allocationRelayId: string;
  }
  | {
    kind: 'publication';
    operation: PublicationOperation;
    allocationOrigin: 'legacy';
    allocationRelayId?: never;
  };

/** Explicit allocation provenance for new journal event types. */
export type RelayPublicationStorageAllocationLog =
  | { allocationOrigin: 'local' | 'replica'; allocationRelayId: string }
  | { allocationOrigin: 'legacy' };

/**
 * A locally adopted remote state after a target proved a conflicting state
 * through its signed rejection and a read-only reconciliation response.
 */
export interface RelayReconciliationAdoptionLogEntry {
  kind: 'reconciliation-adoption';
  rejection: RelayReplicaReceiptV1;
  response: RelayReplicaReconciliationResponseV1;
  allocation: RelayPublicationStorageAllocationLog;
}

export type RelayOperationLogEntry =
  | RelayPublicationOperationLogEntry
  | { kind: 'match'; operation: MatchOperationV2; envelopes: [EncryptedMailboxEnvelope, EncryptedMailboxEnvelope] }
  /** A match whose delivery window ended; retains only its signed deduplication decision. */
  | { kind: 'match-checkpoint'; operation: MatchOperationV2 }
  | { kind: 'mailbox-deposit'; request: MailboxDepositRequest | RelationshipMailboxDepositV2 }
  | { kind: 'mailbox-ack'; request: MailboxRequest | RelationshipMailboxRequestV2 }
  | { kind: 'placement-intent'; intent: ReplicaPlacementIntentV1 }
  | { kind: 'placement-receipt'; receipt: RelayReplicaReceiptV1 }
  | RelayReconciliationAdoptionLogEntry;

export interface RelayOperationLogRecord {
  version: 1;
  sequence: number;
  committedAt: number;
  entry: RelayOperationLogEntry;
  recordId: string;
}

export class RelayJournalCapacityError extends Error {
  constructor() { super('Relay journal storage quota exhausted'); }
}

export class RelayOperationLog {
  private readonly directory: string;
  private readonly path: string;
  private records: RelayOperationLogRecord[] = [];
  private failed = false;
  private currentBytes = 0;

  constructor(
    directory: string,
    private readonly maxFileBytes = Number.POSITIVE_INFINITY,
    private readonly reservedBytesAfterAppend: (entry: RelayOperationLogEntry) => number = () => 0,
  ) {
    if ((maxFileBytes !== Number.POSITIVE_INFINITY
      && (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0))) {
      throw new Error('Invalid relay journal file quota');
    }
    mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.path = join(directory, RELAY_OPERATION_LOG_FILENAME);
  }

  load(): readonly RelayOperationLogRecord[] {
    this.failed = false;
    // A crash before rename leaves only an abandoned candidate; the primary
    // journal remains authoritative and the candidate must not consume the
    // volunteer's disk budget indefinitely.
    for (const name of readdirSync(this.directory)) {
      if (/^relay-operations\.ndjson\.compact-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) {
        rmSync(join(this.directory, name), { force: true });
      }
    }
    if (!existsSync(this.path)) {
      this.records = [];
      this.currentBytes = 0;
      return this.records;
    }
    const data = readFileSync(this.path);
    if (data.length === 0) {
      this.records = [];
      this.currentBytes = 0;
      return this.records;
    }

    const lastNewline = data.lastIndexOf(0x0a);
    const completeLength = lastNewline + 1;
    if (completeLength !== data.length) truncateSync(this.path, completeLength);
    if (completeLength === 0) {
      this.records = [];
      this.currentBytes = 0;
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
    this.currentBytes = completeLength;
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
    const serialized = `${JSON.stringify(record)}\n`;
    const writtenBytes = Buffer.byteLength(serialized, 'utf8');
    const reservedBytes = this.reservedBytesAfterAppend(entry);
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
      throw new Error('Invalid relay journal reserve');
    }
    if (this.currentBytes + writtenBytes + reservedBytes > this.maxFileBytes) {
      throw new RelayJournalCapacityError();
    }
    const existed = existsSync(this.path);
    const descriptor = openSync(this.path, 'a', 0o600);
    try {
      appendFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      if (!existed) fsyncDirectory(this.directory);
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      closeSync(descriptor);
    }
    this.records.push(record);
    this.currentBytes += writtenBytes;
    return record;
  }

  /** Replace a replayed journal with an atomically installed, fsynced snapshot of its retained events. */
  compact(retained: readonly Pick<RelayOperationLogRecord, 'committedAt' | 'entry'>[]): void {
    if (this.failed) throw new Error('Relay operation log requires restart after an append failure');
    const compacted = retained.map(({ committedAt, entry }, index) => {
      if (!isLogEntry(entry) || !isTimestamp(committedAt)) {
        throw new Error('Invalid relay operation log compaction entry');
      }
      const base = { version: 1 as const, sequence: index + 1, committedAt, entry };
      return { ...base, recordId: recordId(base) };
    });
    const compactedBytes = compacted.reduce(
      (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1, 0,
    );
    // Old and replacement files coexist until the atomic rename. The server
    // gives this log half of its disk budget so both files fit during rewrite.
    if (compactedBytes > this.maxFileBytes
      || (Number.isFinite(this.maxFileBytes)
        && this.currentBytes + compactedBytes > 2 * this.maxFileBytes)) {
      throw new RelayJournalCapacityError();
    }
    const temporaryPath = `${this.path}.compact-${randomUUID()}`;
    let renamed = false;
    try {
      const descriptor = openSync(temporaryPath, 'wx', 0o600);
      try {
        for (const record of compacted) writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.path);
      renamed = true;
      fsyncDirectory(this.directory);
      this.records = compacted;
      this.currentBytes = compactedBytes;
    } catch (error) {
      // Before rename the original remains authoritative. After rename, the
      // disk state is uncertain until restart, so do not allow another append.
      if (renamed) this.failed = true;
      else rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  get entries(): readonly RelayOperationLogRecord[] {
    return this.records;
  }

  get length(): number {
    return this.records.length;
  }

  get byteLength(): number {
    return this.currentBytes;
  }
}

function fsyncDirectory(directory: string): void {
  // Windows supports flushing the journal file itself but rejects fsync on a
  // directory handle with EPERM. The file fsync above remains the durability
  // boundary available on that platform.
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
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
    if (!verifyPublicationOperation(value.operation)) return false;
    if (hasOnlyKeys(value, ['kind', 'operation'])) return true;
    if (hasOnlyKeys(value, ['allocationRelayId', 'kind', 'operation'])) {
      return isRelayId(value.allocationRelayId);
    }
    if (hasOnlyKeys(value, ['allocationOrigin', 'kind', 'operation'])) {
      return value.allocationOrigin === 'legacy';
    }
    return hasOnlyKeys(value, ['allocationOrigin', 'allocationRelayId', 'kind', 'operation'])
      && (value.allocationOrigin === 'local' || value.allocationOrigin === 'replica')
      && isRelayId(value.allocationRelayId);
  }
  if (value.kind === 'match') {
    if (!hasOnlyKeys(value, ['envelopes', 'kind', 'operation']) || !verifyMatchOperationV2(value.operation)) return false;
    if (!Array.isArray(value.envelopes) || value.envelopes.length !== 2
      || !value.envelopes.every(verifyMailboxEnvelope)) return false;
    return value.envelopes.every(envelope => envelope.payloadType === 'match-notice')
      && value.envelopes[0].mailboxId !== value.envelopes[1].mailboxId
      && value.envelopes[0].envelopeId !== value.envelopes[1].envelopeId;
  }
  if (value.kind === 'match-checkpoint') {
    return hasOnlyKeys(value, ['kind', 'operation']) && verifyMatchOperationV2(value.operation);
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
  if (value.kind === 'placement-intent') {
    return hasOnlyKeys(value, ['intent', 'kind']) && verifyReplicaPlacementIntent(value.intent);
  }
  if (value.kind === 'placement-receipt') {
    return hasOnlyKeys(value, ['kind', 'receipt']) && isDurabilityReceiptV1(value.receipt);
  }
  if (value.kind === 'reconciliation-adoption') {
    return hasOnlyKeys(value, ['allocation', 'kind', 'rejection', 'response'])
      && isRelayReplicaReconciliationReceiptV1(value.rejection)
      && verifyRelayReplicaReconciliationResponseV1(value.response)
      && isPublicationStorageAllocationLog(value.allocation)
      && reconciliationResponseMatchesRejection(value.response, value.rejection)
      && value.response.status === 'operation'
      && value.response.operation !== null
      && (value.response.operation.kind === 'publication-tombstone'
        || value.response.operation.sequence > value.rejection.operationSequence);
  }
  return false;
}

function reconciliationResponseMatchesRejection(
  response: RelayReplicaReconciliationResponseV1,
  rejection: RelayReplicaReceiptV1,
): boolean {
  return response.senderRelayId === rejection.senderRelayId
    && response.responderRelayId === rejection.responderRelayId
    && response.publicationId === rejection.publicationId
    && response.rejectionRequestId === rejection.requestId
    && response.rejectionSignature === rejection.signature;
}

function isPublicationStorageAllocationLog(
  value: unknown,
): value is RelayPublicationStorageAllocationLog {
  if (!isObject(value) || typeof value.allocationOrigin !== 'string') return false;
  if (value.allocationOrigin === 'legacy') return hasOnlyKeys(value, ['allocationOrigin']);
  return hasOnlyKeys(value, ['allocationOrigin', 'allocationRelayId'])
    && (value.allocationOrigin === 'local' || value.allocationOrigin === 'replica')
    && isRelayId(value.allocationRelayId);
}

function isRelayId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const key = didToPublicKey(value);
    return key.length === 32 && publicKeyToDid(key) === value;
  } catch {
    return false;
  }
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
