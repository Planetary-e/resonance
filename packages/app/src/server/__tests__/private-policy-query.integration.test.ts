import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { generateIdentity, generatePublicationKeyMaterial, createPublicationRecord, type AdmissionCapabilityV2 } from '@resonance/core';
import type { AdmissionCapabilityVerifierV2 } from '../../../../relay/src/admission.js';
import { createAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createRelayServer } from '../../../../relay/src/server.js';
import { createAdmissionPolicyQueryResponder } from '../../../../relay/src/admission-policy-query.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver } from '../../../../relay/src/admission-policy-observation-transport.js';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../../../../relay/src/protected-policy-observer.js';
import { openHistoryVolunteerService } from '../../../../relay/src/history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../../../../relay/src/history-agreement-exchange.js';
import { policyObserverFixture } from '../../../../relay/src/__tests__/fixtures/policy-observer-fixture.js';
import { createRelayClient } from '../../../../node/src/relay-client.js';
import { createAdmissionIssuanceBatch } from '../../../../node/src/blind-admission-issuance.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Private policy query cleanup failed');
});
async function fixture(options: { admission?: AdmissionCapabilityVerifierV2; capability?: AdmissionCapabilityV2 } = {}) {
  const n = await policyObserverFixture({ policyLifetimeMs: 300000, keyLifetimeMs: 240000 }); cleanup.push(n.close);
  const handlers: Array<(value: unknown) => Promise<unknown>> = [], observers = [], histories = [];
  const listeners: Array<Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>> = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenAdmissionPolicyObserver(value => handlers[i](value)); listeners.push(listener); cleanup.push(listener.close);
  }
  const context = parseAdmissionPolicyObservers({ ...n.context, members: n.keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: listeners[i].endpoint })) });
  for (let i = 0; i < 5; i++) {
    const encryptionKey = randomBytes(32), signingKey = n.keys[i]; cleanup.push(() => { encryptionKey.fill(0); });
    const root = await createPolicyObserverHistoryRoot({ context, policy: n.first, encryptionKey, signingKey });
    const members = [], volunteers = [];
    for (let j = 0; j < 5; j++) {
      const localKey = randomBytes(32); cleanup.push(() => { localKey.fill(0); });
      const service = openHistoryVolunteerService({ directory: join(n.directory, `observer-${i}-replica-${j}`), context: root.context,
        genesisId: historyCheckpointEnvelopeId(root.root), localKey, signingKey: n.keys[j], initialize: root.root }); cleanup.push(service.close);
      const listener = await listenHistoryAgreementReplica(service); cleanup.push(listener.close); volunteers.push(listener);
      members.push({ publicKey: Buffer.from(n.keys[j].publicKey).toString('base64url'), endpoint: listener.checkpointEndpoint });
    }
    histories.push(volunteers);
    const observer = await openProtectedPolicyObserver({ directory: join(n.directory, `observer-${i}`), context, historyContext: root.context,
      encryptionKey, signingKey, root: root.root, members, mode: 'create-new' }); cleanup.push(observer.close);
    await observer.ready(); observers.push(observer); handlers.push(createAdmissionPolicyObserverExchange(observer, context));
  }
  let policy = n.first, replace: ((reply: unknown) => unknown) | undefined, permitted = true;
  const queries: unknown[] = [], responder = createAdmissionPolicyQueryResponder({ context, policy: () => policy }); cleanup.push(responder.close);
  const admission = vi.fn(async () => { throw new Error('Metadata must not reserve or spend a token'); });
  const entry = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(n.directory, 'entry'),
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  const destination = createRelayServer({ port: 0, host: '::1', persistDir: join(n.directory, 'destination'),
    relayDiscovery: { endpoints: ['ws://[::1]:0/'], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
    admissionVerifier: options.admission ?? { verifyAndSpend: admission, isReady: () => false }, acceptNewWork: () => permitted,
    policyQuery: async (value, signal) => { queries.push(value); const reply = await responder.exchange(value, signal); return (replace ? replace(reply) : reply) as typeof reply; } });
  await entry.start(); cleanup.push(() => entry.stop({ graceful: false }));
  await destination.start(); cleanup.push(() => destination.stop({ graceful: false }));
  expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
  const entryUrl = `ws://127.0.0.1:${entry.getListeningPort()}/`, destinationUrl = `ws://[::1]:${destination.getListeningPort()}/`;
  const capability = vi.fn(() => options.capability), identity = generateIdentity(); cleanup.push(() => { identity.secretKey.fill(0); });
  const client = createRelayClient({ relayUrl: destinationUrl, privateEntryUrls: [entryUrl], identity,
    privateTraffic: { batchWindowMs: 10, jitterMs: 0 }, admissionCapabilityProvider: capability }); cleanup.push(() => client.disconnect());
  return { ...n, context, observers, histories, queries, client, admission, capability, entry, destination, destinationUrl, identity,
    setPolicy(value: typeof n.first) { policy = value; }, setReply(value?: typeof replace) { replace = value; }, setPermitted(value: boolean) { permitted = value; } };
}

