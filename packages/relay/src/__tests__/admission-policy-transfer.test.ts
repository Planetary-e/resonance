import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { policyTransferFixture } from '../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyChunkRequest } from '@resonance/core/admission-policy-transfer';
import { createAdmissionPolicyTransferResponder } from '../admission-policy-transfer.js';

let n: Awaited<ReturnType<typeof policyTransferFixture>>;
beforeAll(async () => { n = await policyTransferFixture(); }); afterAll(() => n.close()); afterEach(() => vi.useRealTimers());
const request = () => createAdmissionPolicyChunkRequest(n.context, n.context.genesis);

it('caches one bounded signed artifact, rejects arbitrary requests before reading history and never claims freshness', async () => {
  const source = vi.fn(async () => n.advance), responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: source });
  try {
    await expect(responder.exchange({ ...request(), endpoint: 'wss://attacker.example/' })).rejects.toThrow(); expect(source).not.toHaveBeenCalled();
    const first = await responder.exchange(request());
    expect(await responder.exchange({ ...request(), artifact: first.artifact })).toEqual(first); expect(source).toHaveBeenCalledTimes(1);
    expect(responder.health()).toMatchObject({ operations: 0, cachedArtifacts: 1, cachedBytes: first.bytes });
    await expect(responder.exchange({ ...request(), artifact: 'a'.repeat(64) })).rejects.toThrow('no longer available');
    expect(source).toHaveBeenCalledTimes(1);
  } finally { await responder.close(); }
  await expect(responder.exchange(request())).rejects.toThrow('closed');
});

it('retains the preparation slot after cancellation until an uncooperative history source actually settles', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const source = vi.fn(() => { entered(); return new Promise(r => { release = r; }); });
  const responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: source });
  const controller = new AbortController(), result = responder.exchange(request(), controller.signal);
  const cancelled = expect(result).rejects.toThrow('cancelled'); await started; controller.abort(); await cancelled;
  expect(responder.health().operations).toBe(1); await expect(responder.exchange(request())).rejects.toThrow('busy');
  let closed = false; const closing = responder.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  release(n.advance); await closing; expect(responder.health()).toMatchObject({ operations: 0, cachedArtifacts: 0 });
});

it('times out a source, reclaims no occupied slot early and expires cached bytes by monotonic time', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let release!: (value: unknown) => void;
  const source = vi.fn(() => new Promise(r => { release = r; }));
  const responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: source, timeoutMs: 100 });
  const pending = responder.exchange(request()), refused = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(100); await refused; expect(responder.health().operations).toBe(1);
  release(n.advance); await responder.close();
  const cachedSource = vi.fn(async () => n.advance), cached = createAdmissionPolicyTransferResponder({ context: n.context, successor: cachedSource });
  try {
    const first = await cached.exchange(request()); await vi.advanceTimersByTimeAsync(30000);
    await expect(cached.exchange({ ...request(), artifact: first.artifact })).rejects.toThrow('no longer available');
    expect(cached.health().cachedBytes).toBe(0); expect(cachedSource).toHaveBeenCalledTimes(1);
  } finally { await cached.close(); }
});

it('serves only pinned original genesis and checks page digest/context before returning private evidence', async () => {
  const { createAdmissionPolicyEvidenceRequest } = await import('@resonance/core/admission-policy-transfer');
  const genesis = vi.fn(async () => n.first), page = vi.fn(async () => new Uint8Array([1]));
  const responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: async () => n.advance, genesis, page });
  try {
    const request = createAdmissionPolicyEvidenceRequest(n.context, 'genesis', n.context.genesis);
    expect((await responder.exchange(request)).type).toBe('admission_policy_evidence_reply');
    await expect(responder.exchange({ ...request, head: n.advance.commitment.next })).rejects.toThrow();
    expect(genesis).toHaveBeenCalledTimes(1);
    await expect(responder.exchange(createAdmissionPolicyEvidenceRequest(n.context, 'page', n.advance.commitment.next, 'sha256:' + 'a'.repeat(64)))).rejects.toThrow('differs');
  } finally { await responder.close(); }
  const wrong = createAdmissionPolicyTransferResponder({ context: n.context, successor: async () => n.advance, genesis: async () => n.second });
  try { await expect(wrong.exchange(createAdmissionPolicyEvidenceRequest(n.context, 'genesis', n.context.genesis))).rejects.toThrow('pins'); }
  finally { await wrong.close(); }
});
