import { afterEach, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionKeyFingerprint, admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openAdmissionSpendHistory } from '../admission-spend-history.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from '../admission-history-recovery.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let old: Awaited<ReturnType<typeof witnessFixture>>, fresh: typeof old;
beforeAll(async () => { [old, fresh] = await Promise.all([witnessFixture(), witnessFixture()]); }, 15000);
function command(...args: string[]) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>(resolve => execFile(process.execPath, ['--import', 'tsx', script, ...args],
    { timeout: 20000, maxBuffer: 65536 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}
async function succeed(...args: string[]) {
  const result = await command(...args); expect(result.stderr).toBe(''); expect(result.code).toBe(0); return JSON.parse(result.stdout);
}
async function proof(source: typeof old, text: string) {
  const requestBinding = createAdmissionRequestBindingV2('search', { text });
  const capability = presentBlindAdmissionTokenV2(await source.token(), source.scope, 'search', requestBinding);
  const spend = (await verifyBlindAdmissionTokenV2(capability, source.scope, 'search', requestBinding, source.keys.publicKey))!;
  const issuerKey = admissionKeyFingerprint(source.body.keys[0].profile.issuerPublicKey);
  return { value: { version: 1, kind: 'admission-legacy-spend-proof', issuerKey, capability, action: 'search', requestBinding },
    row: { spend, issuerKey, action: 'search', binding: requestBinding },
    line: JSON.stringify({ version: 1, spend, action: 'search', binding: requestBinding }) + '\n' };
}
async function fixture() {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'protected-maintenance-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const time = Date.now(), { witnesses: _old, ...prior } = old.body.keys[0], { witnesses: _fresh, ...current } = fresh.body.keys[0];
  const body = { ...fresh.body, issuedAt: time - 1000, expiresAt: time + 86400000, keys: [current,
    { ...prior, notBefore: time - 10000, issueUntil: time - 9000, spendUntil: time - 8000, retryUntil: time - 7000 }] };
  const policy = await signAdmissionPolicy(body, fresh.authority, fresh.authorityKey.secretKey);
  const context = { ...h.context, authority: policy.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const a = await proof(old, 'proven old row'), b = await proof(old, 'retained old row'), c = await proof(fresh, 'current row'), d = await proof(old, 'attributed old row');
  const owner = join(directory, 'owner'); mkdirSync(owner);
  const stateFile = join(owner, 'admission-spends-v2.jsonl'); writeFileSync(stateFile, a.line + b.line);
  const local = openAdmissionSpendHistory({ directory: owner, encryptionKey: h.key, policy }); local.write(c.row); local.write(d.row); local.close();
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${46000 + i}/history-checkpoint` }));
  const protection = { context, signingKey: h.owner, members };
  const options = { directory: owner, authority: policy.authority, policy, encryptionKey: h.key, protection };
  const initial = await openProtectedAdmissionSpendHistory({ ...options, protection: { ...protection, promoteLocalHistory: true, initializeWriter: true } });
  const genesis = initial.enrollment().root; initial.close();
  if (genesis.kind !== 'checkpoint') throw new Error('Expected test genesis');
  let calls = 0, online = 5, loseMutationReplies = false;
  const services: ReturnType<typeof openHistoryVolunteerService>[] = [];
  for (let i = 0; i < 5; i++) {
    const service = openHistoryVolunteerService({ directory: join(directory, `replica-${i}`), context, localKey: h.localKey,
      signingKey: h.memberKeys[i], genesisId: historyCheckpointEnvelopeId(genesis), initialize: genesis });
    services.push(service); cleanup.push(() => service.close());
    const listener = await listenHistoryAgreementReplica({ ...service, checkpoint(value: unknown) {
      calls++; if (i >= online) throw new Error('offline');
      const response = service.checkpoint(value);
      if (loseMutationReplies && response.request.action === 'append' && response.request.sequence > 0) throw new Error('lost reply');
      return response;
    } }); cleanup.push(() => listener.close()); members[i].endpoint = listener.checkpointEndpoint;
  }
  const config = join(directory, 'config.json'), policyFile = join(directory, 'policy.json'), keyFile = join(directory, 'storage.hex'), proofs = join(directory, 'proofs.json');
  const ownerKey = join(directory, 'owner-private.json');
  writeFileSync(ownerKey, JSON.stringify({ publicKey: Buffer.from(h.owner.publicKey).toString('base64url'), secretKey: Buffer.from(h.owner.secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ version: 1, context, members, ownerKeyFile: ownerKey }));
  writeFileSync(policyFile, JSON.stringify(policy)); writeFileSync(keyFile, h.key.toString('hex'), { mode: 0o600 }); writeFileSync(proofs, JSON.stringify([a.value]), { mode: 0o600 });
  const args = [config, policyFile, keyFile, owner]; await succeed('owner-ready', ...args);
  return { ...h, context, options, directory, owner, stateFile, genesis, body, policy, policyFile, proofs, args, a, b, c, d, services,
    calls: () => calls, online: (n: number) => { online = n; }, loseReplies: (n: boolean) => { loseMutationReplies = n; } };
}

it('reviews retirement and legacy recovery offline without exposing bearer evidence or changing either history', async () => {
  const n = await fixture(); n.online(0); const before = readFileSync(n.stateFile), calls = n.calls(), heads = n.services.map(s => s.describe());
  const retirement = await succeed('owner-retirement-plan', ...n.args, n.a.value.issuerKey);
  const legacy = await succeed('owner-legacy-plan', ...n.args, n.proofs);
  expect(retirement).toMatchObject({ readiness: 'unverified', recordsBefore: 4, recordsRemoved: 1, result: 'review-required' });
  expect(legacy).toMatchObject({ readiness: 'unverified', recordsBefore: 4, recordsRemoved: 2, unattributedRecordsRetained: 1 });
  for (const secret of [n.a.row.spend, n.a.row.binding, n.a.value.capability.token]) expect(JSON.stringify([retirement, legacy])).not.toContain(secret);
  for (const [commandName, target] of [['owner-retire', n.a.value.issuerKey], ['owner-legacy-recover', n.proofs]]) {
    expect((await command(commandName, '--approve', 'wrong', ...n.args, target)).code).not.toBe(0);
  }
  expect(readFileSync(n.stateFile)).toEqual(before); expect(n.calls()).toBe(calls); expect(n.services.map(s => s.describe())).toEqual(heads);
}, 30000);

it('refuses stale approvals and implicit policy updates before contacting a volunteer', async () => {
  const n = await fixture(), plan = await succeed('owner-retirement-plan', ...n.args, n.a.value.issuerKey);
  // Finish setup synchronously at each replica: a queued fifth socket request from
  // this earlier write must not count as traffic emitted by the later CLI review.
  const history = await openProtectedAdmissionSpendHistory({ ...n.options, protection: { ...n.options.protection,
    transport: async (member, frame) => n.services[n.context.members.indexOf(member.publicKey)].checkpoint(frame),
  } }); await history.ready();
  await history.write((await proof(fresh, 'new evidence')).row); history.close();
  const before = readFileSync(n.stateFile), calls = n.calls();
  const stale = await command('owner-retire', '--approve', plan.approvalDigest, ...n.args, n.a.value.issuerKey);
  expect(stale.code).not.toBe(0); expect(stale.stderr).toContain('approval');
  const successor = await signAdmissionPolicy({ ...n.body, revision: 2 }, fresh.authority, fresh.authorityKey.secretKey);
  writeFileSync(n.policyFile, JSON.stringify(successor));
  const newer = await command('owner-retirement-plan', ...n.args, n.a.value.issuerKey);
  expect(newer.code).not.toBe(0); expect(newer.stderr).toContain('retained policy');
  expect(n.calls()).toBe(calls); expect(readFileSync(n.stateFile)).toEqual(before);
}, 30000);

it('keeps a lost-reply legacy mutation pending, finishes it explicitly and preserves its denial through owner loss', async () => {
  const n = await fixture(), plan = await succeed('owner-legacy-plan', ...n.args, n.proofs);
  n.online(3); expect((await command('owner-legacy-recover', '--approve', plan.approvalDigest, ...n.args, n.proofs)).code).not.toBe(0);
  let history = await openProtectedAdmissionSpendHistory(n.options); expect(history.read().pending).toBeNull(); history.close();
  n.online(5); n.loseReplies(true);
  expect((await command('owner-legacy-recover', '--approve', plan.approvalDigest, ...n.args, n.proofs)).code).not.toBe(0);
  history = await openProtectedAdmissionSpendHistory(n.options); expect(history.read().pending?.sequence).toBe(1); history.close();
  const calls = n.calls(); expect((await command('owner-legacy-plan', ...n.args, n.proofs)).code).not.toBe(0); expect(n.calls()).toBe(calls);
  n.loseReplies(false); await succeed('owner-ready', ...n.args);
  history = await openProtectedAdmissionSpendHistory(n.options); await history.ready();
  expect(history.size()).toBe(2); expect(history.isRetired(n.a.value.issuerKey)).toBe(true);
  expect(history.get(n.b.row.spend)?.issuerKey).toBeNull(); expect(history.get(n.c.row.spend)).toEqual(n.c.row); history.close();
  expect(n.services.filter(s => s.describe().latest.sequence === 1).length).toBeGreaterThanOrEqual(4);
  rmSync(n.owner, { recursive: true });
  const options = { directory: join(n.directory, 'recovery'), genesis: n.genesis, encryptionKey: n.key, protection: n.options.protection };
  const review = await prepareAdmissionHistoryRecovery(options);
  const recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(() => recovery.close());
  for (let i = 0; i < 8 && !recovery.status().complete; i++) await recovery.advance();
  const destination = join(n.directory, 'restored'), preparation = await recovery.reviewRestore(destination, n.policy);
  history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: destination, initialize: true,
    protection: { ...n.options.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  await history.ready(); expect(history.isRetired(n.a.value.issuerKey)).toBe(true); expect(history.size()).toBe(2); history.close();
  const recoveredArgs = [...n.args]; recoveredArgs[3] = destination;
  writeFileSync(n.proofs, JSON.stringify([n.b.value]));
  const remaining = await succeed('owner-legacy-plan', ...recoveredArgs, n.proofs); expect(remaining.keys[0].alreadyRetired).toBe(true);
  await succeed('owner-legacy-recover', '--approve', remaining.approvalDigest, ...recoveredArgs, n.proofs);
  history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: destination }); await history.ready();
  expect(history.size()).toBe(1); expect(history.get(n.c.row.spend)).toEqual(n.c.row); expect(history.isRetired(n.a.value.issuerKey)).toBe(true); history.close();
}, 60000);

it('refuses missing state, malformed proof input and active-key retirement without resetting data', async () => {
  const n = await fixture(), before = readFileSync(n.stateFile), calls = n.calls();
  expect((await command('owner-retirement-plan', ...n.args, n.policy.activeKey)).code).not.toBe(0);
  writeFileSync(n.proofs, '{"private bearer fragment":');
  const malformed = await command('owner-legacy-plan', ...n.args, n.proofs);
  expect(malformed.code).not.toBe(0); expect(malformed.stderr).not.toContain('private bearer fragment');
  writeFileSync(n.proofs, 'x'.repeat(65537)); expect((await command('owner-legacy-plan', ...n.args, n.proofs)).code).not.toBe(0);
  const missing = [...n.args]; missing[3] = join(n.directory, 'missing');
  expect((await command('owner-retirement-plan', ...missing, n.a.value.issuerKey)).code).not.toBe(0);
  expect(existsSync(join(missing[3], 'admission-spends-v2.jsonl'))).toBe(false);
  const localOnly = [...n.args]; localOnly[3] = join(n.directory, 'local-only'); mkdirSync(localOnly[3]);
  const legacyFile = join(localOnly[3], 'admission-spends-v2.jsonl'); writeFileSync(legacyFile, n.a.line);
  const refusal = await command('owner-retirement-plan', ...localOnly, n.a.value.issuerKey);
  expect(refusal.code).not.toBe(0); expect(refusal.stderr).toContain('promotion');
  expect(readFileSync(legacyFile, 'utf8')).toBe(n.a.line); expect(existsSync(join(localOnly[3], 'admission-history-writer'))).toBe(false);
  expect(n.calls()).toBe(calls); expect(readFileSync(n.stateFile)).toEqual(before);
}, 30000);
