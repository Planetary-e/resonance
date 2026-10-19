import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyArchivePageDigest, encodeAdmissionPolicyArchivePage } from '@resonance/core/admission-policy-archive';
import { ADMISSION_POLICY_CHUNK_BYTES } from '@resonance/core/admission-policy-transfer';
import { createPolicyObserverRemoteOperation, POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES } from '../policy-observer-page-transfer.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

let fixture: Awaited<ReturnType<typeof policyObserverFixture>>, bytes: Uint8Array, digest: string;
beforeAll(async () => {
  fixture = await policyObserverFixture();
  const entry = structuredClone(fixture.body.keys[0]);
  entry.profile.relayUrls = ['wss://relay.example/' + 'p'.repeat(400)];
  bytes = await encodeAdmissionPolicyArchivePage({ version: 1, kind: 'admission-policy-archive-page',
    contextId: admissionPolicyObserversId(fixture.context), previous: null, index: 0, firstEntry: 0,
    entries: Array.from({ length: 64 }, () => entry) });
  digest = admissionPolicyArchivePageDigest(bytes);
  expect(Math.ceil(bytes.length / ADMISSION_POLICY_CHUNK_BYTES)).toBe(2);
});
afterAll(() => fixture.close());
afterEach(() => vi.useRealTimers());
function reply(request: unknown) {
  const r = request as { index: number };
  return { ...r, type: 'admission_policy_archive_page_reply', bytes: bytes.length, count: 2,
    data: Buffer.from(bytes.subarray(r.index * ADMISSION_POLICY_CHUNK_BYTES, (r.index + 1) * ADMISSION_POLICY_CHUNK_BYTES)).toString('base64url') };
}
function setup(exchange: Parameters<typeof createPolicyObserverRemoteOperation>[0]['archive']['exchange'],
  settings: { maxRequests?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
  const ownKey = fixture.context.members[4].publicKey;
  const deadline = performance.now() + 300;
  const operation = createPolicyObserverRemoteOperation({ deadline, signal: settings.signal, archive: { exchange, ...settings } });
  return { operation, deadline, page: () => operation.page(fixture.context, fixture.context.genesis, digest, ownKey) };
}
function clocks() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

it('restarts a sliced two-chunk page after all offline peers, within the original deadline', async () => {
  clocks();
  const calls: Array<[number, number]> = [];
  const { operation, deadline, page } = setup(async (member, request) => {
    const index = fixture.context.members.findIndex(m => m.publicKey === member.publicKey);
    const chunk = (request as { index: number }).index;
    calls.push([index, chunk]);
    if (index !== 0) throw new Error('offline');
    if (chunk === 1) await delay(100);
    return reply(request);
  });
  try {
    const pending = page();
    await vi.advanceTimersByTimeAsync(200);
    expect(Buffer.from(await pending).equals(bytes)).toBe(true);
    expect(calls).toEqual([[0, 0], [0, 1], [1, 0], [2, 0], [3, 0], [0, 0], [0, 1]]);
    expect(operation.deadline).toBe(deadline);
    expect(performance.now()).toBeLessThan(deadline);
  } finally { operation.close(); }
});

it.each(['silent', 'chunk-then-stall'])('gives a healthy fallback its first opportunity after %s', async mode => {
  clocks();
  const calls: string[] = [];
  const { operation, page } = setup(async (member, request) => {
    calls.push(member.publicKey);
    if (member.publicKey === fixture.context.members[0].publicKey && (mode === 'silent' || (request as { index: number }).index === 1)) {
      return new Promise(() => {});
    }
    return reply(request);
  });
  try {
    const pending = page(); await vi.advanceTimersByTimeAsync(100);
    expect(Buffer.from(await pending).equals(bytes)).toBe(true);
    expect(calls).toEqual([...(mode === 'silent' ? [fixture.context.members[0].publicKey] : Array(2).fill(fixture.context.members[0].publicKey)),
      ...Array(2).fill(fixture.context.members[1].publicKey)]);
  } finally { operation.close(); }
});

it.each(['schema', 'head', 'digest', 'unavailable', 'authentication', 'timed out'])('never retries a %s failure into success', async mode => {
  const calls = new Map<string, number>();
  const { operation, page } = setup(async (member, request) => {
    const count = (calls.get(member.publicKey) ?? 0) + 1; calls.set(member.publicKey, count);
    if (member.publicKey !== fixture.context.members[0].publicKey) throw new Error('offline');
    if (count > 2) return reply(request);
    if (mode === 'unavailable' || mode === 'authentication' || mode === 'timed out') throw new Error(mode);
    if (mode === 'schema') return { ...reply(request), extra: true };
    if (mode === 'head') return { ...reply(request), head: { ...fixture.context.genesis, revision: 999 } };
    const valid = reply(request), corrupt = Buffer.from(valid.data, 'base64url'); corrupt[0] ^= 1;
    return { ...valid, data: corrupt.toString('base64url') };
  });
  try {
    await expect(page()).rejects.toThrow('No committed pinned observer');
    expect(calls.get(fixture.context.members[0].publicKey)).toBe(mode === 'digest' ? 2 : 1);
    expect([...calls.keys()]).toHaveLength(4);
  } finally { operation.close(); }
});

it.each(['healthy', 'offline'])('shares the retry remainder fairly and attempts each candidate once with a %s second candidate', async mode => {
  clocks();
  const attempts = [0, 0, 0, 0], calls: Array<[number, number]> = [];
  const { operation, page } = setup(async (member, request) => {
    const peer = fixture.context.members.findIndex(m => m.publicKey === member.publicKey), chunk = (request as { index: number }).index;
    calls.push([peer, chunk]);
    if (chunk === 0) attempts[peer]++;
    if (peer > 1 || (peer === 1 && attempts[peer] === 2 && mode === 'offline')) throw new Error('offline');
    if (chunk === 1) {
      if (peer === 1 && attempts[peer] === 2) await delay(30);
      else return new Promise(() => {});
    }
    return reply(request);
  });
  try {
    const pending = mode === 'offline' ? expect(page()).rejects.toThrow('No committed pinned observer') : page();
    await vi.advanceTimersByTimeAsync(260);
    const result = await pending;
    if (mode === 'healthy') expect(Buffer.from(result as Uint8Array).equals(bytes)).toBe(true);
    expect(attempts).toEqual([2, 2, 1, 1]);
    expect(calls).toEqual([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [0, 0], [0, 1], [1, 0],
      ...(mode === 'healthy' ? [[1, 1]] : [])]);
  } finally { operation.close(); }
});

it.each(['requests', 'bytes'])('retains exact cumulative %s reservations across pages and both passes', async bound => {
  clocks();
  const capacity = bound === 'requests' ? 16 : 6;
  let warmup = true, calls = 0;
  const { operation, page } = setup(async (member, request) => {
    calls++;
    if (!warmup) {
      if (member.publicKey !== fixture.context.members[0].publicKey) throw new Error('offline');
      if ((request as { index: number }).index === 1) return new Promise(() => {});
    }
    return reply(request);
  }, bound === 'requests' ? { maxRequests: capacity } : { maxBytes: capacity * POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES });
  try {
    for (let i = 0; i < (capacity - 6) / 2; i++) await page();
    warmup = false;
    const pending = expect(page()).rejects.toThrow('budget exhausted');
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(calls).toBe(capacity);
    await expect(page()).rejects.toThrow('budget exhausted'); expect(calls).toBe(capacity);
  } finally { operation.close(); }
});

it.each(['cancel', 'deadline'])('rejects %s and late transport results without another dispatch or page publication', async mode => {
  clocks();
  const controller = new AbortController(); let release!: (value: unknown) => void, held: unknown, calls = 0;
  const { operation, page } = setup(async (_member, request) => {
    calls++; held = request; return new Promise(resolve => { release = resolve; });
  }, { signal: controller.signal });
  try {
    let published = false;
    const pending = expect(page().then(value => { published = true; return value; })).rejects.toThrow(/cancelled|timed out/);
    if (mode === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(300);
    await pending;
    const dispatched = calls; release(reply(held)); await vi.advanceTimersByTimeAsync(500);
    expect(published).toBe(false); expect(calls).toBe(dispatched);
    await expect(page()).rejects.toThrow(/cancelled|timed out/);
  } finally { operation.close(); }
});
