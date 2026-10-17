import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, renameSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicationRecord, generatePublicationKeyMaterial, type AckPayload } from '@resonance/core';
import { openPublicationOutbox, type PublicationOutbox } from '../publication-outbox.js';
import { PrivateOperationError } from '../private-operation.js';
import { createRelayClient } from '../relay-client.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
vi.mock('../relay-client.js', () => ({ createRelayClient: vi.fn() }));
const route = { relayUrl: 'ws://[::1]:49121/', fallbackUrls: [], privateEntryUrls: ['ws://127.0.0.1:49120/'] };
let directory: string;
let path: string;
let key: Buffer;
let outboxes: PublicationOutbox[];
const provider = vi.fn();
function open(extra: Partial<Parameters<typeof openPublicationOutbox>[0]> = {}) {
  const result = openPublicationOutbox({ path, encryptionKey: key, admissionCapabilityProvider: provider, ...extra });
  outboxes.push(result); return result;
}
function record(expiresAt = Date.now() + 60_000) {
  return createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(0x4b), itemType: 'offer', createdAt: Date.now(), expiresAt }, generatePublicationKeyMaterial());
}
function client(outcome: 'not-sent' | 'unknown' = 'not-sent') {
  let resolve!: (ack: AckPayload) => void; let reject!: (cause: Error) => void;
  const submit = vi.fn(() => new Promise<AckPayload>((yes, no) => { resolve = yes; reject = no; }));
  const disconnect = vi.fn(() => reject?.(new PrivateOperationError('PRIVATE_OPERATION_CANCELLED', outcome, new Error('cancelled'))));
  vi.mocked(createRelayClient).mockReturnValue({ submitPublicationOperation: submit, disconnect } as unknown as ReturnType<typeof createRelayClient>);
  return { submit, disconnect, resolve: (ack: AckPayload) => resolve(ack), reject: (cause: Error) => reject(cause) };
}
beforeEach(() => {
  vi.clearAllMocks(); directory = mkdtempSync(join(tmpdir(), 'publication-outbox-'));
  path = join(directory, 'outbox.json'); key = randomBytes(32); outboxes = [];
});
afterEach(() => { for (const box of outboxes) box.close(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

describe('explicit encrypted publication holds', () => {
  it('encrypts record, route, and local keys; reopening and expiry never construct a network client or reserve tokens', () => {
    vi.useFakeTimers();
    const box = open(); const publication = record();
    const held = box.hold(publication, route, 'secret-local-publication-keys');
    const bytes = readFileSync(path, 'utf8');
    for (const secret of [publication.publicationId, publication.fingerprint.value, route.relayUrl, 'secret-local-publication-keys']) expect(bytes).not.toContain(secret);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => open()).toThrow('already open');
    box.close();
    const reopened = open(); expect(reopened.read(held.id).record).toEqual(publication);
    expect(reopened.list()[0].state).toBe('held');
    vi.advanceTimersByTime(60_001);
    expect(reopened.list()[0]).toMatchObject({ state: 'expired', mayHaveBeenSent: false });
    expect(vi.getTimerCount()).toBe(0); expect(createRelayClient).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });

  it('refuses the wrong key and authenticated-data corruption without replacing the saved state', () => {
    const box = open(); box.hold(record(), route); box.close();
    const original = readFileSync(path);
    expect(() => open({ encryptionKey: randomBytes(32) })).toThrow();
    expect(readFileSync(path)).toEqual(original);
    const data = JSON.parse(original.toString()); data.tag = Buffer.alloc(16).toString('base64url');
    writeFileSync(path, JSON.stringify(data));
    expect(() => open()).toThrow();
    writeFileSync(path, original); expect(open().list()[0].state).toBe('held');
  });

  it('refuses count and encrypted-byte overflow without deleting older work or starting delivery', () => {
    const box = open({ maxEntries: 1 }); const held = box.hold(record(), route);
    expect(() => box.hold(record(), route)).toThrow('full');
    expect(box.list()).toEqual([held]); box.close();
    const bytes = statSync(path).size;
    const limited = open({ maxBytes: bytes + 200 });
    expect(() => limited.hold(record(), route, 'x'.repeat(500))).toThrow('capacity');
    expect(limited.list()).toEqual([held]);
    limited.cancel(held.id); limited.remove(held.id); expect(limited.list()).toEqual([]);
    expect(createRelayClient).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });

  it('pins the exact signed record and route, refuses concurrent release, and preserves a successful receipt', async () => {
    const box = open(); const publication = record(); const pinned = structuredClone(route);
    const held = box.hold(publication, pinned); pinned.relayUrl = 'ws://localhost:1/';
    const network = client(); const pending = box.release(held.id);
    expect(box.list()[0].state).toBe('sending');
    await expect(box.release(held.id)).rejects.toThrow('current state');
    expect(createRelayClient).toHaveBeenCalledWith({ ...route, admissionCapabilityProvider: provider });
    expect(network.submit).toHaveBeenCalledExactlyOnceWith(publication);
    network.resolve({ status: 'ok', ref: publication.publicationId }); await pending;
    box.close(); expect(open().list()[0].state).toBe('delivered');
  });

  it.each(['not-sent', 'unknown'] as const)('records cancellation with %s outcome honestly', async outcome => {
    const box = open(); const held = box.hold(record(), route); client(outcome);
    const sending = box.release(held.id); const failed = expect(sending).rejects.toThrow('cancelled');
    box.cancel(held.id); await failed;
    expect(box.list()[0]).toMatchObject({ state: outcome === 'not-sent' ? 'cancelled' : 'outcome-unknown', mayHaveBeenSent: outcome === 'unknown' });
    if (outcome === 'unknown') {
      expect(() => box.cancel(held.id)).toThrow('unsent');
      const second = client(); const retry = box.release(held.id); const failure = expect(retry).rejects.toThrow('cancelled');
      box.cancel(held.id); await failure;
      expect(second.submit).toHaveBeenCalledOnce();
      expect(box.list()[0]).toMatchObject({ state: 'outcome-unknown', mayHaveBeenSent: true });
    }
  });

  it('recovers interrupted sends as unknown, never replays, and ignores the old completion after reopen', async () => {
    const box = open(); const held = box.hold(record(), route); client();
    const pending = box.release(held.id); const failed = expect(pending).rejects.toThrow();
    box.close(); const reopened = open(); await failed;
    expect(reopened.list()[0]).toMatchObject({ state: 'outcome-unknown', mayHaveBeenSent: true });
    expect(createRelayClient).toHaveBeenCalledTimes(1);
    expect(() => reopened.remove(held.id)).toThrow('Only completed');
  });

  it('bounds concurrent releases and cancels only the selected publication', async () => {
    const box = open(); const pending = []; const networks = []; const records = [];
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const publication = record(); records.push(publication);
      const held = box.hold(publication, route); ids.push(held.id);
      networks.push(client()); pending.push(box.release(held.id));
    }
    const results = Promise.allSettled(pending);
    const fifth = box.hold(record(), route);
    await expect(box.release(fifth.id)).rejects.toThrow('Four saved publications');
    expect(box.read(fifth.id).delivery.state).toBe('held'); expect(createRelayClient).toHaveBeenCalledTimes(4);
    box.cancel(ids[0]);
    for (let i = 1; i < 4; i++) {
      expect(networks[i].disconnect).not.toHaveBeenCalled();
      networks[i].resolve({ status: 'ok', ref: records[i].publicationId });
    }
    expect((await results).map(result => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('never starts a client when persisting the send intent fails', async () => {
    const box = open(); const held = box.hold(record(), route); client();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('disk failure'); });
    await expect(box.release(held.id)).rejects.toThrow('disk failure');
    expect(createRelayClient).not.toHaveBeenCalled(); box.close();
    expect(open().list()[0]).toMatchObject({ state: 'held', mayHaveBeenSent: false });
  });

  it('keeps delivery unknown after a receipt cannot be persisted', async () => {
    const box = open(); const publication = record(); const held = box.hold(publication, route); const network = client();
    const pending = box.release(held.id); const failed = expect(pending).rejects.toThrow('disk failure');
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('disk failure'); });
    network.resolve({ status: 'ok', ref: publication.publicationId }); await failed;
    expect(() => box.list()).toThrow('close and reopen'); box.close();
    expect(open().list()[0]).toMatchObject({ state: 'outcome-unknown', mayHaveBeenSent: true });
  });

  it('refuses expired releases and direct routes without any client or capability use', async () => {
    vi.useFakeTimers(); let now = Date.now(); const box = open({ now: () => now });
    expect(() => box.hold(record(), { ...route, privateEntryUrls: [] })).toThrow('private relay route');
    const held = box.hold(record(), route); now += 60_001;
    await expect(box.release(held.id)).rejects.toThrow('current state');
    expect(createRelayClient).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
});
