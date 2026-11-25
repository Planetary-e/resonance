import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { writeAtomic, writeAtomicJson } from './atomic-file.js';
import {
  createLeasedIndexGenerationIdV1,
  decodeBase64,
  isLeasedIndexActiveV1,
  parseLeasedIndexOperationV1,
  type LeasedIndexOperationV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { guardUnmanagedExport } from './unmanaged-export.js';
import {
  MatchingEngine,
  type LeasedMatchNotification,
} from './matching-engine.js';
import type { HashMetadata } from './hamming-index.js';

const STORE_FILENAME = 'leased-index-operations.json';
const LOG_DIRECTORY = 'leased-index-log-v1';
const LOG_COMPLETE_FILENAME = 'complete.json';
const MIN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type LeasedIndexApplyStatus =
  | 'accepted'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'terminal'
  | 'invalid'
  | 'invalid_transition'
  | 'not_yet_valid'
  | 'expired';

export interface LeasedIndexApplyResult {
  status: LeasedIndexApplyStatus;
  current?: LeasedIndexOperationV1;
  currentBytes?: string;
  conflictBytes?: string;
  notifications: LeasedMatchNotification[];
}

interface StoredOperation {
  bytes: string;
  operation: LeasedIndexOperationV1;
}

interface PublicationState {
  current: StoredOperation;
  history: StoredOperation[];
  conflicts: StoredOperation[];
}

interface StoredFile {
  version: 1;
  publications: PublicationState[];
}

interface PendingPersistence {
  bytes: string;
  repair: boolean;
  createdAt: number;
}

interface LogRecord extends PendingPersistence {
  version: 1;
  sequence: number;
}

export class LeasedIndexStore {
  private readonly assertExportAllowed = guardUnmanagedExport();
  private publications = new Map<string, PublicationState>();
  private generations = new Map<string, LeasedIndexV1>();
  private pendingPersistence: PendingPersistence[] = [];
  private pendingDedup: LeasedMatchNotification[] = [];
  private persistedBytes = new Set<string>();
  private nextLogSequence = 1;
  private incrementalReady = false;
  readonly matching: MatchingEngine;

  constructor(matching = new MatchingEngine()) {
    this.matching = matching;
  }

  apply(raw: string | Uint8Array, now = Date.now(), repair = false): LeasedIndexApplyResult {
    let bytes: string;
    let operation: LeasedIndexOperationV1;
    try {
      bytes = exactOperationBytes(raw);
      operation = parseLeasedIndexOperationV1(bytes);
    } catch {
      return { status: 'invalid', notifications: [] };
    }
    return this.applyParsed(bytes, operation, now, repair);
  }

  private applyParsed(
    bytes: string,
    operation: LeasedIndexOperationV1,
    now: number,
    repair: boolean,
  ): LeasedIndexApplyResult {
    const state = this.publications.get(operation.publicationId);
    const duplicate = findExact(state?.history, bytes) ?? findExact(state?.conflicts, bytes);
    if (duplicate) {
      return {
        status: findExact(state?.conflicts, bytes) ? 'conflict' : 'duplicate',
        current: state?.current.operation,
        currentBytes: state?.current.bytes,
        conflictBytes: duplicate.bytes,
        notifications: [],
      };
    }
    if (state?.current.operation.kind === 'leased-discovery-withdrawal') {
      return {
        status: 'terminal',
        current: state.current.operation,
        currentBytes: state.current.bytes,
        notifications: [],
      };
    }
    if (operation.kind === 'leased-discovery-withdrawal') {
      if (state && !sameWriter(state.current.operation, operation)) {
        return { status: 'invalid', current: state.current.operation, notifications: [] };
      }
      const stored = { bytes, operation };
      const next: PublicationState = {
        current: stored,
        history: [...state?.history ?? [], stored],
        conflicts: state?.conflicts ?? [],
      };
      this.publications.set(operation.publicationId, next);
      this.matching.withdraw('', operation.publicationId);
      this.pendingPersistence.push({ bytes, repair, createdAt: operation.createdAt });
      return { status: 'accepted', current: operation, currentBytes: bytes, notifications: [] };
    }

    const current = state?.current.operation;
    if (current && current.kind === 'leased-discovery-index'
      && operation.leaseSequence < current.leaseSequence) {
      return { status: 'stale', current, currentBytes: state.current.bytes, notifications: [] };
    }
    if (!Number.isSafeInteger(now) || now < 0) return { status: 'invalid', notifications: [] };
    if (now < operation.createdAt) {
      return { status: 'not_yet_valid', current, currentBytes: state?.current.bytes, notifications: [] };
    }
    if (now >= operation.expiresAt) {
      return { status: 'expired', current, currentBytes: state?.current.bytes, notifications: [] };
    }
    if (current && current.kind === 'leased-discovery-index'
      && operation.leaseSequence === current.leaseSequence) {
      const conflict = { bytes, operation };
      if (!state.conflicts.some(item => item.operation.leaseSequence === operation.leaseSequence)) {
        state.conflicts.push(conflict);
        this.rememberGeneration(operation);
      }
      this.matching.removeLeased(operation.publicationId);
      const retained = state.conflicts.find(item => item.operation.leaseSequence === operation.leaseSequence)!;
      this.pendingPersistence.push({ bytes, repair, createdAt: operation.createdAt });
      return {
        status: 'conflict',
        current,
        currentBytes: state.current.bytes,
        conflictBytes: retained.bytes,
        notifications: [],
      };
    }
    if (current && !isValidSuccessor(current, operation, now)) {
      return { status: 'invalid_transition', current, currentBytes: state?.current.bytes, notifications: [] };
    }

    const stored = { bytes, operation };
    this.publications.set(operation.publicationId, {
      current: stored,
      history: [...state?.history ?? [], stored],
      conflicts: state?.conflicts ?? [],
    });
    this.rememberGeneration(operation);
    const notifications = this.updateMatching(current, operation, repair);
    this.pendingPersistence.push({ bytes, repair, createdAt: operation.createdAt });
    return { status: 'accepted', current: operation, currentBytes: bytes, notifications };
  }

  get(publicationId: string): LeasedIndexOperationV1 | undefined {
    return this.publications.get(publicationId)?.current.operation;
  }

  getExactBytes(publicationId: string, generationId?: string): string | undefined {
    const state = this.publications.get(publicationId);
    if (!state) return undefined;
    if (generationId === undefined || state.current.operation.kind === 'leased-discovery-withdrawal') {
      return state.current.bytes;
    }
    if (createLeasedIndexGenerationIdV1(state.current.operation) === generationId) return state.current.bytes;
    return [...state.history, ...state.conflicts].find(item => (
      item.operation.kind === 'leased-discovery-index'
      && createLeasedIndexGenerationIdV1(item.operation) === generationId
    ))?.bytes;
  }

  getActiveExactBytes(publicationId: string, generationId: string, now = Date.now()): string | undefined {
    const state = this.publications.get(publicationId);
    const current = state?.current.operation;
    if (!state || current?.kind !== 'leased-discovery-index'
      || createLeasedIndexGenerationIdV1(current) !== generationId
      || !isLeasedIndexActiveV1(current, now)
      || state.conflicts.some(item => item.operation.leaseSequence === current.leaseSequence)) {
      return undefined;
    }
    return state.current.bytes;
  }

  currentByLease(clientLeaseId: string): LeasedIndexV1 | undefined {
    for (const state of this.publications.values()) {
      if (state.current.operation.kind === 'leased-discovery-index'
        && state.current.operation.clientLeaseId === clientLeaseId
        && !state.conflicts.some(item => (
          item.operation.leaseSequence === state.current.operation.leaseSequence
        ))) return state.current.operation;
    }
    return undefined;
  }

  currentByPublication(publicationId: string): LeasedIndexV1 | undefined {
    const state = this.publications.get(publicationId);
    if (!state || state.current.operation.kind !== 'leased-discovery-index') return undefined;
    if (state.conflicts.some(item => (
      item.operation.leaseSequence === state.current.operation.leaseSequence
    ))) return undefined;
    return state.current.operation;
  }

  authorizedByLease(clientLeaseId: string): LeasedIndexV1 | undefined {
    for (const state of this.publications.values()) {
      const latest = [...state.history].reverse().find(item => (
        item.operation.kind === 'leased-discovery-index'
        && item.operation.clientLeaseId === clientLeaseId
      ))?.operation;
      if (latest?.kind === 'leased-discovery-index') return latest;
    }
    return undefined;
  }

  byGeneration(generationId: string): LeasedIndexV1 | undefined {
    return this.generations.get(generationId);
  }

  private rememberGeneration(operation: LeasedIndexV1): void {
    const generationId = createLeasedIndexGenerationIdV1(operation);
    if (!this.generations.has(generationId)) this.generations.set(generationId, operation);
  }

  exportReplicaState(publicationId: string): string[] {
    const state = this.publications.get(publicationId);
    if (!state) return [];
    return [state.current, ...state.conflicts].map(item => item.bytes);
  }

  repairFrom(source: LeasedIndexStore, publicationId: string, now = Date.now()): LeasedIndexApplyResult[] {
    const results = this.exportReplicaStateFrom(source, publicationId)
      .map(bytes => this.apply(bytes, now, true));
    const dedup = source.matching.exportLeasedDedup(publicationId);
    this.matching.importLeasedDedup(dedup);
    this.pendingDedup.push(...dedup);
    return results;
  }

  activeRecords(now = Date.now()): LeasedIndexV1[] {
    return Array.from(this.publications.values()).flatMap(state => {
      const current = state.current.operation;
      if (current.kind !== 'leased-discovery-index' || !isLeasedIndexActiveV1(current, now)) return [];
      if (state.conflicts.some(item => item.operation.leaseSequence === current.leaseSequence)) return [];
      return [current];
    });
  }

  isQuarantined(publicationId: string): boolean {
    const state = this.publications.get(publicationId);
    if (!state) return false;
    return state.conflicts.some(item => (
      item.operation.leaseSequence === state.current.operation.leaseSequence
    ));
  }

  save(directory: string): void {
    this.assertExportAllowed();
    mkdirSync(directory, { recursive: true });
    const logDirectory = join(directory, LOG_DIRECTORY);
    if (!this.incrementalReady) {
      const preserveExistingBase = existsSync(join(directory, STORE_FILENAME));
      if (!preserveExistingBase) {
        const file: StoredFile = {
          version: 1,
          publications: Array.from(this.publications.values())
            .sort((a, b) => a.current.operation.publicationId.localeCompare(b.current.operation.publicationId)),
        };
        writeAtomicJson(join(directory, STORE_FILENAME), file);
        this.matching.save(directory);
        this.persistedBytes.clear();
      }
      rmSync(logDirectory, { recursive: true, force: true });
      mkdirSync(logDirectory, { recursive: true });
      this.nextLogSequence = 1;
      this.incrementalReady = true;
    } else {
      mkdirSync(logDirectory, { recursive: true });
    }
    const pending = this.pendingPersistence.length > 0
      ? this.pendingPersistence
      : this.unpersistedOperations();
    let changed = !existsSync(join(logDirectory, LOG_COMPLETE_FILENAME));
    for (const item of pending) {
      if (this.persistedBytes.has(item.bytes)) continue;
      const sequence = this.nextLogSequence++;
      const record: LogRecord = { version: 1, sequence, ...item };
      writeAtomic(
        join(logDirectory, `${String(sequence).padStart(20, '0')}.json`),
        JSON.stringify(record),
      );
      this.persistedBytes.add(item.bytes);
      changed = true;
    }
    for (const notification of this.pendingDedup) {
      const sequence = this.nextLogSequence++;
      writeAtomic(
        join(logDirectory, `${String(sequence).padStart(20, '0')}.json`),
        JSON.stringify({ version: 1, sequence, kind: 'dedup', notification }),
      );
      changed = true;
    }
    this.pendingDedup = [];
    this.pendingPersistence = this.pendingPersistence.filter(item => !this.persistedBytes.has(item.bytes));
    if (changed) {
      writeAtomic(join(logDirectory, LOG_COMPLETE_FILENAME), JSON.stringify({
        version: 1,
        nextSequence: this.nextLogSequence,
      }));
    }
  }

  load(directory: string): void {
    this.publications = new Map();
    this.generations = new Map();
    this.pendingPersistence = [];
    this.pendingDedup = [];
    this.persistedBytes.clear();
    this.nextLogSequence = 1;
    this.incrementalReady = false;
    const path = join(directory, STORE_FILENAME);
    if (existsSync(path)) {
      const parsed = readStoredFile(path);
      if (!isStoredFile(parsed)) throw new Error('Invalid persisted leased index store');
      for (const state of parsed.publications) {
        const publicationId = state.current.operation.publicationId;
        if (this.publications.has(publicationId)) throw new Error('Duplicate persisted leased index state');
        this.publications.set(publicationId, state);
        for (const item of [...state.history, ...state.conflicts]) {
          this.persistedBytes.add(item.bytes);
          if (item.operation.kind === 'leased-discovery-index') this.rememberGeneration(item.operation);
        }
      }
    }
    this.matching.load(directory);
    const completePath = join(directory, LOG_DIRECTORY, LOG_COMPLETE_FILENAME);
    if (!existsSync(completePath)) return;
    const complete: unknown = JSON.parse(readFileSync(completePath, 'utf8'));
    if (!isObject(complete) || complete.version !== 1
      || typeof complete.nextSequence !== 'number'
      || !Number.isSafeInteger(complete.nextSequence) || complete.nextSequence < 1) {
      throw new Error('Invalid leased index log commit marker');
    }
    const nextSequence = complete.nextSequence;
    for (let sequence = 1; sequence < nextSequence; sequence++) {
      const recordPath = join(directory, LOG_DIRECTORY, `${String(sequence).padStart(20, '0')}.json`);
      const record: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (!isObject(record) || record.version !== 1 || record.sequence !== sequence) {
        throw new Error('Invalid leased index log record');
      }
      if (record.kind === 'dedup') {
        this.matching.importLeasedDedup([record.notification as LeasedMatchNotification]);
        continue;
      }
      if (typeof record.bytes !== 'string' || typeof record.repair !== 'boolean') {
        throw new Error('Invalid leased index log record');
      }
      const operation = parseLeasedIndexOperationV1(record.bytes);
      if (record.createdAt !== undefined && record.createdAt !== operation.createdAt) {
        throw new Error('Leased index log timestamp does not match signed operation');
      }
      const result = this.applyParsed(record.bytes, operation, operation.createdAt, record.repair);
      if (!['accepted', 'conflict', 'duplicate'].includes(result.status)) {
        throw new Error(`Invalid leased index log transition: ${result.status}`);
      }
      this.persistedBytes.add(record.bytes);
    }
    this.nextLogSequence = nextSequence;
    this.pendingPersistence = [];
    this.incrementalReady = true;
  }

  private unpersistedOperations(): PendingPersistence[] {
    const pending: PendingPersistence[] = [];
    for (const state of this.publications.values()) {
      for (const item of [...state.history, ...state.conflicts]) {
        if (!this.persistedBytes.has(item.bytes)) {
          pending.push({ bytes: item.bytes, repair: false, createdAt: item.operation.createdAt });
        }
      }
    }
    return pending;
  }

  private updateMatching(
    current: LeasedIndexOperationV1 | undefined,
    next: LeasedIndexV1,
    repair: boolean,
  ): LeasedMatchNotification[] {
    const hash = decodeBase64(next.fingerprint.value);
    const meta = hashMetadata(next);
    if (repair) {
      this.matching.refreshLeased(hash, meta);
      return [];
    }
    if (current?.kind === 'leased-discovery-index'
      && current.semanticRevision === next.semanticRevision) {
      this.matching.refreshLeased(hash, meta);
      return [];
    }
    if (current?.kind === 'leased-discovery-index') {
      return this.matching.reviseLeasedAndMatch(hash, meta, next.publicationId);
    }
    return this.matching.insertLeasedAndMatch(hash, meta, next.publicationId);
  }

  private exportReplicaStateFrom(source: LeasedIndexStore, publicationId: string): string[] {
    return source.exportReplicaState(publicationId);
  }
}

function isValidSuccessor(current: LeasedIndexOperationV1, next: LeasedIndexV1, now: number): boolean {
  if (!sameWriter(current, next) || next.createdAt <= current.createdAt) return false;
  if (current.kind === 'leased-discovery-withdrawal') return false;
  if (next.semanticRevision < current.semanticRevision) return false;
  if (next.semanticRevision > current.semanticRevision) return true;
  return next.expiresAt > current.expiresAt
    && next.createdAt - current.createdAt >= MIN_REFRESH_INTERVAL_MS
    && now < current.expiresAt
    && sameSemanticFields(current, next);
}

function sameSemanticFields(first: LeasedIndexV1, second: LeasedIndexV1): boolean {
  return first.derivationId === second.derivationId
    && first.groupId === second.groupId
    && first.itemType === second.itemType
    && first.mailbox.id === second.mailbox.id
    && first.mailbox.encryptionKey === second.mailbox.encryptionKey
    && first.original.commitmentAlgorithm === second.original.commitmentAlgorithm
    && first.original.commitment === second.original.commitment
    && JSON.stringify(first.fingerprint) === JSON.stringify(second.fingerprint);
}

function sameWriter(first: LeasedIndexOperationV1, second: LeasedIndexOperationV1): boolean {
  return first.publicationId === second.publicationId
    && first.clientLeaseId === second.clientLeaseId
    && first.publicationKey === second.publicationKey;
}

function hashMetadata(record: LeasedIndexV1): HashMetadata {
  return {
    did: record.clientLeaseId,
    itemType: record.itemType,
    itemId: record.publicationId,
    generationId: createLeasedIndexGenerationIdV1(record),
    scope: `${record.groupId}\n${record.fingerprint.epoch}`,
    expiresAt: record.expiresAt,
  };
}

function exactOperationBytes(raw: string | Uint8Array): string {
  if (typeof raw === 'string') return raw;
  if (!(raw instanceof Uint8Array)) throw new Error('Invalid operation bytes');
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}

function findExact(operations: StoredOperation[] | undefined, bytes: string): StoredOperation | undefined {
  return operations?.find(item => item.bytes === bytes);
}

function readStoredFile(path: string): unknown {
  const prefix = '{"version":1,"publications":[';
  const fd = openSync(path, 'r');
  try {
    const marker = Buffer.alloc(prefix.length);
    const count = readSync(fd, marker, 0, marker.length, null);
    if (count !== marker.length || marker.toString('utf8') !== prefix) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(64 * 1024);
    const publications: unknown[] = [];
    let item = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let arrayDone = false;
    let fileDone = false;
    const consume = (text: string) => {
      for (const char of text) {
        if (fileDone) {
          if (/\s/.test(char)) continue;
          throw new Error('Trailing content in leased index store');
        }
        if (arrayDone) {
          if (char === '}') fileDone = true;
          else if (!/\s/.test(char)) throw new Error('Invalid leased index store suffix');
          continue;
        }
        if (depth === 0) {
          if (/\s/.test(char) || char === ',') continue;
          if (char === ']') {
            arrayDone = true;
            continue;
          }
          if (char !== '{') throw new Error('Invalid publication in leased index store');
          item = '{';
          depth = 1;
          inString = false;
          escaped = false;
          continue;
        }
        item += char;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) publications.push(JSON.parse(item));
        }
      }
    };
    while (true) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      consume(decoder.write(chunk.subarray(0, read)));
    }
    consume(decoder.end());
    if (!arrayDone || !fileDone || depth !== 0 || inString) throw new Error('Incomplete leased index store');
    return { version: 1, publications };
  } finally {
    closeSync(fd);
  }
}

