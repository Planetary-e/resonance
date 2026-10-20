import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateRequestReplayCacheV1, generateIdentity, type PrivateRequestLayerV1 } from '@resonance/core';
import { PrivateReplayLog, PRIVATE_REPLAY_LOG_FILENAME } from '../private-replay-log.js';

const NOW = 1_800_000_000_000;
const directories: string[] = [];
const relayId = generateIdentity().did;
const keyId = 'A'.repeat(22);

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'resonance-private-replay-'));
  directories.push(path);
  return path;
}

function layer(requestId: string, expiresAt = NOW + 30_000): PrivateRequestLayerV1 {
  return {
    version: 1, stage: 'entry', relayId, keyId, requestId: requestId.padEnd(22, 'A'),
    expiresAt, enc: Buffer.alloc(65, 1).toString('base64'), ciphertext: Buffer.from('payload').toString('base64'),
  };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable private request replay evidence', () => {
  it('rejects the same live request after a fresh log and cache are loaded', () => {
    const path = directory();
    const firstLog = new PrivateReplayLog(path);
    const first = new PrivateRequestReplayCacheV1(
      4096, firstLog.load(NOW), record => firstLog.append(record, NOW), NOW,
    );
    first.consume(layer('one'), NOW);
    expect(readFileSync(join(path, PRIVATE_REPLAY_LOG_FILENAME), 'utf8')).toContain(`entry:${relayId}:${keyId}:one`);

    const restartedLog = new PrivateReplayLog(path);
    const restarted = new PrivateRequestReplayCacheV1(
      4096, restartedLog.load(NOW + 1), record => restartedLog.append(record, NOW + 1), NOW + 1,
    );
    expect(() => restarted.consume(layer('one'), NOW + 1)).toThrow('Replayed');
    expect(() => restarted.consume(layer('two'), NOW + 1)).not.toThrow();
    expect(new PrivateReplayLog(path).load(NOW + 30_001)).toEqual([]);
  });

  it('removes an interrupted tail but rejects corruption of a complete record', () => {
    const path = directory();
    const log = new PrivateReplayLog(path);
    log.load(NOW);
    log.append({ id: 'entry:relay:key:one', expiresAt: NOW + 30_000 }, NOW);
    const file = join(path, PRIVATE_REPLAY_LOG_FILENAME);
    appendFileSync(file, '{"version":1,"id":"unfinished"');
    expect(new PrivateReplayLog(path).load(NOW + 1)).toEqual([
      { id: 'entry:relay:key:one', expiresAt: NOW + 30_000 },
    ]);
    expect(readFileSync(file, 'utf8')).not.toContain('unfinished');
    writeFileSync(file, readFileSync(file, 'utf8').replace('entry:relay:key:one', 'entry:relay:key:evil'));
    expect(() => new PrivateReplayLog(path).load(NOW + 1)).toThrow('Invalid private replay log');
  });

  it('compacts expired evidence while retaining live replay rejection', () => {
    const path = directory();
    const log = new PrivateReplayLog(path, 512);
    log.load(NOW);
    for (let index = 0; index < 3; index++) {
      log.append({ id: `entry:relay:key:old${index}`, expiresAt: NOW + 1 }, NOW);
    }
    log.append({ id: 'entry:relay:key:live', expiresAt: NOW + 30_000 }, NOW + 2);
    expect(new PrivateReplayLog(path, 512).load(NOW + 2)).toEqual([
      { id: 'entry:relay:key:live', expiresAt: NOW + 30_000 },
    ]);
    expect(readFileSync(join(path, PRIVATE_REPLAY_LOG_FILENAME)).length).toBeLessThan(512);
  });

  it('does not accept a request when durable evidence cannot be written', () => {
    const replay = new PrivateRequestReplayCacheV1(
      1, [], () => { throw new Error('disk full'); }, NOW,
    );
    expect(() => replay.consume(layer('one'), NOW)).toThrow('disk full');
    expect(() => replay.consume(layer('one'), NOW)).toThrow('disk full');
  });
});
