import { afterEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ afterSigning: undefined as undefined | (() => void) }));
vi.mock('@resonance/core/history-exchange', async importOriginal => {
  const actual = await importOriginal<typeof import('@resonance/core/history-exchange')>();
  return { ...actual, createHistoryExchangeRequest(...args: Parameters<typeof actual.createHistoryExchangeRequest>) {
    const request = actual.createHistoryExchangeRequest(...args); hooks.afterSigning?.(); return request;
  } };
});
import { discoverHistoryContinuations } from '../history-continuation-discovery.js';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

afterEach(() => { hooks.afterSigning = undefined; vi.restoreAllMocks(); });

it.each(['deadline', 'cancellation'] as const)('does not dispatch a discovery request when %s occurs during signing', async boundary => {
  const n = historyCheckpointFixture(), controller = new AbortController();
  let monotonic = performance.now(), calls = 0, prepared = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  hooks.afterSigning = () => { prepared++; if (boundary === 'deadline') monotonic += 1001; else controller.abort(); };
  await expect(discoverHistoryContinuations({ context: n.context, signingKey: n.owner,
    genesisId: historyCheckpointEnvelopeId(n.root), timeoutMs: 1000, signal: controller.signal,
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${28000 + i}/history-checkpoint` })),
    transport: async () => { calls++; return new Promise(() => {}); },
  })).rejects.toThrow(boundary === 'deadline' ? 'timed out' : 'cancelled');
  expect(prepared).toBe(1); expect(calls).toBe(0); expect(n.owner.secretKey.some(byte => byte !== 0)).toBe(true);
});
