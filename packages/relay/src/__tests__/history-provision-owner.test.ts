import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHistoryProvisionReceipt, type HistoryProvisionReceipt } from '@resonance/core/history-provision';
import { createHistoryProvisionCoordinator, HISTORY_PROVISION_OWNER_FILENAME } from '../history-provision-coordinator.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function fixture(transport?: Parameters<typeof createHistoryProvisionCoordinator>[0]['transport']) {
  const n = historyProvisionFixture(); cleanup.push(() => n.close());
  const options = { directory: join(n.directory, 'owner'), localKey: n.localKey, context: n.context, signingKey: n.owner,
    root: n.continuation, members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${31000 + i}/history-agreement` })), transport };
  function owner(initialize = true, timeoutMs = 30_000) {
    const result = createHistoryProvisionCoordinator({ ...options, initialize, timeoutMs }); cleanup.push(() => result.close()); return result;
  }
  return { ...n, options, owner };
}

it('refuses stale receipts from a previous attempt and resumes only on an explicit fresh run', async () => {
  const n = fixture(); let stale = false; const replies = new Map<string, HistoryProvisionReceipt>();
  n.options.transport = async (member, request) => {
    if (stale) return replies.get(member.publicKey);
    const result = createHistoryProvisionReceipt(request, n.memberKeys[n.context.members.indexOf(member.publicKey)]);
    replies.set(member.publicKey, result); return result;
  };
  let owner = n.owner(); expect(await owner.run()).toHaveLength(4);
  stale = true; await expect(owner.run()).rejects.toThrow('Four authenticated');
  expect(owner.read().receipts).toEqual([]); const previous = owner.read().requests;
  owner.close(); owner = n.owner(false); expect(owner.read().requests).toEqual(previous);
  stale = false; expect(await owner.run()).toHaveLength(4);
  owner.close(); const path = join(n.options.directory, HISTORY_PROVISION_OWNER_FILENAME);
  const saved = readFileSync(path); writeFileSync(path, '{}'); expect(() => n.owner(false)).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('{}'); writeFileSync(path, saved);
});

it('cancels an unresponsive transport, closes in-flight work and refuses overlapping attempts', async () => {
  const signals: AbortSignal[] = [];
  const n = fixture(async (_member, _request, signal) => { signals.push(signal); return new Promise(() => {}); });
  const owner = n.owner(), control = new AbortController();
  const pending = owner.run(control.signal), rejected = expect(pending).rejects.toThrow('cancelled');
  await expect(owner.run()).rejects.toThrow('active');
  control.abort(); await rejected; expect(signals.every(s => s.aborted)).toBe(true);
  const again = owner.run(), closed = expect(again).rejects.toThrow('cancelled');
  owner.close(); await closed;
});

it('enforces its whole-attempt deadline even when a custom transport ignores cancellation', async () => {
  const n = fixture(async () => new Promise(() => {})), owner = n.owner(true, 200);
  await expect(owner.run()).rejects.toThrow('timed out'); expect(owner.read().receipts).toEqual([]);
  expect(owner.read().requests).toHaveLength(5);
});

it('does not count a repeated valid signature from one volunteer as four members', async () => {
  const n = fixture(); let first: HistoryProvisionReceipt | undefined;
  n.options.transport = async (_member, request) => {
    first ??= createHistoryProvisionReceipt(request, n.memberKeys[n.context.members.indexOf(request.replica)]);
    return first;
  };
  await expect(n.owner().run()).rejects.toThrow('Four authenticated');
});
