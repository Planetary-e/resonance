import { expect, it } from 'vitest';
import { generateIdentity } from '@resonance/core';
import { HistoryLocalExchange } from '../history-local-exchange.js';
import { HistoryLinkBudget } from '../history-relay-link.js';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { parseRelayHistoryHealth } from '../history-health.js';

it('copies bounded local inputs and outputs, preserves protocol methods and rejects malformed or oversized values', async () => {
  const budget = new HistoryLinkBudget(), seen: unknown[] = [], output = { retained: true };
  const service = new HistoryLocalExchange(budget, (method, value) => { seen.push({ method, value }); return output; }, 1000);
  const input = { value: 1 }, pending = service.request('checkpoint', input, new AbortController().signal, 100);
  input.value = 2; const result = await pending; output.retained = false;
  expect(result).toEqual({ retained: true }); expect(seen).toEqual([{ method: 'checkpoint', value: { value: 1 } }]);
  for (const value of [undefined, { oversized: 'x'.repeat(1024 * 1024) }]) await expect(service.request('provision', value, new AbortController().signal, 100)).rejects.toThrow('bound');
  await expect(service.request('checkpoint', {}, new AbortController().signal, 1)).rejects.toThrow('bound');
  await expect(service.request('checkpoint', {}, AbortSignal.abort(), 100)).rejects.toThrow('unavailable');
  service.close(); await expect(service.request('checkpoint', {}, new AbortController().signal, 100)).rejects.toThrow('unavailable');
});

it('keeps cancelled, uncooperative handlers charged to the same global eight-operation cap until they actually finish', async () => {
  const budget = new HistoryLinkBudget(), releases: Array<() => void> = [], signals: AbortSignal[] = [];
  const service = new HistoryLocalExchange(budget, (_method, _frame, context) => {
    signals.push(context.signal); return new Promise(resolve => releases.push(() => resolve({ late: true })));
  }, 1000);
  const operations = Array.from({ length: 8 }, () => service.request('checkpoint', {}, new AbortController().signal, 100).catch(error => error));
  await Promise.resolve(); expect(releases).toHaveLength(8); expect(budget.usage().operations).toBe(8);
  await expect(service.request('checkpoint', {}, new AbortController().signal, 100)).rejects.toThrow('capacity');
  service.close(); expect((await Promise.all(operations)).every(value => value instanceof Error)).toBe(true);
  expect(signals.every(signal => signal.aborted)).toBe(true); expect(budget.usage().operations).toBe(8);
  releases.forEach(release => release()); await new Promise(resolve => setImmediate(resolve));
  expect(budget.usage()).toEqual({ bytes: 0, operations: 0 });
});

it('honors the outer deadline without allowing a late handler result to renew it', async () => {
  const budget = new HistoryLinkBudget(); let release!: () => void;
  const service = new HistoryLocalExchange(budget, () => new Promise(resolve => { release = () => resolve({ late: true }); }), 1000);
  const started = performance.now(), alive = setTimeout(() => {}, 1000);
  try { await expect(service.request('checkpoint', {}, new AbortController().signal, 100, started + 50)).rejects.toThrow('timed out'); }
  finally { clearTimeout(alive); }
  expect(performance.now() - started).toBeLessThan(1000); expect(budget.usage().operations).toBe(1);
  release(); await new Promise(resolve => setImmediate(resolve)); expect(budget.usage().operations).toBe(0); service.close();
});

it('routes only an exact pinned local identity and refuses rebinding or an unenrolled local member', async () => {
  const localId = generateIdentity().did, bridge = generateIdentity().did, key = Buffer.alloc(32, 1).toString('base64url');
  const members = [{ publicKey: key, relayId: localId, viaRelayId: bridge }], member = { publicKey: key, endpoint: 'wss://never-dial.invalid/history-checkpoint' };
  const owner = new HistoryRelayRouter({ members, acceptedRelayIds: [bridge], handler: (method, frame) => ({ method, frame }) });
  const frame = { request: { replica: key, action: 'head' } } as Parameters<typeof owner.checkpoint>[1];
  owner.bindLocalIdentity(localId); owner.bindLocalIdentity(localId);
  const health = { owner: null, volunteer: null, transport: { state: 'available', usage: owner.health() } };
  expect(parseRelayHistoryHealth(health)?.transport).toMatchObject({ usage: { configuredLocalMembers: 1 } });
  for (const count of [0, 2, '1', undefined]) expect(parseRelayHistoryHealth({ ...health, transport: { ...health.transport,
    usage: { ...health.transport.usage, configuredLocalMembers: count } } })?.transport).toEqual({ state: 'unavailable' });
  expect(JSON.stringify(health)).not.toContain(localId);
  expect(await owner.checkpoint(member, frame, new AbortController().signal)).toEqual({ method: 'checkpoint', frame });
  expect(() => owner.bindLocalIdentity(bridge)).toThrow('binding');
  await expect(owner.checkpoint({ ...member, publicKey: Buffer.alloc(32, 2).toString('base64url') }, frame, new AbortController().signal)).rejects.toThrow('target');
  const missing = new HistoryRelayRouter({ members }); expect(() => missing.bindLocalIdentity(localId)).toThrow('enrolled'); missing.close();
  owner.close(); await expect(owner.checkpoint(member, frame, new AbortController().signal)).rejects.toThrow('unavailable');
});