it('runs issuer commands against five protected observers, persists an emergency floor and resumes only after the exact signed update', async () => {
  const n = await fixture(), profile = join(n.directory, 'issuer-profile.json'), privateKey = join(n.directory, 'issuer.pem'), ledger = join(n.directory, 'issuer-ledger.json');
  const authority = join(n.directory, 'authority.pub'), policy = join(n.directory, 'policy.json'), context = join(n.directory, 'observers.json');
  writeFileSync(profile, JSON.stringify(n.first.keys[0].profile)); writeFileSync(privateKey, n.issuerPrivateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(authority, n.authority); writeFileSync(policy, JSON.stringify(n.first)); writeFileSync(context, JSON.stringify(n.context));
  const main = fileURLToPath(new URL('../../../../../scripts/issue-admission-tokens.ts', import.meta.url));
  const prefix = [profile, privateKey, ledger];
  const run = (command: string, args: string[]) => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), main, command, ...args], { cwd: n.directory, timeout: 15000 });
  await run('init', [...prefix, '1', '2']);
  await run('policy', ['--approve', '--observers', context, ...prefix, authority, policy]);
  const permit = join(n.directory, 'permit.json'); await run('grant', ['--approve', ...prefix, permit]);
  const batch = await createAdmissionIssuanceBatch(n.first.keys[0].profile, 1), request = join(n.directory, 'request.json'), response = join(n.directory, 'response.json');
  writeFileSync(request, JSON.stringify(batch.request));
  const advance = await createAdmissionPolicyAdvance(n.first, n.second, n.context, n.key);
  for (const observer of n.observers) await observer.advance(advance);
  await expect(run('issue', ['--approve', ...prefix, permit, request, response])).rejects.toThrow('newer'); expect(existsSync(response)).toBe(false);
  expect(JSON.parse((await run('status', prefix)).stdout)).toMatchObject({ boundPermits: 0, policyFreshness: { installedRevision: 1, observedRevision: 2 } });
  writeFileSync(policy, JSON.stringify(n.second));
  await expect(run('policy', ['--approve', ...prefix, authority, policy])).rejects.toThrow('signed immediate successor');
  const transition = join(n.directory, 'advance.json'); writeFileSync(transition, JSON.stringify(advance));
  await run('policy', ['--approve', '--advance', transition, ...prefix, authority, policy]);
  await run('issue', ['--approve', ...prefix, permit, request, response]);
  expect(await batch.finalize(JSON.parse(readFileSync(response, 'utf8')))).toHaveLength(1);
  const retry = join(n.directory, 'retry.json'); await run('issue', ['--approve', ...prefix, permit, request, retry]);
  expect(readFileSync(retry)).toEqual(readFileSync(response));
  for (const volunteers of n.histories) { await volunteers[3].close(); await volunteers[4].close(); }
  const refused = join(n.directory, 'unavailable.json');
  await expect(run('issue', ['--approve', ...prefix, permit, request, refused])).rejects.toThrow('four matching');
  expect(existsSync(refused)).toBe(false);
}, 90000);

