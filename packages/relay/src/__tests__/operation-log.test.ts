import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMatchNoticeMessage,
  createMatchOperationV2,
  createPublicationRecord,
  encryptMatchNotice,
  generateIdentity,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import { RelayOperationLog, RELAY_OPERATION_LOG_FILENAME } from '../operation-log.js';

const NOW = 1_800_000_000_000;
const temporaryDirectories: string[] = [];

function fixture() {
  const relay = generateIdentity();
  const input = {
    groupId: 'public', fingerprintEpoch: '2026-09', fingerprint: new Uint8Array(64).fill(0xa5),
    createdAt: NOW, expiresAt: NOW + 86_400_000,
  };
  const need = createPublicationRecord(
    { ...input, itemType: 'need' }, generatePublicationKeyMaterial(),
  );
  const offer = createPublicationRecord(
    { ...input, itemType: 'offer' }, generatePublicationKeyMaterial(),
  );
  const operation = createMatchOperationV2(need, offer, relay, {
    createdAt: NOW + 1, expiresAt: NOW + 60_000,
  });
  const envelopes = [
    encryptMatchNotice(createMatchNoticeMessage(need, offer, operation, relay), need),
    encryptMatchNotice(createMatchNoticeMessage(offer, need, operation, relay), offer),
  ] as const;
  return { need, operation, envelopes };
}

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'resonance-operation-log-'));
  temporaryDirectories.push(result);
  return result;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('RelayOperationLog', () => {
  it('fsyncs replayable publication and atomic match records', () => {
    const dir = directory();
    const { need, operation, envelopes } = fixture();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 2);
    log.append({ kind: 'match', operation, envelopes: [...envelopes] }, NOW + 3);

    const restored = new RelayOperationLog(dir);
    expect(restored.load()).toHaveLength(2);
    expect(restored.entries[1].entry).toEqual({ kind: 'match', operation, envelopes: [...envelopes] });
    expect(readFileSync(join(dir, RELAY_OPERATION_LOG_FILENAME), 'utf8').endsWith('\n')).toBe(true);
  });

  it('rejects corruption in a completed record', () => {
    const dir = directory();
    const { need } = fixture();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 2);
    appendFileSync(join(dir, RELAY_OPERATION_LOG_FILENAME), '{}\n');

    expect(() => new RelayOperationLog(dir).load()).toThrow('sequence 2');
  });

  it('truncates an incomplete tail and continues the sequence safely', () => {
    const dir = directory();
    const { need } = fixture();
    const path = join(dir, RELAY_OPERATION_LOG_FILENAME);
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 2);
    appendFileSync(path, '{"version":1,"sequence":2');

    const restored = new RelayOperationLog(dir);
    expect(restored.load()).toHaveLength(1);
    restored.append({ kind: 'publication', operation: need }, NOW + 3);
    expect(new RelayOperationLog(dir).load().map(record => record.sequence)).toEqual([1, 2]);
  });
});
