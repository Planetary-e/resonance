import { afterEach, expect, it } from 'vitest';
import { createAdmissionPolicyQuery, parseAdmissionPolicyQueryReply } from '@resonance/core/admission-policy-query';
import { createAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyQueryResponder } from '../admission-policy-query.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const n = await policyObserverFixture(); cleanup.push(n.close); return n; }

it('collects a caller-bound certificate only from configured observers and never mutates policy', async () => {
  const n = await fixture(), received: string[] = [];
  const responder = createAdmissionPolicyQueryResponder({ context: n.context, policy: () => n.first, now: () => n.now,
    transport: async (member, frame) => {
      received.push(member.endpoint); expect(frame.advance).toBeNull();
      const key = n.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!;
      return createAdmissionPolicyHeadVote(frame.request, admissionPolicyHead(n.first), n.context, key, n.now);
    } }); cleanup.push(responder.close);
  const query = createAdmissionPolicyQuery(n.context, n.now), reply = await responder.exchange(query);
  expect(parseAdmissionPolicyQueryReply(reply, query, n.context, n.now).certificate.votes).toHaveLength(4);
  expect(received.every(endpoint => n.context.members.some(member => member.endpoint === endpoint))).toBe(true);
  await expect(responder.exchange({ ...query, observers: [{ endpoint: 'https://untrusted.invalid/' }] })).rejects.toThrow();
  await responder.close(); await expect(responder.exchange(query)).rejects.toThrow('unavailable');
});

it('retains cancelled work in its admission bound until an uncooperative transport actually settles', async () => {
  const n = await fixture(); let resolve!: (value: never) => void, calls = 0;
  const held = new Promise<never>(done => { resolve = done; });
  const responder = createAdmissionPolicyQueryResponder({ context: n.context, policy: () => n.first, timeoutMs: 100, now: () => n.now,
    transport: () => { calls++; return held; } });
  const query = createAdmissionPolicyQuery(n.context, n.now);
  try {
    await expect(responder.exchange(query)).rejects.toThrow('timed out'); expect(calls).toBe(5);
    expect(responder.health()).toEqual({ operations: 1, maximumOperations: 1 });
    await expect(responder.exchange(query)).rejects.toThrow('unavailable'); expect(calls).toBe(5);
    let closed = false; const closing = responder.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    resolve(undefined as never); await closing; expect(responder.health().operations).toBe(0);
  } finally { resolve(undefined as never); await responder.close(); }
});

it('cancels all observer work and releases cooperative transports on caller disconnect', async () => {
  const n = await fixture(), controller = new AbortController(); let started!: () => void, aborted = 0;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const responder = createAdmissionPolicyQueryResponder({ context: n.context, policy: () => n.first, now: () => n.now,
    transport: (_member, _frame, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted++; reject(new Error('cancelled')); }, { once: true }); started();
    }) }); cleanup.push(responder.close);
  const pending = responder.exchange(createAdmissionPolicyQuery(n.context, n.now), controller.signal);
  const failed = expect(pending).rejects.toThrow('cancelled'); await reached; controller.abort(); await failed; await responder.close();
  expect(aborted).toBeGreaterThan(0); expect(responder.health().operations).toBe(0);
});
