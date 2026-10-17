import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryFreeze, historyCheckpointEnvelopeId, openHistoryCheckpoint, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), writeSync: vi.fn(fs.writeSync) };
});
const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const clean: Array<() => void> = [];
afterEach(() => {
  vi.mocked(fsyncSync).mockReset().mockImplementation(fs.fsyncSync);
  vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync);
  vi.mocked(writeSync).mockReset().mockImplementation(fs.writeSync);
  for (const close of clean.splice(0).reverse()) close();
});
function fixture(extra: { maxBlocks?: number; maxBytes?: number } = {}) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-checkpoint-'));
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const options = { ...f.options, directory, ...extra };
  const open = (initialize = false, changes = {}) => {
    const store = openHistoryCheckpointStore({ ...options, ...changes, ...(initialize ? { initialize: f.root } : {}) });
    clean.push(() => store.close()); return store;
  };
  const block = (id: string) => join(directory, `${id.slice(7)}.block`);
  return { ...f, directory, options, open, block };
}

it('appends recoverable encrypted deltas without rewriting payloads, retains later checkpoints and retries exactly', () => {
  const f = fixture(); let store = f.open(true);
  const before = statSync(f.block(f.options.rootId)), bytes = readFileSync(f.block(f.options.rootId));
  const delta = f.next(f.root), checkpoint = f.next(delta, 'new full state', 'checkpoint');
  const id = store.append(delta); store.append(checkpoint);
  vi.mocked(writeSync).mockClear();
  expect(store.append(delta)).toBe(id); expect(writeSync).not.toHaveBeenCalled();
  expect(statSync(f.block(f.options.rootId)).ino).toBe(before.ino);
  expect(statSync(f.block(f.options.rootId)).mtimeMs).toBe(before.mtimeMs);
  expect(readFileSync(f.block(f.options.rootId))).toEqual(bytes);
  const returned = store.read(); returned.envelopes.splice(0); // Defensive copies.
  expect(store.read().envelopes).toHaveLength(3);
  store.close(); store = f.open();
  expect(store.read().envelopes).toEqual([f.root, delta, checkpoint]);
  expect(openHistoryCheckpoint(store.read().envelopes[1], f.context, f.key).toString()).toBe('a spent binding');
  for (const name of readdirSync(f.directory)) expect(readFileSync(join(f.directory, name)).toString()).not.toContain('a spent binding');
  expect(statSync(f.block(id)).mode & 0o777).toBe(0o600);
});

it('rejects gaps, forks, foreign contexts and unauthorized generations without damaging accepted history', () => {
  const f = fixture(), store = f.open(true), delta = f.next(f.root), later = f.next(delta);
  expect(() => store.append(later)).toThrow('gap');
  store.append(delta);
  expect(() => store.append(f.next(f.root, 'conflicting'))).toThrow('fork');
  const future = sealHistoryCheckpoint({ context: f.context, header: { kind: 'delta', generation: 1, sequence: 2,
    previous: historyCheckpointEnvelopeId(delta) }, plaintext: Buffer.from('data'), encryptionKey: f.key, signingKey: f.owner });
  expect(() => store.append(future)).toThrow('generation');
  expect(() => store.append(historyCheckpointFixture().root)).toThrow();
  expect(store.append(later)).toBe(historyCheckpointEnvelopeId(later));
});

it('serializes writers and durably freezes before allowing any further append, including exact retries', () => {
  const f = fixture(); let store = f.open(true); const delta = f.next(f.root);
  expect(() => f.open()).toThrow('already open');
  const freeze = createHistoryFreeze(f.context, 0, 2, randomBytes(32).toString('base64url'), f.owner);
  store.append(delta); store.freeze(freeze);
  expect(() => store.append(delta)).toThrow('frozen');
  expect(() => store.append(f.next(delta))).toThrow('frozen');
  expect(store.read().envelopes).toEqual([f.root, delta]);
  store.close(); store = f.open(); expect(store.read().freeze).toEqual(freeze);
  expect(() => store.freeze(createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner))).toThrow('Stale');
  expect(() => store.freeze({ ...freeze, nextGeneration: 3 })).toThrow('signature');
  store.freeze(createHistoryFreeze(f.context, 0, 3, randomBytes(32).toString('base64url'), f.owner));
  expect(store.read().freeze?.nextGeneration).toBe(3);
  store.close(); expect(f.open().read().freeze?.nextGeneration).toBe(3);
});

it.each(['blocks', 'bytes'] as const)('refuses exhausted %s capacity while retaining readable, frozen-capable history', kind => {
  const f = fixture(kind === 'blocks' ? { maxBlocks: 1 } : { maxBytes: 4 * 1024 * 1024 + 2048 });
  const store = f.open(true), delta = f.next(f.root, 'x'.repeat(2048));
  expect(() => store.append(delta)).toThrow('capacity');
  expect(store.read().envelopes).toEqual([f.root]);
  expect(existsSync(f.block(historyCheckpointEnvelopeId(delta)))).toBe(false);
  store.freeze(createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner));
  expect(store.read().freeze?.nextGeneration).toBe(1);
});

