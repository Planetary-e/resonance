import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionActivationFixture } from './fixtures/admission-activation-fixture.js';
import { openAdmissionOwnerLimits, type AdmissionOwnerLimitsInput } from '../admission-history-limits.js';
import { loadAdmissionHistoryProtectionFile } from '../admission-history-config.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { runAdmissionHistoryCommand } from '../admission-history-command.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const n = await admissionActivationFixture(); cleanup.push(n.close);
  const input: AdmissionOwnerLimitsInput = { historyConfigFile: n.input.historyConfigFile, enrollmentFile: n.input.enrollmentFile,
    policyFile: n.input.policyFile, storageKeyFile: n.input.storageKeyFile, directory: n.historyDirectory,
    output: join(n.directory, 'owner-limits.json'), archiveMiB: 1, archiveBlocks: 3 };
  const open = async (selection = input) => { const value = await openAdmissionOwnerLimits(selection); cleanup.push(value.close); return value; };
  return { ...n, input, open };
}

it('reviews limits offline and writes a new configuration that retains the same history and owner key', async () => {
  const n = await fixture(), before = n.exchanges(), original = readFileSync(n.input.historyConfigFile);
  const prepared = await n.open(); expect(prepared.review).toMatchObject({ retainedBlocks: 2, pending: false, archiveBlocks: 3, archiveBytes: 1048576 });
  expect(n.exchanges()).toBe(before); expect(existsSync(n.input.output)).toBe(false);
  expect(() => prepared.apply('wrong')).toThrow('approval'); expect(existsSync(n.input.output)).toBe(false);
  expect(prepared.apply(prepared.review.approvalDigest).result).toBe('owner-limits-configured'); prepared.close();
  expect(readFileSync(n.input.historyConfigFile)).toEqual(original); expect(n.exchanges()).toBe(before);
  const config = JSON.parse(readFileSync(n.input.output, 'utf8')); expect(config.context).toEqual(n.context); expect(config.members).toEqual(n.protection.members);
  const protection = loadAdmissionHistoryProtectionFile(n.input.output); cleanup.push(() => { protection.signingKey.secretKey.fill(0); });
  expect(protection).toMatchObject({ maxArchiveBytes: 1048576, maxArchiveBlocks: 3 });
  const verifier = await createConfiguredAdmissionVerifier({ ...n.verifierOptions, historyProtection: protection }); cleanup.push(verifier.close);
  expect((await verifier.verifyAndSpend(n.capability, n.request)).status).toBe('replay');
});

it('refuses to shrink past accepted or unarchived pending ciphertext and resumes that exact pending operation after a reviewed increase', async () => {
  const n = await fixture();
  await expect(n.open({ ...n.input, archiveBlocks: 1 })).rejects.toThrow();
  const verifier = await createConfiguredAdmissionVerifier({ ...n.verifierOptions, historyProtection: { ...n.protection, maxArchiveBlocks: 2 } });
  const token = await n.issuer.token(), binding = createAdmissionRequestBindingV2('search', { query: 'pending archive capacity' });
  const capability = presentBlindAdmissionTokenV2(token, n.issuer.scope, 'search', binding), request = { ...n.request, requestBinding: binding, now: Date.now() };
  try { await expect(verifier.verifyAndSpend(capability, request)).rejects.toThrow('archive capacity exceeded'); } finally { verifier.close(); }
  await expect(n.open({ ...n.input, archiveBlocks: 2 })).rejects.toThrow('pending ciphertext');
  const prepared = await n.open(); expect(prepared.review.pending).toBe(true); expect(prepared.review.pendingUnarchivedBytes).toBeGreaterThan(0);
  prepared.apply(prepared.review.approvalDigest); prepared.close();
  const protection = loadAdmissionHistoryProtectionFile(n.input.output); cleanup.push(() => { protection.signingKey.secretKey.fill(0); });
  const resumed = await createConfiguredAdmissionVerifier({ ...n.verifierOptions, historyProtection: protection }); cleanup.push(resumed.close);
  expect((await resumed.verifyAndSpend(capability, request)).status).toBe('replay');
  const otherBinding = createAdmissionRequestBindingV2('search', { query: 'reusing the same token differently' });
  const reused = presentBlindAdmissionTokenV2(token, n.issuer.scope, 'search', otherBinding);
  expect((await resumed.verifyAndSpend(reused, { ...request, requestBinding: otherBinding })).status).toBe('rejected');
// Real issuer keys, durable quorum writes and pending-operation recovery share this test.
}, 15000);

it('refuses changed selected files, occupied outputs, history overlap and out-of-range limits', async () => {
  const n = await fixture(), prepared = await n.open(), original = readFileSync(n.input.policyFile);
  writeFileSync(n.input.policyFile, Buffer.concat([original, Buffer.from('\n')]));
  expect(() => prepared.apply(prepared.review.approvalDigest)).toThrow('changed'); expect(existsSync(n.input.output)).toBe(false); prepared.close();
  writeFileSync(n.input.policyFile, original);
  for (const change of [{ archiveMiB: 0 }, { archiveMiB: 65 }, { archiveBlocks: 10002 }, { output: n.input.policyFile }, { output: join(n.historyDirectory, 'limits.json') }]) {
    await expect(n.open({ ...n.input, ...change })).rejects.toThrow();
  }
  expect(readFileSync(n.input.policyFile)).toEqual(original);
});

it('exposes exact reviewed limits through the fixed operator commands', async () => {
  const n = await fixture(), i = n.input, args = [i.historyConfigFile, i.enrollmentFile, i.policyFile, i.storageKeyFile, i.directory, i.output, String(i.archiveMiB), String(i.archiveBlocks)];
  const plan = (await runAdmissionHistoryCommand('owner-limits-plan', args)).result;
  await expect(runAdmissionHistoryCommand('owner-limits', ['--approve', 'wrong', ...args])).rejects.toThrow('approval');
  const result = (await runAdmissionHistoryCommand('owner-limits', ['--approve', String(plan.approvalDigest), ...args])).result;
  expect(result).toMatchObject({ result: 'owner-limits-configured', startsService: false, readiness: 'unverified' });
});
