import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver } from '../admission-policy-observation-transport.js';
import { collectAdmissionPolicyObservation } from '../admission-policy-observation.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('activates with four volunteer devices, repairs the fifth, and refuses a certificate from two restored stale owners', async () => {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const observers: Awaited<ReturnType<typeof openProtectedPolicyObserver>>[] = [], online = [true, true, true, true, true];
  const exchanges: ReturnType<typeof createAdmissionPolicyObserverExchange>[] = [];
  const policyListeners: Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>[] = [];
  const historyListeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
  const failures: Array<{ node: number; error: string }> = [];
  for (let i = 0; i < 5; i++) {
    const policyListener = await listenAdmissionPolicyObserver(value => {
      if (!online[i]) return Promise.reject(new Error('Volunteer device offline'));
      return exchanges[i](value).catch(error => { failures.push({ node: i, error: String(error) }); throw error; });
    });
    policyListeners.push(policyListener); cleanup.push(policyListener.close);

  }
  const context = parseAdmissionPolicyObservers({ ...f.context, members: f.keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: policyListeners[i].endpoint })) });
  const advance = await createAdmissionPolicyAdvance(f.first, f.second, context, f.key);
  const configurations = [];
  for (let owner = 0; owner < 5; owner++) {
    const prepared = await createPolicyObserverHistoryRoot({ context, signingKey: f.keys[owner], encryptionKey: f.options.encryptionKey, policy: f.first, now: () => f.now });
    const members: Array<{ publicKey: string; endpoint: string }> = [];
    for (let node = 0; node < 5; node++) {
      const store = openHistoryCheckpointStore({ directory: join(f.directory, `node-${node}-history-${owner}`), localKey: randomBytes(32),
        context: prepared.context, replica: Buffer.from(f.keys[node].publicKey).toString('base64url'), rootId: historyCheckpointEnvelopeId(prepared.root), generation: 0, initialize: prepared.root });
      cleanup.push(store.close);
      const role = createHistoryCheckpointReplica({ context: prepared.context, store, signingKey: f.keys[node] }); cleanup.push(role.close);
      // Each enrolled history uses the actual dedicated listener's normal bound.
      // Five services on one simulated device do not share a four-slot test socket.
      const listener = await listenHistoryCheckpointReplica({ close() {}, exchange(value) {
        if (!online[node]) throw new Error('Volunteer device offline'); return role.exchange(value);
      } });
      cleanup.push(listener.close); historyListeners.push(listener);
      members.push({ publicKey: Buffer.from(f.keys[node].publicKey).toString('base64url'), endpoint: listener.endpoint });
    }
    const config = { directory: join(f.directory, `owner-${owner}`), encryptionKey: f.options.encryptionKey, context, signingKey: f.keys[owner],
      historyContext: prepared.context, root: prepared.root, members, timeoutMs: 5000, now: () => f.now };
    configurations.push(config);
    const observer = await openProtectedPolicyObserver({ ...config, mode: 'create-new' }); cleanup.push(observer.close); await observer.ready();
    observer.close(); cpSync(config.directory, `${config.directory}-backup`, { recursive: true });
    const reopened = await openProtectedPolicyObserver({ ...config, mode: 'open-existing' }); cleanup.push(reopened.close); observers.push(reopened);
    exchanges.push(createAdmissionPolicyObserverExchange(reopened, context, () => f.now));
  }
  cleanup.push(async () => { await Promise.all(policyListeners.map(listener => listener.close())); });
  const collect = async (policy = f.second, activating = false) => {
    const start = failures.length;
    try { return await collectAdmissionPolicyObservation({ context, policy,
      ...(activating ? { advance } : {}), timeoutMs: 10000, now: () => f.now }); }
    catch (error) { throw new Error(`Policy collection failed: ${String(error)}; observer failures: ${JSON.stringify(failures.slice(start))}`, { cause: error }); }
  };
  online[4] = false;
  const certificate = await collect(f.second, true); expect(certificate.votes).toHaveLength(4);
  expect(new Set(certificate.votes.map(vote => vote.observer)).size).toBe(4);
  expect(observers.slice(0, 4).map(observer => observer.policy().revision)).toEqual([2, 2, 2, 2]); expect(observers[4].policy().revision).toBe(1);
  await expect(collect(f.first)).rejects.toThrow();
  // Repair node 4 while a different device is unavailable: all owner histories
  // and policy notices travel over real sockets between the five local devices.
  online[3] = false; online[4] = true;
  expect((await collect(f.second, true)).votes).toHaveLength(4); expect(observers[4].policy().revision).toBe(2); online[3] = true;
  for (const owner of [0, 1]) {
    observers[owner].close();
    const stale = await openProtectedPolicyObserver({ ...configurations[owner], directory: `${configurations[owner].directory}-backup`, mode: 'open-existing' });
    cleanup.push(stale.close); observers[owner] = stale; exchanges[owner] = createAdmissionPolicyObserverExchange(stale, context, () => f.now);
  }
  await expect(collect(f.first)).rejects.toThrow(); await expect(collect()).rejects.toThrow();
  expect(observers.slice(0, 2).map(observer => observer.policy().revision)).toEqual([1, 1]);
  // Preserved current owner bytes can reopen safely; missing bytes must use the
  // separate frozen-generation recovery workflow, never a fabricated empty root.
  observers[0].close();
  const intact = await openProtectedPolicyObserver({ ...configurations[0], mode: 'open-existing' }); cleanup.push(intact.close);
  exchanges[0] = createAdmissionPolicyObserverExchange(intact, context, () => f.now);
  expect((await collect()).votes).toHaveLength(4);
}, 30000);
