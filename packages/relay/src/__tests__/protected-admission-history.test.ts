import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2,
  createPublicationRecord, generatePublicationKeyMaterial, serializePublicationOperationFrame, createPublicationOperationFrame,
  parseMessage, type Message, type AckPayload } from '@resonance/core';
import { admissionKeyFingerprint, admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createHistoryFreeze, historyCheckpointEnvelopeId, openHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { openProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from '../protected-admission-history.js';
import { openAdmissionSpendHistory, type AdmissionSpendRecord } from '../admission-spend-history.js';
import { createRelayServer } from '../server.js';
import { parseAdmissionHistoryImage, reduceAdmissionHistory } from '../admission-history-records.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica,
  type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), openSync: vi.fn(fs.openSync) };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.mocked(fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(openSync).mockReset().mockImplementation(actual.openSync);
  for (const close of cleanup.splice(0).reverse()) await close();
});
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
async function fixture(sockets = false, legacy: boolean | AdmissionSpendRecord = false) {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'protected-admission-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const policy = await signAdmissionPolicy({ ...f.body, keys: f.body.keys.map(({ witnesses, ...entry }) => entry) }, f.authority, f.authorityKey.secretKey);
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${28000 + i}/history-checkpoint` }));
  let time = f.time, calls = 0, online = 5, loseReplies = false, gate: Promise<void> | undefined;
  const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [], roles: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
  const listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    calls++; const i = context.members.indexOf(member.publicKey);
    if (i >= online) throw new Error('offline');
    if (gate) await gate;
    const response = sockets ? await exchangeHistoryCheckpoint(member, frame, signal) : roles[i].exchange(frame);
    if (loseReplies && frame.request.action === 'append') throw new Error('reply lost');
    return response;
  };
  const protection: AdmissionHistoryProtection = { context, signingKey: h.owner, members, transport, timeoutMs: 2000 };
  const options = { directory: join(directory, 'owner'), encryptionKey: h.key, authority: f.authority, policy, now: () => time, protection };
  const old = { spend: randomBytes(32).toString('base64url'), action: 'search', binding: `admreq_${'x'.repeat(86)}`, issuerKey: policy.activeKey };
  if (legacy === true) { const ledger = openAdmissionSpendHistory({ ...options, initialize: true }); ledger.write(old); ledger.close(); }
  else if (legacy) {
    mkdirSync(options.directory); const { issuerKey, ...raw } = legacy;
    writeFileSync(join(options.directory, 'admission-spends-v2.jsonl'), JSON.stringify({ version: 1, ...raw }) + '\n');
  }
  let history = await openProtectedAdmissionSpendHistory({ ...options, initialize: !legacy,
    protection: { ...protection, initializeWriter: true, promoteLocalHistory: !!legacy } });
  cleanup.push(() => history.close()); expect(calls).toBe(0);
  const { root } = history.enrollment();
  for (let i = 0; i < 5; i++) {
    const store = openHistoryCheckpointStore({ directory: join(directory, `r${i}`), context, replica: context.members[i],
      localKey: h.localKey, rootId: historyCheckpointEnvelopeId(root), generation: 0, initialize: root });
    stores.push(store); cleanup.push(() => store.close());
    const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); roles.push(role); cleanup.push(() => role.close());
    if (sockets) { const listener = await listenHistoryCheckpointReplica(role, { port: 0 }); listeners.push(listener); members[i].endpoint = listener.endpoint; cleanup.push(() => listener.close()); }
  }
  // The first offline preparation used placeholder endpoints; reopen after real listeners have bound.
  history.close(); history = await openProtectedAdmissionSpendHistory(options); cleanup.push(() => history.close());
  async function reopen() { history.close(); history = await openProtectedAdmissionSpendHistory(options); cleanup.push(() => history.close()); return history; }
  async function verifier() {
    history.close(); const v = await createConfiguredAdmissionVerifier({ ...options, historyProtection: protection,
      initialize: true, initializeSpendHistory: false }); cleanup.push(() => v.close()); return v;
  }
  return { ...h, context, directory, options, history, stores, old, policy, transport, reopen, verifier,
    calls: () => calls, online: (n: number) => { online = n; }, loseReplies: (v: boolean) => { loseReplies = v; },
    gate: (v?: Promise<void>) => { gate = v; }, time: (n: number) => { time = n; } };
}
const row = (issuerKey: string) => ({ issuerKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: `admreq_${'a'.repeat(86)}` });

it('promotes the intact local history under one file lock and refuses every local-only reopening', async () => {
  const n = await fixture(false, true);
  expect(n.history.read().image.state.spends).toEqual([n.old]); expect(() => n.history.size()).toThrow('completion');
  const bytes = readFileSync(join(n.options.directory, 'admission-spends-v2.jsonl'));
  expect(bytes.includes(Buffer.from(n.old.spend))).toBe(false);
  await n.history.ready(); expect(n.history.get(n.old.spend)).toEqual(n.old);
  n.history.close(); expect(() => openAdmissionSpendHistory(n.options)).toThrow('state is invalid');
  expect((await n.reopen()).get(n.old.spend)).toEqual(n.old);
});
it('requires four durable copies, retains exact pending ciphertext and applies it after disk reopen without creating a second spend', async () => {
  const n = await fixture(); await n.history.ready(); const r = row(n.policy.activeKey); n.online(3);
  await expect(n.history.write(r)).rejects.toThrow('Four');
  const pending = n.history.read().pending!; expect(n.history.read().image.state.spends).toEqual([]);
  expect(() => n.history.size()).toThrow('completion');
  expect(n.stores.slice(0, 3).every(s => s.describe().envelopeId === historyCheckpointEnvelopeId(pending))).toBe(true);
  n.online(4); const history = await n.reopen(); expect(history.read().pending).toEqual(pending); await history.ready();
  expect(history.get(r.spend)).toEqual(r); const before = n.calls(); await history.write(r); expect(n.calls()).toBe(before);
  expect(history.read().applied?.sequence).toBe(1);
  const payload = JSON.parse(openHistoryCheckpoint(n.stores[3].read().envelopes[1], n.context, n.key).toString());
  expect(payload).toMatchObject({ kind: 'spend', row: r });
});
it('resumes writes whose acknowledgements were lost and refuses an unrelated pending request', async () => {
  const n = await fixture(); await n.history.ready(); n.loseReplies(true); const r = row(n.policy.activeKey);
  await expect(n.history.write(r)).rejects.toThrow('Four');
  expect(n.stores.every(s => s.describe().sequence === 1)).toBe(true);
  await expect(n.history.write(row(n.policy.activeKey))).rejects.toThrow('pending');
  const pending = n.history.read().pending; n.loseReplies(false); await n.history.write(r);
  expect(n.history.read().applied?.id).toBe(historyCheckpointEnvelopeId(pending!)); expect(n.history.size()).toBe(1);
});
it('refuses new admission after a recovery freeze even though an older write certificate is still present', async () => {
  const n = await fixture(); await n.history.ready();
  const r = row(n.policy.activeKey); await n.history.write(r);
  const barrier = createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner);
  for (const store of n.stores) store.freeze(barrier);
  await expect(n.history.write(row(n.policy.activeKey))).rejects.toThrow('Four');
  expect(n.history.read().image.state.spends).toEqual([r]);
});
it('bounds concurrency and aborts close without accepting the uncompleted operation', async () => {
  const n = await fixture(); await n.history.ready(); let release!: () => void;
  n.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = n.history.write(row(n.policy.activeKey)); const refusal = expect(pending).rejects.toThrow();
  await expect(n.history.ready()).rejects.toThrow('in progress');
  await vi.waitFor(() => expect(n.history.read().pending).not.toBeNull());
  n.history.close(); release(); await refusal; n.gate();
  const history = await n.reopen(); await history.ready(); expect(history.size()).toBe(1);
});
it.each((process.platform === 'win32' ? ['intent', 'apply'] : ['intent', 'apply', 'intent-directory', 'apply-directory']) as string[])(
  'never accepts after a failed %s flush and resumes exact recorded intent', async boundary => {
  const n = await fixture(); await n.history.ready(); const r = row(n.policy.activeKey), paths = new Map<number, string>(); let count = 0;
  vi.mocked(openSync).mockImplementation((...args) => { const fd = actual.openSync(...args); paths.set(fd, String(args[0])); return fd; });
  vi.mocked(fsyncSync).mockImplementation(fd => {
    const path = paths.get(fd) ?? '';
    const matches = boundary.endsWith('-directory') ? path === n.options.directory : /\.admission-spends-v2\.jsonl\.[a-f0-9]+\.tmp$/.test(path);
    if (matches && ++count === (boundary.startsWith('intent') ? 1 : 2)) throw new Error('ledger flush failed');
    actual.fsyncSync(fd);
  });
  const before = n.calls(); await expect(n.history.write(r)).rejects.toThrow('ledger flush failed');
  if (boundary.startsWith('intent')) expect(n.calls()).toBe(before);
  expect(() => n.history.read()).toThrow('write failed');
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); const history = await n.reopen();
  const calls = n.calls(); await history.ready();
  if (boundary.startsWith('apply')) { expect(n.calls()).toBe(calls); expect(history.get(r.spend)).toEqual(r); }
  else if (boundary === 'intent-directory') expect(history.get(r.spend)).toEqual(r);
  else expect(history.get(r.spend)).toBeUndefined();
});
it('refuses a ledger-only rollback and never repairs it by deleting accepted history', async () => {
  const n = await fixture(); await n.history.ready(); const path = join(n.options.directory, 'admission-spends-v2.jsonl');
  const old = readFileSync(path); await n.history.write(row(n.policy.activeKey)); n.history.close(); writeFileSync(path, old);
  await expect(n.reopen()).rejects.toThrow('histories disagree');
  expect(n.stores.filter(s => s.describe().sequence === 1).length).toBeGreaterThanOrEqual(4);
});
it.each(['before-intent', 'after-intent', 'before-apply', 'after-apply', 'durable'] as const)(
  'preserves the publication binding and exactly one durable spend across SIGKILL at %s', async boundary => {
    const n = await fixture(true); await n.history.ready(); n.history.close();
    const r = row(n.policy.activeKey), child = fork(new URL('./fixtures/protected-admission-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
    child.send({ options: { directory: n.options.directory, authority: f.authority, policy: n.policy }, key: n.key.toString('hex'), time: f.time,
      protection: { context: n.context, members: n.options.protection.members, timeoutMs: 30000 }, owner: {
        publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') }, row: r, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    const history = await n.reopen(), pending = history.read().pending;
    expect(history.read().applied?.sequence).toBe(['after-apply', 'durable'].includes(boundary) ? 1 : 0);
    expect(pending !== null).toBe(['after-intent', 'before-apply'].includes(boundary));
    await history.ready(); await history.write(r); expect(history.size()).toBe(1); expect(history.read().applied?.sequence).toBe(1);
    if (pending) expect(history.read().applied?.id).toBe(historyCheckpointEnvelopeId(pending));
    await expect(history.write({ ...r, binding: `admreq_${'z'.repeat(86)}` })).rejects.toThrow('Conflicting');
  }, 30000,
);
async function successor(n: Awaited<ReturnType<typeof fixture>>) {
  const old = n.policy.keys[0], fresh = { ...old, profile: { ...old.profile, scope: { ...old.profile.scope, epoch: 'next' },
    issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    issueUntil: old.issueUntil + 3600000, spendUntil: old.spendUntil + 3600000, retryUntil: old.retryUntil + 3600000 };
  return signAdmissionPolicy({ ...f.body, revision: 2, keys: [old, fresh], activeKey: admissionKeyFingerprint(fresh.profile.issuerPublicKey) }, f.authority, f.authorityKey.secretKey);
}
it('replicates signed policy changes and retirement fences, reconstructible from ciphertext without bearer tokens', async () => {
  const n = await fixture(false, true); await n.history.ready(); n.history.close(); const policy = await successor(n);
  const h = await openProtectedAdmissionSpendHistory({ ...n.options, policy }); cleanup.push(() => h.close()); n.online(3);
  await expect(h.ready()).rejects.toThrow('Four'); expect(h.read().image.policy.revision).toBe(1);
  n.online(4); await h.ready(); expect(h.policy().revision).toBe(2); n.time(n.policy.keys[0].retryUntil);
  const plan = h.planRetirement(n.policy.activeKey); await expect(h.retire(n.policy.activeKey, 'wrong')).rejects.toThrow('approval');
  await h.retire(n.policy.activeKey, plan.approvalDigest); expect(h.size()).toBe(0); expect(h.isRetired(n.policy.activeKey)).toBe(true);
  const blocks = n.stores[0].read().envelopes;
  let image = await parseAdmissionHistoryImage(JSON.parse(openHistoryCheckpoint(blocks[0], n.context, n.key).toString()), f.authority);
  for (const block of blocks.slice(1)) image = (await reduceAdmissionHistory(image, JSON.parse(openHistoryCheckpoint(block, n.context, n.key).toString()))).image;
  expect(image).toEqual(h.read().image); n.time(f.time); await expect(h.write(n.old)).rejects.toThrow();
  h.close(); const reopened = await openProtectedAdmissionSpendHistory({ ...n.options, policy }); cleanup.push(() => reopened.close());
  expect(reopened.isRetired(n.policy.activeKey)).toBe(true);
});
it('verifies legacy bearer evidence locally before replicating only its irreversible attribution and key fence', async () => {
  const binding = createAdmissionRequestBindingV2('search', { query: 'legacy' });
  const capability = presentBlindAdmissionTokenV2(await f.token(), f.scope, 'search', binding);
  const spend = (await verifyBlindAdmissionTokenV2(capability, f.scope, 'search', binding, f.keys.publicKey))!;
  const n = await fixture(false, { spend, issuerKey: null, action: 'search', binding }); await n.history.ready(); n.history.close();
  const policy = await successor(n), h = await openProtectedAdmissionSpendHistory({ ...n.options, policy }); cleanup.push(() => h.close());
  await h.ready(); n.time(n.policy.keys[0].retryUntil);
  const proofs = [{ version: 1, kind: 'admission-legacy-spend-proof', issuerKey: n.policy.activeKey, capability, action: 'search', requestBinding: binding }];
  await expect(h.planLegacyRecovery([{ ...proofs[0], requestBinding: `admreq_${'b'.repeat(86)}` }])).rejects.toThrow();
  const plan = await h.planLegacyRecovery(proofs); n.online(3); await expect(h.recoverLegacy(proofs, plan.approvalDigest)).rejects.toThrow('Four');
  expect(h.read().image.state.spends).toHaveLength(1); n.online(4); await h.ready();
  expect(h.size()).toBe(0); expect(h.isRetired(n.policy.activeKey)).toBe(true);
  const block = n.stores[0].read().envelopes.at(-1)!;
  const plaintext = openHistoryCheckpoint(block, n.context, n.key).toString();
  expect(JSON.parse(plaintext)).toMatchObject({ kind: 'legacy-recovery', attributions: [{ spend, issuerKey: n.policy.activeKey }] });
  expect(plaintext).not.toContain(capability.token);
});
it('withholds the actual publication acknowledgement until four durable histories exist and preserves double-spend denial on restart', async () => {
  const n = await fixture(true), verifier = await n.verifier();
  const relayOptions = { port: 0, host: '127.0.0.1', persistDir: join(n.directory, 'relay'), persistIntervalMs: 999999 };
  let relay = createRelayServer({ ...relayOptions, admissionVerifier: verifier }); await relay.start(); cleanup.push(() => relay.stop());
  const publication = () => { const now = Date.now(); return createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(0x42), itemType: 'offer', createdAt: now, expiresAt: now + 86400000 }, generatePublicationKeyMaterial()); };
  const token = await f.token(), first = publication();
  const frame = (record: ReturnType<typeof publication>) => serializePublicationOperationFrame(createPublicationOperationFrame(record,
    presentBlindAdmissionTokenV2(token, f.scope, 'publication-write', createAdmissionRequestBindingV2('publication-write', record))));
  async function send(raw: string) { return new Promise<Message<AckPayload>>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.getListeningPort()}`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('test request timed out')); }, 5000);
    socket.once('open', () => socket.send(raw)); socket.once('message', data => { clearTimeout(timer); socket.close(); resolve(parseMessage(data.toString()) as Message<AckPayload>); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  }); }
  n.online(3); expect((await send(frame(first))).payload.message).toBe('admission_unavailable'); expect(relay.getStats().stored_publications).toBe(0);
  await relay.stop(); verifier.close(); n.online(4);
  const v = await createConfiguredAdmissionVerifier({ ...n.options, historyProtection: n.options.protection }); cleanup.push(() => v.close());
  relay = createRelayServer({ ...relayOptions, admissionVerifier: v }); await relay.start();
  expect((await send(frame(first))).payload.message).toBe('accepted');
  expect(n.stores.filter(s => s.describe().sequence === 1)).toHaveLength(4);
  expect((await send(frame(first))).payload.message).toBe('duplicate');
  expect((await send(frame(publication()))).payload.message).toBe('admission_rejected'); expect(relay.getStats().stored_publications).toBe(1);
}, 20000);
it('blocks configured admission until four real socket replicas store the spend; exact retries do not add a delta', async () => {
  const n = await fixture(true), verifier = await n.verifier(); n.online(3);
  const token = await f.token(), binding = createAdmissionRequestBindingV2('search', { query: 'protected' });
  const capability = presentBlindAdmissionTokenV2(token, f.scope, 'search', binding), context = { action: 'search' as const, requestBinding: binding, now: f.time };
  await expect(verifier.verifyAndSpend(capability, context)).rejects.toThrow('Four'); verifier.close(); n.online(4);
  const restarted = await createConfiguredAdmissionVerifier({ ...n.options, historyProtection: n.options.protection }); cleanup.push(() => restarted.close());
  expect(await restarted.verifyAndSpend(capability, context)).toEqual({ status: 'replay' });
  const another = presentBlindAdmissionTokenV2(await f.token(), f.scope, 'search', binding);
  expect(await restarted.verifyAndSpend(another, context)).toEqual({ status: 'accepted' });
  expect(n.stores.filter(s => s.describe().sequence === 2)).toHaveLength(4);
  expect(await restarted.verifyAndSpend(another, context)).toEqual({ status: 'replay' });
  restarted.close(); await expect(createConfiguredAdmissionVerifier(n.options)).rejects.toThrow('state is invalid');
}, 20000);
it('does not return accepted when the new-spend cutoff passes while durable replication is awaited', async () => {
  const n = await fixture(), verifier = await n.verifier(); let release!: () => void;
  n.gate(new Promise<void>(resolve => { release = resolve; }));
  const token = await f.token(), binding = createAdmissionRequestBindingV2('search', { query: 'cutoff' });
  const capability = presentBlindAdmissionTokenV2(token, f.scope, 'search', binding), context = { action: 'search' as const, requestBinding: binding, now: f.time };
  const before = n.calls(), pending = verifier.verifyAndSpend(capability, context);
  await vi.waitFor(() => expect(n.calls()).toBeGreaterThan(before)); n.time(n.policy.keys[0].spendUntil); release();
  expect(await pending).toEqual({ status: 'rejected', reason: 'key_retired' });
  expect(n.stores.filter(s => s.describe().sequence === 1).length).toBeGreaterThanOrEqual(4);
  expect(await verifier.verifyAndSpend(capability, context)).toEqual({ status: 'replay' });
});
