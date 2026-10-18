import { afterEach, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
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
    expect(responder.health()).toEqual({ operations: 1, maximumOperations: 1, queuedOperations: 0, maximumExchanges: 8 });
    await expect(responder.exchange(query)).rejects.toThrow('unavailable'); expect(calls).toBe(5);
    let closed = false; const closing = responder.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    resolve(undefined as never); await closing; expect(responder.health().operations).toBe(0);
  } finally { resolve(undefined as never); await responder.close(); }
});

it('queues simultaneous callers while preserving one collector and a separate challenge for each', async () => {
  const n = await fixture(), challenges = new Set<string>(); let active = 0, maximum = 0;
  const responder = createAdmissionPolicyQueryResponder({ context: n.context, policy: () => n.first, now: () => n.now,
    transport: async (member, frame) => {
      active++; maximum = Math.max(maximum, active); challenges.add(frame.request.challenge);
      try {
        await delay(10);
        return createAdmissionPolicyHeadVote(frame.request, admissionPolicyHead(n.first), n.context,
          n.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, n.now);
      } finally { active--; }
    } }); cleanup.push(responder.close);
  const queries = Array.from({ length: 3 }, () => createAdmissionPolicyQuery(n.context, n.now));
  const original = structuredClone(queries[1]);
  const replies = queries.map(query => responder.exchange(query)); queries[1].request.challenge = queries[0].request.challenge;
  const result = await Promise.all(replies); await responder.close();
  expect(challenges.size).toBe(3); expect(maximum).toBe(5); expect(active).toBe(0);
  expect(parseAdmissionPolicyQueryReply(result[1], original, n.context, n.now).certificate.votes).toHaveLength(4);
});

it('bounds queued callers, expires them within their original allowance and cancels without observer traffic', async () => {
  const n = await fixture(); let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const responder = createAdmissionPolicyQueryResponder({ context: n.context, policy: () => n.first, timeoutMs: 100, now: () => n.now,
    transport: async () => { calls++; await held; throw new Error('released failed transport'); } });
  const query = createAdmissionPolicyQuery(n.context, n.now), controller = new AbortController();
  try {
    const active = responder.exchange(query), activeFailure = expect(active).rejects.toThrow();
    await delay(0); expect(calls).toBe(5);
    const cancelled = responder.exchange(query, controller.signal), cancelledFailure = expect(cancelled).rejects.toThrow('cancelled');
    const waiting = Array.from({ length: 6 }, () => responder.exchange(createAdmissionPolicyQuery(n.context, n.now)));
    const expired = Promise.all(waiting.map(value => expect(value).rejects.toThrow('timed out')));
    await expect(responder.exchange(query)).rejects.toThrow('unavailable');
    expect(responder.health()).toMatchObject({ operations: 1, queuedOperations: 7 });
    controller.abort(); await cancelledFailure; await activeFailure; await expired;
    expect(calls).toBe(5); expect(responder.health()).toMatchObject({ operations: 1, queuedOperations: 0 });
    release(); await responder.close();
  } finally { release(); await responder.close(); }
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
