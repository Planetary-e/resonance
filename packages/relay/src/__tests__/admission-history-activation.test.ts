import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openAdmissionPolicyStore, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { openAdmissionHistoryActivation } from '../admission-history-activation.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { admissionActivationFixture } from './fixtures/admission-activation-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const n = await admissionActivationFixture(); cleanup.push(n.close); return n; }

it('reviews offline, rejects unapproved transmission and activates retained real-token evidence without starting a relay', async () => {
  const n = await fixture(), before = n.exchanges(), path = join(n.runtimeDirectory, 'admission-community-policy.json');
  const historyBytes = readFileSync(join(n.historyDirectory, 'admission-spends-v2.jsonl'));
  let activation = await openAdmissionHistoryActivation(n.activationOptions); cleanup.push(() => activation.close());
  const plan = activation.review();
  expect(plan).toMatchObject({ policyAction: 'create', spends: 1, permanentDenials: 0, readiness: 'unverified', startsService: false, initializesWitnessState: false });
  expect(JSON.stringify(plan)).not.toContain(n.token); expect(n.exchanges()).toBe(before); expect(existsSync(path)).toBe(false);
  await expect(activation.apply('wrong')).rejects.toThrow('approval'); expect(n.exchanges()).toBe(before);
  activation.close(); activation = await openAdmissionHistoryActivation(n.activationOptions);
  expect(activation.review()).toEqual(plan);
  expect(await activation.apply(plan.approvalDigest)).toMatchObject({ result: 'owner-policy-prepared', readiness: 'confirmed', startsService: false });
  activation.close(); expect(readFileSync(join(n.historyDirectory, 'admission-spends-v2.jsonl'))).toEqual(historyBytes);
  const verifier = await createConfiguredAdmissionVerifier({ ...n.verifierOptions, directory: n.runtimeDirectory, historyDirectory: n.historyDirectory });
  try {
    expect(await verifier.verifyAndSpend(n.capability, n.request)).toEqual({ status: 'replay' });
    const binding = createAdmissionRequestBindingV2('search', { query: 'conflicting reuse' });
    expect(await verifier.verifyAndSpend(presentBlindAdmissionTokenV2(n.token, n.issuer.scope, 'search', binding), { ...n.request, requestBinding: binding }))
      .toEqual({ status: 'rejected', reason: 'double_spend' });
  } finally { verifier.close(); }
  await expect(createConfiguredAdmissionVerifier({ ...n.verifierOptions, directory: n.runtimeDirectory, historyProtection: undefined })).rejects.toThrow('local fallback');
});

it('requires a current fourth copy and refuses a coherent stale backup without creating policy state', async () => {
  const n = await fixture(), stale = join(n.directory, 'stale'); cpSync(n.historyDirectory, stale, { recursive: true });
  const v = await createConfiguredAdmissionVerifier(n.verifierOptions);
  try { expect((await v.verifyAndSpend(presentBlindAdmissionTokenV2(await n.issuer.token(), n.issuer.scope, 'search', n.binding), n.request)).status).toBe('accepted'); }
  finally { v.close(); }
  let activation = await openAdmissionHistoryActivation({ ...n.activationOptions, historyDirectory: stale });
  try { await expect(activation.apply(activation.review().approvalDigest)).rejects.toThrow(); } finally { activation.close(); }
  expect(existsSync(join(n.runtimeDirectory, 'admission-community-policy.json'))).toBe(false);
  await n.listeners[3].close(); await n.listeners[4].close();
  activation = await openAdmissionHistoryActivation(n.activationOptions);
  try { await expect(activation.apply(activation.review().approvalDigest)).rejects.toThrow(); } finally { activation.close(); }
  expect(existsSync(join(n.runtimeDirectory, 'admission-community-policy.json'))).toBe(false);
});

it('retains unrelated old ledgers, rejects implicit policy changes and requires an installed binding to match', async () => {
  const n = await fixture(), before = n.exchanges(), old = join(n.runtimeDirectory, 'admission-spends-v2.jsonl');
  writeFileSync(old, 'retain this old local history');
  await expect(openAdmissionHistoryActivation(n.activationOptions)).rejects.toThrow('Existing unbound spend history');
  expect(readFileSync(old, 'utf8')).toBe('retain this old local history');
  const clean = join(n.directory, 'new-runtime'); mkdirSync(clean);
  const { authority: _authority, signature: _signature, ...body } = n.policy;
  const nextPolicy = await signAdmissionPolicy({ ...body, revision: 2 }, n.issuer.authority, n.issuer.authorityKey.secretKey);
  await expect(openAdmissionHistoryActivation({ ...n.activationOptions, runtimeDirectory: clean, policy: nextPolicy })).rejects.toThrow('Apply the supplied policy');
  await expect(openAdmissionHistoryActivation({ ...n.activationOptions, runtimeDirectory: clean, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
  const store = await openAdmissionPolicyStore({ path: join(clean, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'create-new' });
  await store.install(n.policy, n.policy.authority); store.bindProtectedHistory('sha256:' + 'f'.repeat(64)); store.close();
  await expect(openAdmissionHistoryActivation({ ...n.activationOptions, runtimeDirectory: clean })).rejects.toThrow('cannot replace');
  expect(n.exchanges()).toBe(before);
});

it.each(['before-1', 'after-1', 'before-2', 'after-2', 'before-3', 'after-3'])('retains accepted history through SIGKILL at policy publication %s and needs explicit review to resume', async boundary => {
  const n = await fixture(), bytes = readFileSync(join(n.historyDirectory, 'admission-spends-v2.jsonl'));
  const child = fork(fileURLToPath(new URL('./fixtures/admission-activation-crash.ts', import.meta.url)), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let failure = ''; child.stderr?.on('data', value => { failure += value.toString(); });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await once(child, 'message'))[0]).toBe('ready');
  child.on('message', value => { if (typeof value === 'object') failure += JSON.stringify(value); });
  child.send({ options: { ...n.activationOptions, encryptionKey: undefined, protection: { context: n.context, members: n.protection.members, timeoutMs: 1500 } },
    key: n.key.toString('hex'), owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') }, boundary });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 10000);
  try { expect((await exited)[1], failure).toBe('SIGKILL'); } finally { clearTimeout(timeout); }
  expect(failure).toBe(''); expect(readFileSync(join(n.historyDirectory, 'admission-spends-v2.jsonl'))).toEqual(bytes);
  const activation = await openAdmissionHistoryActivation(n.activationOptions);
  try { await activation.apply(activation.review().approvalDigest); } finally { activation.close(); }
  const store = await openAdmissionPolicyStore({ path: join(n.runtimeDirectory, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'open-existing' });
  try { expect(store.protectedHistoryContext()).toBe(historyCheckpointContextId(n.context)); } finally { store.close(); }
  expect(readFileSync(join(n.historyDirectory, 'admission-spends-v2.jsonl'))).toEqual(bytes);
}, 20000);
