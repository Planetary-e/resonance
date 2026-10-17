import { expect, it } from 'vitest';
import { historyDigest } from '@resonance/core/history-checkpoint';
import { readHistorySequenceIndex } from '../history-sequence-index.js';

const ids = Array.from({ length: 6 }, (_, i) => historyDigest(String(i)));
it('keeps a billion-position certified gap structural while bounding retained entries and suffix work', () => {
  const start = 1_000_000_000;
  const index = readHistorySequenceIndex({ version: 1, entries: [[0, ids[0]], [start, ids[1]], [start + 1, ids[2]]] }, 3);
  expect(index.count).toBe(3); expect(index.get(start - 1)).toBeNull(); expect(index.get(start)).toBe(ids[1]);
  expect(index.suffix(start)).toEqual([ids[1], ids[2]]);
  expect(() => index.suffix(0)).toThrow('capacity'); expect(() => index.extend(start + 2, ids[3])).toThrow('capacity');
  expect(Buffer.byteLength(JSON.stringify(index.encode()))).toBeLessThan(400);
  const retired = readHistorySequenceIndex(index.retireBefore(start + 1), 3);
  expect(retired.count).toBe(2); expect(retired.get(0)).toBe(ids[0]); expect(retired.get(start)).toBeNull();
  expect(readHistorySequenceIndex(retired.extend(start + 2, ids[3]), 3).suffix(start + 1)).toEqual([ids[2], ids[3]]);
});
it('reads old absolute slots without mutating them and rejects ambiguous, oversized or unsafe indexes', () => {
  const legacy = [ids[0], null, null, ids[1]], before = [...legacy];
  expect(readHistorySequenceIndex(legacy, 4).encode()).toEqual({ version: 1, entries: [[0, ids[0]], [3, ids[1]]] });
  expect(legacy).toEqual(before); expect(() => readHistorySequenceIndex(legacy, 3)).toThrow();
  for (const raw of [Array(3), [null], [ids[0], null], { version: 1, entries: Array(3) },
    { version: 1, entries: [[0, ids[0]], [2, ids[1]], [1, ids[2]]] },
    { version: 1, entries: [[1, ids[0]]] }, { version: 1, entries: [[0, ids[0]], [2, ids[0]]] },
    { version: 1, entries: [[0, ids[0]], [Number.MAX_SAFE_INTEGER, ids[1]]] },
    { version: 1, entries: [[0, ids[0]], [1.5, ids[1]]] },
    { version: 1, entries: [[0, ids[0]]], ignored: true }]) expect(() => readHistorySequenceIndex(raw, 4)).toThrow();
});
