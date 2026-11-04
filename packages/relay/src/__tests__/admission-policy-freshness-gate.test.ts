import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { createAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { policyTransferFixture } from '../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyFreshnessGate } from '../admission-policy-freshness-gate.js';
import type { AdmissionPolicyObservationTransport } from '../admission-policy-observation-transport.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const n = await policyTransferFixture(); cleanup.push(n.close);
  const directory = mkdtempSync(join(tmpdir(), 'freshness-gate-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = randomBytes(32), store = await openAdmissionPolicyStore({ path: join(directory, 'policy.json'), encryptionKey: key, mode: 'create-new' });
  cleanup.push(() => { store.close(); key.fill(0); }); await store.install(n.first, n.context.authority, { observers: n.context });
  let head = n.context.genesis; const now = Date.now();
  const transport: AdmissionPolicyObservationTransport = async (member, frame) => createAdmissionPolicyHeadVote(frame.request, head, n.context,
    n.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, now);
  const gate = (custom = transport, timeoutMs = 1000) => {
    const value = createAdmissionPolicyFreshnessGate({ store, transport: custom, timeoutMs, now: () => now }); cleanup.push(value.close); return value;
  };
  return { ...n, store, gate, transport, observed(value: typeof head) { head = value; } };
}

it('retains capacity and drains uncooperative transports after cancelled callers have returned', async () => {
  const n = await fixture(); let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const gate = n.gate(async (...args) => { calls++; await held; return n.transport(...args); }, 100);
  cleanup.push(() => release());
  const first = gate.run(async () => 'forbidden').catch(error => error), second = gate.run(async () => 'forbidden').catch(error => error);
  const [a, b] = await Promise.all([first, second]); expect(a).toBeInstanceOf(Error); expect(b).toBeInstanceOf(Error); expect(calls).toBe(10);
  expect(gate.health()).toMatchObject({ operations: 0, observationOperations: 2 });
  await expect(gate.run(async () => 'forbidden')).rejects.toThrow('unavailable'); expect(calls).toBe(10);
  let closed = false; const drained = gate.close().then(() => { closed = true; }); await tick(); expect(closed).toBe(false);
  release(); await drained; expect(gate.health()).toMatchObject({ operations: 0, observationOperations: 0 });
  await expect(gate.run(async () => 'forbidden')).rejects.toThrow('closed');
});

it('refuses delayed work using monotonic elapsed time even when the wall clock remains inside the signed window', async () => {
  const n = await fixture(), gate = n.gate(n.transport, 100); let wrote = false;
  await expect(gate.run(async assertCurrent => { await delay(125); assertCurrent(); wrote = true; return 'late'; })).rejects.toThrow();
  expect(wrote).toBe(false);
  const controller = new AbortController(); controller.abort();
  await expect(gate.run(async () => 'forbidden', controller.signal)).rejects.toThrow();
});

it('invalidates an in-flight authorization when another operation durably observes a newer head', async () => {
  const n = await fixture(), gate = n.gate(); let entered!: () => void, release!: () => void, wrote = false;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  cleanup.push(() => release());
  const first = gate.run(async assertCurrent => { entered(); await held; assertCurrent(); wrote = true; }).catch(error => error);
  await ready; n.observed(n.advance.commitment.next);
  await expect(gate.run(async () => 'forbidden')).rejects.toThrow('newer');
  release(); expect(await first).toBeInstanceOf(Error); expect(wrote).toBe(false); expect(n.store.freshness()!.observed.revision).toBe(2);
});
