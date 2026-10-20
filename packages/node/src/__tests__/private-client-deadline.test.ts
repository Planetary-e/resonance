import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayClient } from '../relay-client.js';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';

vi.mock('../relay-discovery-client.js', () => ({ discoverRelayContactV1: vi.fn() }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('private client deadline across entry fallbacks', () => {
  it('does not reset the budget for another entry, reserve a token, or start a destination fallback after expiry', async () => {
    const attempted: string[] = [];
    const signals: AbortSignal[] = [];
    vi.mocked(discoverRelayContactV1).mockImplementation((hint, options) => new Promise((_, reject) => {
      attempted.push(hint.endpoint);
      signals.push(options!.signal!);
      const timer = setTimeout(() => {
        options!.signal!.removeEventListener('abort', abort);
        reject(new Error('Stalled entry'));
      }, 6_000);
      function abort() { clearTimeout(timer); reject(options!.signal!.reason); }
      options!.signal!.addEventListener('abort', abort, { once: true });
    }));
    const capability = vi.fn();
    const client = createRelayClient({
      relayUrl: 'ws://[::1]:50100/', fallbackUrls: ['ws://[::1]:50101/'],
      privateEntryUrls: ['ws://127.0.0.1:50200/', 'ws://127.0.0.1:50201/'],
      privateTraffic: { batchWindowMs: 1_000, jitterMs: 0 },
      admissionCapabilityProvider: capability,
    });
    const pending = client.searchV2({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64),
      itemType: 'need', k: 5, threshold: 0.9,
    });
    const expired = expect(pending).rejects.toMatchObject({ code: 'PRIVATE_OPERATION_TIMEOUT', outcome: 'not-sent' });
    await vi.advanceTimersByTimeAsync(10_000);
    await expired;
    expect(new Set(attempted).size).toBe(2);
    expect(attempted).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(capability).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempted).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