function isStoredFile(value: unknown): value is StoredFile {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'publications,version'
    || value.version !== 1 || !Array.isArray(value.publications)) return false;
  return value.publications.every(isPublicationState);
}

function isPublicationState(value: unknown): value is PublicationState {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'conflicts,current,history'
    || !Array.isArray(value.history) || !Array.isArray(value.conflicts)) return false;
  try {
    if (!isStoredOperation(value.current)) return false;
    const history = value.history;
    const conflicts = value.conflicts;
    if (!history.every(isStoredOperation) || !conflicts.every(isStoredOperation)) return false;
    const current = value.current;
    const publicationId = current.operation.publicationId;
    const all = [...history, ...conflicts, current];
    if (!all.every(item => sameWriter(item.operation, current.operation))) return false;
    if (!history.some(item => item.bytes === current.bytes)) return false;
    if (new Set(history.map(item => item.operation.leaseSequence)).size !== history.length) return false;
    if (new Set(conflicts.map(item => item.operation.leaseSequence)).size !== conflicts.length) return false;
    if (!conflicts.every(item => history.some(accepted => (
      accepted.operation.leaseSequence === item.operation.leaseSequence
    )))) return false;
    if (current.operation.kind === 'leased-discovery-withdrawal') return true;
    return !history.some(item => item.operation.leaseSequence > current.operation.leaseSequence);
  } catch {
    return false;
  }
}

function isStoredOperation(value: unknown): value is StoredOperation {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'bytes,operation'
    || typeof value.bytes !== 'string') return false;
  try {
    const operation = parseLeasedIndexOperationV1(value.bytes);
    return JSON.stringify(operation) === JSON.stringify(value.operation);
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
