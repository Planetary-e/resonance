import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createSearchRequestV2, generatePublicationKeyMaterial } from '@resonance/core';
import { openPrivateRequestOutbox, PRIVATE_REQUEST_HOLD_LIFETIME_MS, type PrivateRequestOutbox, type PrivateRequestResult } from '../private-request-outbox.js';
import { createRelayClient } from '../relay-client.js';
vi.mock('../relay-client.js', () => ({ createRelayClient: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const route = { relayUrl: 'ws://[::1]:45001/', fallbackUrls: [], privateEntryUrls: ['ws://127.0.0.1:45000/'] };
const intent = { kind: 'search' as const, text: 'A quiet saved search', itemType: 'need' as const, fingerprint: Buffer.alloc(64, 0x8a).toString('base64') };
const result: PrivateRequestResult = { kind: 'search', results: [] };
let directory: string; let path: string; let key: Buffer; let boxes: PrivateRequestOutbox[];
let execute: ReturnType<typeof vi.fn<Parameters<typeof openPrivateRequestOutbox>[0]['execute']>>;
const provider = vi.fn();
function open(extra: Partial<Parameters<typeof openPrivateRequestOutbox>[0]> = {}) {
  const box = openPrivateRequestOutbox({ path, encryptionKey: key, admissionCapabilityProvider: provider, execute, ...extra }); boxes.push(box); return box;
}
beforeEach(() => {
  vi.clearAllMocks(); directory = mkdtempSync(join(tmpdir(), 'private-holds-')); path = join(directory, 'outbox'); key = randomBytes(32); boxes = [];
  execute = vi.fn(async () => result);
  vi.mocked(createRelayClient).mockReturnValue({ disconnect: vi.fn(), searchV2: vi.fn(async () => ({ results: [] })) } as unknown as ReturnType<typeof createRelayClient>);
});
afterEach(() => { for (const box of boxes) box.close(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
describe('private request intents', () => {
  it('encrypts inputs and routes, holds across restarts without timers, and expires locally', async () => {
    vi.useFakeTimers(); const box = open(); const held = box.hold(intent, route);
    const raw = readFileSync(path, 'utf8'); for (const secret of [intent.text, intent.fingerprint, route.relayUrl]) expect(raw).not.toContain(secret);
    expect(vi.getTimerCount()).toBe(0); box.close();
    expect(() => open({ encryptionKey: randomBytes(32) })).toThrow();
    const restored = open(); expect(restored.list()[0].state).toBe('held');
    vi.advanceTimersByTime(PRIVATE_REQUEST_HOLD_LIFETIME_MS + 1);
    expect(restored.list()[0]).toMatchObject({ state: 'expired', mayHaveBeenSent: false });
    await expect(restored.release(held.id)).rejects.toThrow('current state');
    expect(execute).not.toHaveBeenCalled(); expect(createRelayClient).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('persists mailbox pause with the hold and never resumes on cancellation, expiry, removal, or reopen', () => {
    vi.useFakeTimers();
    const mailbox = { kind: 'publication-mailbox' as const, publicationId: generatePublicationKeyMaterial().publicationId };
    const box = open(); const held = box.hold(mailbox, route);
    expect(box.automaticMailboxes()).toBe(false); expect(() => box.hold(mailbox, route)).toThrow('pending');
    expect(() => box.setAutomaticMailboxes(true)).toThrow('pending');
    box.cancel(held.id); box.remove(held.id); box.close();
    const restored = open(); expect(restored.automaticMailboxes()).toBe(false);
    restored.setAutomaticMailboxes(true); expect(restored.automaticMailboxes()).toBe(true);
    restored.hold(mailbox, route); vi.advanceTimersByTime(PRIVATE_REQUEST_HOLD_LIFETIME_MS + 1);
    expect(restored.list()[0].state).toBe('expired'); expect(restored.automaticMailboxes()).toBe(false);
    expect(createRelayClient).not.toHaveBeenCalled();
  });
  it('refuses capacity before generating any request, and preserves older work', () => {
    const box = open({ maxEntries: 1 }); const held = box.hold(intent, route);
    expect(() => box.hold(intent, route)).toThrow('full'); expect(box.list()).toEqual([held]); box.close();
    const bytes = readFileSync(path).length; const small = open({ maxBytes: bytes + 100 });
    expect(() => small.hold(intent, route)).toThrow('capacity'); expect(small.list()).toEqual([held]);
    expect(execute).not.toHaveBeenCalled(); expect(createRelayClient).not.toHaveBeenCalled();
  });
  it('generates fresh signed requests only on explicit attempts and persists completed results', async () => {
    const requests: ReturnType<typeof createSearchRequestV2>[] = [];
    execute.mockImplementation(async (_intent, client) => {
      requests.push(createSearchRequestV2({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
        fingerprint: Buffer.from(intent.fingerprint, 'base64'), itemType: 'need', k: 10, threshold: 0.65 }));
      await client.searchV2({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: Buffer.alloc(64), itemType: 'need', k: 10, threshold: 0.65 });
      if (requests.length === 1) throw new Error('Reply lost');
      return result;
    });
    const box = open(); const held = box.hold(intent, route); expect(requests).toHaveLength(0);
    await expect(box.release(held.id)).rejects.toThrow('Reply lost');
    expect(box.list()[0].state).toBe('outcome-unknown'); box.close();
    const restored = open(); expect(requests).toHaveLength(1);
    expect(await restored.release(held.id)).toEqual(result);
    expect(requests[1].searchId).not.toBe(requests[0].searchId);
    expect(restored.list()[0]).toMatchObject({ state: 'completed', attempts: 2, result });
    expect(createRelayClient).toHaveBeenCalledWith({ ...route, admissionCapabilityProvider: provider });
  });
  it('cancels before execution without generating a signed request', async () => {
    const box = open(); const held = box.hold(intent, route); const pending = box.release(held.id);
    const failure = expect(pending).rejects.toThrow('cancelled'); box.cancel(held.id); await failure;
    expect(box.list()[0]).toMatchObject({ state: 'cancelled', mayHaveBeenSent: false }); expect(execute).not.toHaveBeenCalled();
  });
  it('bounds a stalled release and prevents late follow-up traffic after cancellation', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const network = vi.fn(async () => ({ results: [] }));
    vi.mocked(createRelayClient).mockReturnValue({ disconnect: vi.fn(), searchV2: network } as unknown as ReturnType<typeof createRelayClient>);
    execute.mockImplementation(async (_intent, client) => {
      await client.searchV2({} as never);
      await new Promise<void>(resolve => { resume = resolve; });
      await client.searchV2({} as never); return result;
    });
    const box = open(); const held = box.hold(intent, route); const pending = box.release(held.id);
    const failure = expect(pending).rejects.toThrow('ten-second');
    await vi.advanceTimersByTimeAsync(10_000); await failure;
    expect(box.list()[0].state).toBe('outcome-unknown'); resume(); await vi.advanceTimersByTimeAsync(0);
    expect(network).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects concurrent release and never lets a late completion change reopened state', async () => {
    let finish!: (result: PrivateRequestResult) => void;
    execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const box = open(); const held = box.hold(intent, route); const pending = box.release(held.id);
    const failed = expect(pending).rejects.toThrow(); await Promise.resolve();
    await expect(box.release(held.id)).rejects.toThrow('current state'); box.close();
    const restored = open(); finish(result); await failed;
    expect(restored.list()[0]).toMatchObject({ state: 'outcome-unknown', attempts: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('limits releases to four and leaves excess work held without creating a client', async () => {
    execute.mockImplementation(() => new Promise(() => {}));
    const box = open(); const held = Array.from({ length: 5 }, () => box.hold(intent, route));
    const attempts = held.slice(0, 4).map(entry => expect(box.release(entry.id)).rejects.toThrow('cancelled'));
    await expect(box.release(held[4].id)).rejects.toThrow('Four saved requests');
    expect(box.list()[4]).toMatchObject({ state: 'held', attempts: 0, mayHaveBeenSent: false });
    expect(createRelayClient).toHaveBeenCalledTimes(4);
    for (const entry of held.slice(0, 4)) box.cancel(entry.id);
    await Promise.all(attempts);
  });
  it('refuses to send when saving release intent fails', async () => {
    const box = open(); const held = box.hold(intent, route);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    await expect(box.release(held.id)).rejects.toThrow('disk unavailable');
    expect(createRelayClient).not.toHaveBeenCalled(); box.close(); expect(open().list()[0].state).toBe('held');
  });
});
