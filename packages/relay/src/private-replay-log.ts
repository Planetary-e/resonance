/** Fsynced, short-lived replay evidence for private entry and destination layers. */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PrivateReplayRecordV1 } from '@resonance/core';

export const PRIVATE_REPLAY_LOG_FILENAME = 'private-replay.ndjson';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

interface LogLine extends PrivateReplayRecordV1 {
  version: 1;
  checksum: string;
}

export class PrivateReplayLog {
  private readonly path: string;
  private readonly active = new Map<string, number>();
  private byteLength = 0;
  private failed = false;

  constructor(private readonly directory: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > DEFAULT_MAX_BYTES) {
      throw new Error('Invalid private replay log capacity');
    }
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, PRIVATE_REPLAY_LOG_FILENAME);
  }

  load(now = Date.now()): PrivateReplayRecordV1[] {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid replay load time');
    this.failed = false;
    this.active.clear();
    for (const name of readdirSync(this.directory)) {
      if (/^private-replay\.ndjson\.compact-[0-9a-f-]{36}$/.test(name)) {
        rmSync(join(this.directory, name), { force: true });
      }
    }
    if (!existsSync(this.path)) { this.byteLength = 0; return []; }
    const data = readFileSync(this.path);
    if (data.length > this.maxBytes) throw new Error('Private replay log exceeds capacity');
    const completeLength = data.lastIndexOf(0x0a) + 1;
    if (completeLength !== data.length) {
      truncateSync(this.path, completeLength);
      syncFile(this.path);
    }
    this.byteLength = completeLength;
    if (completeLength === 0) return [];
    const lines = data.subarray(0, completeLength).toString('utf8').split('\n');
    lines.pop();
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { throw new Error(`Corrupt private replay log at line ${index + 1}`); }
      if (!isLine(parsed)) throw new Error(`Invalid private replay log at line ${index + 1}`);
      if (parsed.expiresAt > now) {
        if (this.active.has(parsed.id)) throw new Error('Duplicate private replay log entry');
        this.active.set(parsed.id, parsed.expiresAt);
      }
    }
    if (this.byteLength > this.maxBytes / 2) this.compact(now);
    return [...this.active].map(([id, expiresAt]) => ({ id, expiresAt }));
  }

  append(record: PrivateReplayRecordV1, now = Date.now()): void {
    if (this.failed) throw new Error('Private replay log requires restart after a write failure');
    if (!validRecord(record) || !Number.isSafeInteger(now) || now < 0
      || record.expiresAt <= now) throw new Error('Invalid private replay log append');
    this.prune(now);
    if (this.active.has(record.id)) throw new Error('Replayed private request');
    const serialized = serialize(record);
    const length = Buffer.byteLength(serialized);
    if (this.byteLength + length > this.maxBytes) this.compact(now);
    if (this.byteLength + length > this.maxBytes) {
      throw new Error('Private replay log capacity exhausted');
    }
    const existed = existsSync(this.path);
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeFileSync(fd, serialized, 'utf8');
      fsyncSync(fd);
      if (!existed) syncDirectory(this.directory);
    } catch (error) {
      this.failed = true;
      throw error;
    } finally { closeSync(fd); }
    this.active.set(record.id, record.expiresAt);
    this.byteLength += length;
  }

  private compact(now: number): void {
    this.prune(now);
    const serialized = [...this.active].map(([id, expiresAt]) =>
      serialize({ id, expiresAt })).join('');
    const length = Buffer.byteLength(serialized);
    if (length > this.maxBytes) throw new Error('Private replay log capacity exhausted');
    const temporary = `${this.path}.compact-${randomUUID()}`;
    let renamed = false;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, serialized, 'utf8');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      renamed = true;
      syncDirectory(this.directory);
      this.byteLength = length;
    } catch (error) {
      if (renamed) this.failed = true;
      else rmSync(temporary, { force: true });
      throw error;
    }
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.active) if (expiresAt <= now) this.active.delete(id);
  }
}

function validRecord(value: unknown): value is PrivateReplayRecordV1 {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && 'id' in value && typeof value.id === 'string' && value.id.length <= 256
    && /^[A-Za-z0-9:_-]+$/.test(value.id)
    && 'expiresAt' in value && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) >= 0;
}

function isLine(value: unknown): value is LogLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || !('version' in value) || value.version !== 1
    || !('checksum' in value) || typeof value.checksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.checksum)
    || !('id' in value) || !('expiresAt' in value)) return false;
  const record = { id: value.id, expiresAt: value.expiresAt };
  return validRecord(record) && value.checksum === checksum(record);
}

function serialize(record: PrivateReplayRecordV1): string {
  return `${JSON.stringify({ version: 1, ...record, checksum: checksum(record) })}\n`;
}

function checksum(record: PrivateReplayRecordV1): string {
  return createHash('sha256').update(`private-replay:v1:${record.id}:${record.expiresAt}`).digest('hex');
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
