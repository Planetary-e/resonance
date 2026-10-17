import { afterEach, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionKeyFingerprint, admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { parseHistoryCompactionAttestation } from '@resonance/core/history-compaction';
import { parseHistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { openAdmissionSpendHistory } from '../admission-spend-history.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from '../admission-history-recovery.js';
import { canonicalHistorySetupPath } from '../admission-history-setup.js';
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
    }, compaction(value) { calls++; if (i >= online) throw new Error('offline'); return service.compaction(value); }
    }); cleanup.push(() => listener.close()); members[i].endpoint = listener.checkpointEndpoint;
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

it('reviews a complete state checkpoint offline and publishes it with four copies while retaining earlier evidence', async () => {
  const n = await fixture(); n.online(0);
  const before = readFileSync(n.stateFile), calls = n.calls();
  const plan = await succeed('owner-checkpoint-plan', ...n.args);
  expect(plan).toMatchObject({ result: 'review-required', readiness: 'unverified', recordsRetained: 4,
    unattributedRecordsRetained: 2, sequence: 1, filesRemoved: 0, bytesReclaimed: 0 });
  for (const secret of [n.a.row.spend, n.a.row.binding, n.a.value.capability.token]) expect(JSON.stringify(plan)).not.toContain(secret);
  expect(readFileSync(n.stateFile)).toEqual(before); expect(n.calls()).toBe(calls);
  expect((await command('owner-checkpoint', '--approve', 'wrong', ...n.args)).code).not.toBe(0);
  expect(n.calls()).toBe(calls);
  n.online(3);
  expect((await command('owner-checkpoint', '--approve', plan.approvalDigest, ...n.args)).code).not.toBe(0);
  let history = await openProtectedAdmissionSpendHistory(n.options);
  expect(history.read().pending).toBeNull(); const image = history.read().image; history.close();
  n.online(5);
  const applied = await succeed('owner-checkpoint', '--approve', plan.approvalDigest, ...n.args);
  expect(applied).toMatchObject({ result: 'state-checkpoint-published', readiness: 'confirmed', durableCopies: 4,
    sequence: 1, filesRemoved: 0, bytesReclaimed: 0 });
  history = await openProtectedAdmissionSpendHistory(n.options); await history.ready();
  expect(history.read().image).toEqual(image); expect(history.read().applied?.id).toBe(applied.envelopeId); history.close();
  expect(n.services.filter(s => s.describe().latest.sequence === 1).length).toBeGreaterThanOrEqual(4);
  expect((await command('owner-checkpoint', '--approve', plan.approvalDigest, ...n.args)).code).not.toBe(0);
  // The new full-state record also remains consumable by actual lost-owner recovery.
  const options = { directory: join(n.directory, 'checkpoint-recovery'), genesis: n.genesis, encryptionKey: n.key, protection: n.options.protection };
  const review = await prepareAdmissionHistoryRecovery(options);
  const recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(() => recovery.close());
  for (let i = 0; i < 8 && !recovery.status().complete; i++) await recovery.advance();
  const destination = join(n.directory, 'checkpoint-restored'), preparation = await recovery.reviewRestore(destination, n.policy);
  history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: destination, initialize: true,
    protection: { ...n.options.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  await history.ready(); expect(history.read().image).toEqual(image); history.close();
}, 60000);

it('exports a reviewed four-member checkpoint certificate through the CLI and uses it for actual recovery', async () => {
  const n = await fixture(), output = join(n.directory, 'checkpoint-certificate.json');
  expect((await command('owner-checkpoint-certification-plan', ...n.args, output)).code).not.toBe(0);
  const publish = await succeed('owner-checkpoint-plan', ...n.args);
  await succeed('owner-checkpoint', '--approve', publish.approvalDigest, ...n.args);
  const secondPublish = await succeed('owner-checkpoint-plan', ...n.args);
  await succeed('owner-checkpoint', '--approve', secondPublish.approvalDigest, ...n.args);
  n.online(0); const before = readFileSync(n.stateFile), calls = n.calls();
  const plan = await succeed('owner-checkpoint-certification-plan', ...n.args, output);
  expect(plan).toMatchObject({ sequence: 2, recordsRetained: 4, output: canonicalHistorySetupPath(output), filesRemoved: 0, bytesReclaimed: 0, readiness: 'unverified' });
  for (const secret of [n.a.row.spend, n.a.row.binding, n.a.value.capability.token]) expect(JSON.stringify(plan)).not.toContain(secret);
  expect(n.calls()).toBe(calls); expect(readFileSync(n.stateFile)).toEqual(before); expect(existsSync(output)).toBe(false);
  expect((await command('owner-checkpoint-certify', '--approve', 'wrong', ...n.args, output)).code).not.toBe(0);
  expect((await command('owner-checkpoint-certify', '--approve', plan.approvalDigest, ...n.args, join(n.directory, 'changed.json'))).code).not.toBe(0);
  expect(n.calls()).toBe(calls);
  n.online(3); expect((await command('owner-checkpoint-certify', '--approve', plan.approvalDigest, ...n.args, output)).code).not.toBe(0);
  expect(existsSync(output)).toBe(false); expect(readFileSync(n.stateFile)).toEqual(before);
  n.online(5);
  expect(await succeed('owner-checkpoint-certify', '--approve', plan.approvalDigest, ...n.args, output))
    .toMatchObject({ result: 'checkpoint-certificate-exported', endorsements: 4, authority: 'historical-only', remotelyRetained: false });
  const bytes = readFileSync(output), genesisId = historyCheckpointEnvelopeId(n.genesis);
  const certificate = parseHistoryCompactionAttestation(JSON.parse(bytes.toString()), n.context, genesisId);
  expect(certificate.proposal.envelopeId).toBe(plan.envelopeId);
  const after = n.calls(); expect((await command('owner-checkpoint-certify', '--approve', plan.approvalDigest, ...n.args, output)).code).not.toBe(0);
  expect(readFileSync(output)).toEqual(bytes); expect(n.calls()).toBe(after);
  const enrollment = join(n.directory, 'enrollment.json');
  writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis }));
  const retainArgs = [n.args[0], enrollment, output]; n.online(0);
  const retainPlan = await succeed('owner-checkpoint-retention-plan', ...retainArgs); expect(n.calls()).toBe(after);
  expect((await command('owner-checkpoint-retain', '--approve', 'wrong', ...retainArgs)).code).not.toBe(0); expect(n.calls()).toBe(after);
  n.online(3); expect((await command('owner-checkpoint-retain', '--approve', retainPlan.approvalDigest, ...retainArgs)).code).not.toBe(0);
  expect(n.services.filter(s => s.retainedCompactionCheckpoint(genesisId) !== null)).toHaveLength(3);
  n.online(5);
  expect(await succeed('owner-checkpoint-retain', '--approve', retainPlan.approvalDigest, ...retainArgs))
    .toMatchObject({ result: 'checkpoint-proof-retained', retainedCopies: 4, authority: 'historical-only', admissionReadiness: 'unverified' });
  expect(readFileSync(output)).toEqual(bytes);
  expect(await succeed('owner-checkpoint-retain', '--approve', retainPlan.approvalDigest, ...retainArgs))
    .toMatchObject({ result: 'checkpoint-proof-retained', retainedCopies: 4 });
  const retentionFile = join(n.directory, 'retained-proof-evidence.json'), exportArgs = [...retainArgs, retentionFile];
  const beforeExportPlan = n.calls(), exportPlan = await succeed('owner-checkpoint-retention-plan', ...exportArgs);
  expect(n.calls()).toBe(beforeExportPlan); expect(exportPlan.output).toBe(canonicalHistorySetupPath(retentionFile));
  expect(exportPlan.approvalDigest).not.toBe(retainPlan.approvalDigest);
  expect((await command('owner-checkpoint-retain', '--approve', retainPlan.approvalDigest, ...exportArgs)).code).not.toBe(0);
  expect(n.calls()).toBe(beforeExportPlan); expect(existsSync(retentionFile)).toBe(false);
  n.online(3); expect((await command('owner-checkpoint-retain', '--approve', exportPlan.approvalDigest, ...exportArgs)).code).not.toBe(0);
  expect(existsSync(retentionFile)).toBe(false); n.online(5);
  await succeed('owner-checkpoint-retain', '--approve', exportPlan.approvalDigest, ...exportArgs);
  const retentionBytes = readFileSync(retentionFile), retained = parseHistoryCompactionRetention(JSON.parse(retentionBytes.toString()), n.context, genesisId);
  expect(retained.certificate).toEqual(certificate); expect(retained.receipts).toHaveLength(4);
  const afterExport = n.calls();
  expect((await command('owner-checkpoint-retain', '--approve', exportPlan.approvalDigest, ...exportArgs)).code).not.toBe(0);
  expect(n.calls()).toBe(afterExport); expect(readFileSync(retentionFile)).toEqual(retentionBytes);
  n.online(0); const beforePrefix = n.calls();
  const prefix = await succeed('owner-prefix-plan', ...n.args);
  expect(prefix).toMatchObject({ filesRemoved: 1, recordsRetained: 4, readiness: 'unverified' });
  expect((await command('owner-prefix-retire', '--approve', 'wrong', ...n.args)).code).not.toBe(0);
  expect(await succeed('owner-prefix-retire', '--approve', prefix.approvalDigest, ...n.args))
    .toMatchObject({ result: 'history-prefix-retired', filesRemoved: 1, readiness: 'unverified' });
  expect(n.calls()).toBe(beforePrefix); expect(readFileSync(n.stateFile)).toEqual(before);
  expect(await succeed('owner-prefix-plan', ...n.args)).toMatchObject({ filesRemoved: 0 });
  for (const service of n.services.filter(s => s.retainedCompactionCheckpoint(genesisId))) {
    const review = service.planPrefixRetirement(genesisId);
    expect(service.retirePrefix(genesisId, review.approvalDigest).filesRemoved).toBe(1);
  }
  n.online(5);
  const options = { directory: join(n.directory, 'certified-recovery'), genesis: n.genesis, encryptionKey: n.key,
    protection: n.options.protection, compaction: certificate };
  const review = await prepareAdmissionHistoryRecovery(options);
  const recovery = await openAdmissionHistoryRecovery({ ...options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  for (let step = 0; step < 8 && !recovery.status().complete; step++) await recovery.advance();
  expect(recovery.status().complete).toBe(true);
  const destination = join(n.directory, 'certified-owner'), restored = await recovery.reviewRestore(destination, n.policy);
  expect(restored.review.spends).toBe(4);
  const history = await openProtectedAdmissionSpendHistory({ ...n.options, directory: destination, initialize: true,
    protection: { ...n.options.protection, initializeWriter: true, restore: { preparation: restored, approvedDigest: restored.review.approvalDigest } } });
  cleanup.push(history.close); await history.ready(); await history.checkpoint(history.planCheckpoint().approvalDigest);
  const nextPlan = history.planCheckpointCertification(); expect(nextPlan.genesisId).toBe(genesisId);
  expect(nextPlan.generation).toBe(1); expect(nextPlan.rootId).not.toBe(genesisId);
  const nextCertificate = await history.certifyCheckpoint(nextPlan.approvalDigest, { transport: async (member, proposal) =>
    n.services[n.context.members.indexOf(member.publicKey)].compaction(proposal) });
  expect(parseHistoryCompactionAttestation(nextCertificate, n.context, genesisId).proposal.generation).toBe(1);
}, 60000);

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