it.each(['missing-manifest', 'empty-manifest', 'corrupt-manifest', 'missing-block', 'truncated-block', 'changed-block'] as const)
('fails closed on %s and cannot re-enrol over damaged state', damage => {
  const f = fixture(), store = f.open(true), delta = f.next(f.root); store.append(delta); store.close();
  const manifest = join(f.directory, HISTORY_MANIFEST_FILENAME), block = f.block(historyCheckpointEnvelopeId(delta));
  if (damage === 'missing-manifest') rmSync(manifest);
  if (damage === 'empty-manifest') writeFileSync(manifest, '');
  if (damage === 'corrupt-manifest') writeFileSync(manifest, 'garbage');
  if (damage === 'missing-block') rmSync(block);
  if (damage === 'truncated-block') writeFileSync(block, readFileSync(block).subarray(0, 40));
  if (damage === 'changed-block') writeFileSync(block, JSON.stringify({ ...delta, signature: randomBytes(64).toString('base64url') }));
  expect(() => f.open()).toThrow(); expect(() => f.open(true)).toThrow('not empty');
});

it('rejects wrong keys, enrolment pins and externally anchored rollback', () => {
  const f = fixture(), store = f.open(true), old = readFileSync(join(f.directory, HISTORY_MANIFEST_FILENAME));
  const delta = f.next(f.root); store.append(delta); store.close();
  expect(() => f.open(false, { localKey: randomBytes(32) })).toThrow();
  expect(() => f.open(false, { replica: f.context.members[1] })).toThrow();
  expect(() => f.open(false, { generation: 1 })).toThrow();
  writeFileSync(join(f.directory, HISTORY_MANIFEST_FILENAME), old);
  expect(() => f.open(false, { minimum: { sequence: 1, id: historyCheckpointEnvelopeId(delta), generationBarrier: 0 } })).toThrow('anchor');
  // Failed validation must not clean the still recoverable unreferenced delta.
  expect(existsSync(f.block(historyCheckpointEnvelopeId(delta)))).toBe(true);
});

it.each(['block-write', 'block-flush', 'block-directory-flush', 'block-rename', 'index-rename', 'index-flush', 'index-directory-flush'] as const)
('never reports success after %s failure; restart preserves every previously accepted block', point => {
  const f = fixture(), store = f.open(true), accepted = f.next(f.root); store.append(accepted);
  const candidate = f.next(accepted);
  if (point === 'block-write') vi.mocked(writeSync).mockImplementationOnce(() => 0);
  if (point === 'block-rename') vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('injected rename'); });
  if (point === 'index-rename') {
    let calls = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => { if (++calls === 2) throw new Error('index rename'); fs.renameSync(from, to); });
  }
  if (point.includes('flush')) {
    const at = point === 'block-flush' ? 1 : point === 'block-directory-flush' ? 2
      : point === 'index-flush' ? (process.platform === 'win32' ? 2 : 3) : 4;
    let calls = 0;
    vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === at) throw new Error('injected fsync'); fs.fsyncSync(fd); });
  }
  if (point.includes('directory-flush') && process.platform === 'win32') return;
  expect(() => store.append(candidate)).toThrow();
  expect(() => store.read()).toThrow(/failed/); expect(() => store.append(candidate)).toThrow(/failed/);
  vi.mocked(fsyncSync).mockImplementation(fs.fsyncSync); store.close();
  const reopened = f.open();
  expect(reopened.read().envelopes.slice(0, 2)).toEqual([f.root, accepted]);
  // Rename may have installed the new index before its directory flush failed.
  expect(reopened.read().envelopes.length).toBe(point === 'index-directory-flush' ? 3 : 2);
  expect(reopened.append(candidate)).toBe(historyCheckpointEnvelopeId(candidate));
});

it.skipIf(process.platform === 'win32')('keeps an installed freeze after its directory flush fails', () => {
  const f = fixture(), store = f.open(true);
  let calls = 0;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === 2) throw new Error('freeze directory flush'); fs.fsyncSync(fd); });
  expect(() => store.freeze(createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner))).toThrow();
  expect(() => store.read()).toThrow('failed');
  vi.mocked(fsyncSync).mockImplementation(fs.fsyncSync); store.close();
  const reopened = f.open(false, { minimum: { sequence: 0, id: f.options.rootId, generationBarrier: 1 } });
  expect(() => reopened.append(f.next(f.root))).toThrow('frozen');
});

it('handles short writes and refuses use after an uncertain freeze flush', () => {
  const f = fixture(), store = f.open(true), delta = f.next(f.root);
  vi.mocked(writeSync).mockImplementationOnce(((fd: number, bytes: Uint8Array, offset: number) => fs.writeSync(fd, bytes, offset, 5)) as typeof writeSync);
  store.append(delta);
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('freeze flush'); });
  expect(() => store.freeze(createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner))).toThrow();
  expect(() => store.append(f.next(delta))).toThrow('failed');
  store.close(); expect(f.open().read().envelopes).toEqual([f.root, delta]);
});

it('cleans only abandoned ciphertext after validating the indexed chain, and enforces an external barrier floor', () => {
  const f = fixture(), store = f.open(true); store.close();
  const orphan = f.next(f.root), path = f.block(historyCheckpointEnvelopeId(orphan));
  writeFileSync(path, JSON.stringify(orphan)); writeFileSync(join(f.directory, `.block-${'a'.repeat(32)}.tmp`), 'partial ciphertext');
  expect(() => f.open(false, { minimum: { sequence: 0, id: f.options.rootId, generationBarrier: 1 } })).toThrow('anchor');
  expect(existsSync(path)).toBe(true);
  const reopened = f.open(); expect(existsSync(path)).toBe(false);
  expect(readdirSync(f.directory).some(name => name.endsWith('.tmp'))).toBe(false);
  reopened.close(); expect(() => reopened.append(orphan)).toThrow('closed');
});