it('queries five protected observers over two private hops without a personal identifier or token and rejects a replayed reply', async () => {
  const n = await fixture(), wire: string[] = [], send = WebSocket.prototype.send;
  const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, data: any, ...rest: any[]) {
    let frame: any; try { frame = JSON.parse(String(data)); } catch { /* Other wire traffic. */ }
    if (frame?.stage === 'entry' || frame?.type === 'relay_private_forward') wire.push(String(data));
    return Reflect.apply(send, this, [data, ...rest]);
  });
  const first = await n.client.queryAdmissionPolicy!(n.context); spy.mockRestore();
  expect(first.reply.certificate.votes).toHaveLength(4); expect(first.reply.certificate.votes[0].head.revision).toBe(1);
  expect(wire.length).toBeGreaterThan(0); expect(wire.join('\n')).not.toContain('admission_policy_query'); expect(wire.join('\n')).not.toContain(n.identity.did);
  expect(n.capability).not.toHaveBeenCalled(); expect(n.admission).not.toHaveBeenCalled();
  n.setReply(() => first.reply); await expect(n.client.queryAdmissionPolicy!(n.context)).rejects.toThrow();
  expect((n.queries[0] as any).request.challenge).not.toBe((n.queries[1] as any).request.challenge);
  n.setReply(); const advance = await createAdmissionPolicyAdvance(n.first, n.second, n.context, n.key);
  for (const observer of n.observers) await observer.advance(advance); n.setPolicy(n.second);
  expect((await n.client.queryAdmissionPolicy!(n.context)).reply.certificate.votes[0].head).toEqual(advance.commitment.next);
}, 60000);

it('refuses direct metadata requests and owner-paused queries before observer fanout', async () => {
  const n = await fixture(), socket = new WebSocket(n.destinationUrl);
  const closed = once(socket, 'close'); await once(socket, 'open'); socket.send(JSON.stringify(createAdmissionPolicyQuery(n.context))); await closed;
  expect(n.queries).toHaveLength(0);
  n.setPermitted(false); await expect(n.client.queryAdmissionPolicy!(n.context)).rejects.toThrow(); expect(n.queries).toHaveLength(0);
  expect(createRelayClient({ relayUrl: n.destinationUrl }).queryAdmissionPolicy).toBeUndefined();
}, 60000);

it('refuses an old policy or insufficient retained copies through the private path', async () => {
  const n = await fixture(), advance = await createAdmissionPolicyAdvance(n.first, n.second, n.context, n.key);
  for (const observer of n.observers) await observer.advance(advance);
  await expect(n.client.queryAdmissionPolicy!(n.context)).rejects.toThrow();
  n.setPolicy(n.second);
  for (const volunteers of n.histories) { await volunteers[3].close(); await volunteers[4].close(); }
  await expect(n.client.queryAdmissionPolicy!(n.context)).rejects.toThrow();
  expect(n.capability).not.toHaveBeenCalled(); expect(n.admission).not.toHaveBeenCalled();
}, 60000);

it('drains an admitted private publication before closing durable stores and retains it across restart', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const capability: AdmissionCapabilityV2 = { version: 2, kind: 'admission-capability', scheme: 'test-blind-token-v1',
    issuer: 'community:test', token: 'A'.repeat(43), requestProof: `admreq_${'a'.repeat(86)}` };
  const n = await fixture({ capability, admission: { async verifyAndSpend() { entered(); await gate; return { status: 'accepted' }; } } });
  const keys = generatePublicationKeyMaterial(), now = Date.now();
  const record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(0xb5),
    itemType: 'offer', createdAt: now, expiresAt: now + 86400000 }, keys);
  const reply = n.client.submitPublicationOperation(record).catch(error => error);
  try {
    await started; let stopped = false;
    const closing = n.destination.stop({ graceful: false }).then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
    release(); await closing; expect(n.destination.getStats().stored_publications).toBe(1);
    expect(await reply).toBeInstanceOf(Error);
    const reopened = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(n.directory, 'destination') });
    cleanup.push(() => reopened.stop({ graceful: false })); await reopened.start(); expect(reopened.getStats().stored_publications).toBe(1);
  } finally { release(); }
}, 60000);