it('reviews and retires one stopped volunteer prefix through the CLI using its independent enrollment and local keys', async () => {
  const n = await fixture(), history = await openProtectedAdmissionSpendHistory(n.options);
  cleanup.push(history.close); await history.ready();
  await history.checkpoint(history.planCheckpoint().approvalDigest);
  await history.checkpoint(history.planCheckpoint().approvalDigest);
  const plan = history.planCheckpointCertification();
  const certificate = await history.certifyCheckpoint(plan.approvalDigest, { transport: async (member, proposal) =>
    n.services[n.context.members.indexOf(member.publicKey)].compaction(proposal) });
  history.close(); const service = n.services[0], rootId = historyCheckpointEnvelopeId(n.genesis);
  service.retainCompactionCheckpoint(certificate, service.reviewDigest());
  const expected = service.planPrefixRetirement(rootId); service.close();
  const enrollment = join(n.directory, 'replica-enrollment.json'), signing = join(n.directory, 'replica-signing.json'), storage = join(n.directory, 'replica-storage.hex');
  writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis }));
  writeFileSync(signing, JSON.stringify({ publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('base64url'),
    secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(storage, n.localKey.toString('hex'), { mode: 0o600 });
  const args = [enrollment, signing, storage, join(n.directory, 'replica-0'), rootId];
  const review = await succeed('replica-prefix-plan', ...args);
  expect(review.filesRemoved).toBe(1); expect(review.approvalDigest).toBe(expected.approvalDigest);
  const calls = n.calls();
  expect((await command('replica-prefix-retire', '--approve', 'wrong', ...args)).code).not.toBe(0);
  expect(await succeed('replica-prefix-retire', '--approve', review.approvalDigest, ...args))
    .toMatchObject({ result: 'history-prefix-retired', filesRemoved: 1, readiness: 'unverified' });
  expect(await succeed('replica-prefix-plan', ...args)).toMatchObject({ filesRemoved: 0 }); expect(n.calls()).toBe(calls);
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
