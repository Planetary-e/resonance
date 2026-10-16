import { afterEach, expect, it, vi } from 'vitest';
import { fsyncSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from '../history-ancestry-download.js';
import { historyAgreementFixture } from './fixtures/history-agreement-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const cleanup: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); cleanup.splice(0).reverse().forEach(f => f()); });
function fixture(length = 3) {
  const n = historyAgreementFixture('missing', length); cleanup.push(() => n.close());
  const roles = n.stores.map((store, i) => {
    const role = createHistoryCheckpointReplica({ context: n.context, store, signingKey: n.memberKeys[i] }); cleanup.push(() => role.close()); return role;
  });
  const requests: Array<{ generation: number; sequence: number }> = [];
  const options = { directory: join(n.directory, 'download'), localKey: n.localKey, context: n.context, signingKey: n.owner, proposal: n.a,
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${33000 + i}/history-checkpoint` })),
    transport: (async (member, frame) => { requests.push(frame.request); return roles[n.context.members.indexOf(member.publicKey)].exchange(frame); }) as NonNullable<Parameters<typeof createHistoryAncestryDownload>[0]['transport']> };
  function open(initialize = true, extra: Partial<Parameters<typeof createHistoryAncestryDownload>[0]> = {}) {
    const download = createHistoryAncestryDownload({ ...options, initialize, ...extra }); cleanup.push(() => download.close()); return download;
  }
  return { ...n, roles, requests, downloadOptions: options, open };
}

it('persists bounded progress, resumes only missing predecessors and yields the complete chronological chain', async () => {
  const n = fixture(); let download = n.open();
  expect(() => [...download.blocks()]).toThrow('incomplete');
  const first = await download.run({ maxBlocks: 2 }); expect(first.complete).toBe(false); expect(first.blocks).toBe(2);
  expect(first.next?.sequence).toBe(1); download.close(); n.requests.length = 0;
  download = n.open(false); expect(n.requests).toEqual([]);
  expect((await download.run()).complete).toBe(true);
  expect(n.requests.every(r => r.sequence <= 1)).toBe(true);
  expect([...download.blocks()]).toEqual(n.blocks);
  n.requests.length = 0; await download.run(); expect(n.requests).toEqual([]);
  expect(readFileSync(join(n.downloadOptions.directory, HISTORY_DOWNLOAD_FILENAME), 'utf8')).not.toContain(n.a.envelopeId);
});

it('keeps downloaded evidence through unavailable sources and rejects malformed or wrong-block replies', async () => {
  const n = fixture(), original = n.downloadOptions.transport; let fail = true;
  n.downloadOptions.transport = async (member, frame, signal) => {
    if (frame.request.sequence < 2 && fail) throw new Error('partition');
    if (member.publicKey === n.context.members[0]) return { forged: true };
    return original(member, frame, signal);
  };
  const download = n.open(); await expect(download.run()).rejects.toThrow('unavailable');
  expect(download.read().blocks).toBe(2); fail = false;
  expect((await download.run()).complete).toBe(true); expect([...download.blocks()]).toEqual(n.blocks);
});

it('refuses corrupt or missing indexed blocks and mismatched independent selection pins without resetting state', async () => {
  const n = fixture(), download = n.open(); await download.run({ maxBlocks: 1 }); download.close();
  const file = join(n.downloadOptions.directory, `${n.a.envelopeId.slice(7)}.block`), saved = readFileSync(file);
  writeFileSync(file, '{}'); expect(() => n.open(false)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('{}');
  rmSync(file); expect(() => n.open(false)).toThrow(); writeFileSync(file, saved);
  expect(() => n.open(false, { proposal: n.b })).toThrow();
  expect(n.open(false).read().blocks).toBe(1);
});

it('refuses an authentic but unselected owner block even inside a valid pinned-member response', async () => {
  const n = fixture(), fork = n.next(n.blocks[2]);
  n.downloadOptions.transport = async (member, frame) => {
    if (member.publicKey !== n.context.members[0]) throw new Error('offline');
    return createHistoryExchangeResponse(frame.request, 'block', { ...n.stores[0].describe(), envelopeId: historyCheckpointEnvelopeId(fork) },
      fork, n.context, n.memberKeys[0]);
  };
  const download = n.open(); await expect(download.run()).rejects.toThrow('unavailable');
  expect(download.read().blocks).toBe(0); expect(download.read().next?.envelopeId).toBe(n.a.envelopeId);
});

it.each([1, 2, 3, 4])('reopens after uncertain block/index fsync %i and adopts only the authentic pending block', async failure => {
  const n = fixture(); let download = n.open(), calls = 0;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === failure) throw new Error('download disk failure'); actualFsync(fd); });
  await expect(download.run({ maxBlocks: 1 })).rejects.toThrow('download disk failure');
  expect(() => download.read()).toThrow('reopen');
  vi.mocked(fsyncSync).mockImplementation(actualFsync); download.close(); download = n.open(false);
  expect((await download.run()).complete).toBe(true); expect([...download.blocks()]).toEqual(n.blocks);
});

it('retains progress at its block/byte budgets and refuses truncation as completion', async () => {
  const n = fixture(), download = n.open(true, { maxBlocks: 2 });
  await expect(download.run()).rejects.toThrow('capacity'); expect(download.read().blocks).toBe(2);
  expect(() => [...download.blocks()]).toThrow('incomplete'); download.close();
  const larger = n.open(false); expect((await larger.run()).complete).toBe(true);
  const other = fixture(), capped = other.open(true, { maxBytes: 4 * 1024 * 1024 + 1 });
  await expect(capped.run()).rejects.toThrow('capacity'); expect(capped.read().blocks).toBe(0);
});

it('bounds a cancellation-ignoring transport, aborts close and refuses overlapping attempts', async () => {
  const n = fixture(); n.downloadOptions.transport = async () => new Promise(() => {});
  let download = n.open(true, { timeoutMs: 200 });
  await expect(download.run()).rejects.toThrow('timed out'); download.close();
  download = n.open(false);
  const pending = download.run(), rejected = expect(pending).rejects.toThrow('cancelled');
  await expect(download.run()).rejects.toThrow('overlapping'); download.close(); await rejected;
});
