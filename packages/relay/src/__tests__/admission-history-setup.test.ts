import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { reviewAdmissionOwnerConfiguration, openAdmissionOwnerSetup } from '../admission-history-setup.js';
import { readHistoryEnrollmentFile, runAdmissionHistoryCommand } from '../admission-history-command.js';
import { loadAdmissionHistoryProtectionFile } from '../admission-history-config.js';
import { openProtectedAdmissionSpendHistory, inspectProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { admissionSetupFixture } from './fixtures/admission-setup-fixture.js';
import { admissionActivationFixture } from './fixtures/admission-activation-fixture.js';
import { openAdmissionInitialReadiness } from '../admission-history-readiness.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const value = await admissionSetupFixture(); cleanup.push(value.close); return value; }
const wrong = 'sha256:' + '0'.repeat(64);

it('reviews exact public configuration offline and requires its stable random identifier and unchanged files before exclusive creation', async () => {
  const n = await fixture(), prepared = await reviewAdmissionOwnerConfiguration(n.configInput);
  expect(existsSync(n.configInput.output)).toBe(false);
  expect(prepared.review).toMatchObject({ kind: 'new-owner-configuration', readiness: 'unverified', startsService: false, members: expect.any(Array) });
  expect(prepared.review.members).toHaveLength(5);
  expect(JSON.stringify(prepared.review)).not.toContain(Buffer.from(n.owner.secretKey).toString('base64url'));
  expect(() => prepared.apply(wrong)).toThrow('approval');
  const repeated = await reviewAdmissionOwnerConfiguration({ ...n.configInput, historyId: prepared.review.historyId });
  expect(repeated.review).toEqual(prepared.review);
  const original = readFileSync(n.configInput.membersFile); writeFileSync(n.configInput.membersFile, original + '\n');
  expect(() => prepared.apply(prepared.review.approvalDigest)).toThrow('selection changed');
  expect(existsSync(n.configInput.output)).toBe(false); writeFileSync(n.configInput.membersFile, original);
  expect(repeated.apply(repeated.review.approvalDigest).contextId).toBe(prepared.review.contextId);
  const config = readFileSync(n.configInput.output);
  expect(() => repeated.apply(repeated.review.approvalDigest)).toThrow('already applied');
  await expect(reviewAdmissionOwnerConfiguration(n.configInput)).rejects.toThrow('already exists');
  expect(readFileSync(n.configInput.output)).toEqual(config);
});

it('prepares once, leaves readiness unverified and exports the same genesis without replacing existing history or outputs', async () => {
  const n = await fixture(); await n.createConfig();
  const preparation = await openAdmissionOwnerSetup(n.input); cleanup.push(preparation.close);
  const review = preparation.review(); expect(review).toMatchObject({ mode: 'new', spends: 0, genesisId: null, initializeWriter: true, initializeArchive: true });
  expect(existsSync(n.input.directory)).toBe(false);
  await expect(preparation.apply(wrong)).rejects.toThrow('approval'); expect(existsSync(n.input.directory)).toBe(false);
  const applied = await preparation.apply(review.approvalDigest); preparation.close();
  expect(applied).toMatchObject({ result: 'enrollment-exported', readiness: 'unverified', startsService: false });
  const original = readHistoryEnrollmentFile(n.input.output), image = readFileSync(join(n.input.directory, 'admission-spends-v2.jsonl'));
  expect(applied.genesisId).toBe(original.genesisId);
  const protection = loadAdmissionHistoryProtectionFile(n.input.historyConfigFile);
  try {
    await expect(openAdmissionInitialReadiness({ directory: n.input.directory, policy: n.policy, encryptionKey: n.key, protection,
      genesisId: 'sha256:' + 'f'.repeat(64) })).rejects.toThrow('differs from');
  } finally { protection.signingKey.secretKey.fill(0); }
  await expect(openAdmissionOwnerSetup({ ...n.input, output: join(n.directory, 'another.json') })).rejects.toThrow('empty directory');
  const exported = await openAdmissionOwnerSetup({ ...n.input, output: join(n.directory, 'copy.json'), mode: 'export' }); cleanup.push(exported.close);
  expect(exported.review().genesisId).toBe(original.genesisId);
  await exported.apply(exported.review().approvalDigest); exported.close();
  expect(readHistoryEnrollmentFile(join(n.directory, 'copy.json'))).toEqual(original);
  expect(readFileSync(join(n.input.directory, 'admission-spends-v2.jsonl'))).toEqual(image);
});

it('binds nested owner keys, policy bytes, selected output and cancellation before any initial history is created', async () => {
  const n = await fixture(); await n.createConfig();
  const controller = new AbortController(), plan = await openAdmissionOwnerSetup(n.input, controller.signal); cleanup.push(plan.close);
  const source = readFileSync(n.configInput.ownerKeyFile); writeFileSync(n.configInput.ownerKeyFile, source + '\n');
  await expect(plan.apply(plan.review().approvalDigest)).rejects.toThrow('selection changed');
  writeFileSync(n.configInput.ownerKeyFile, source);
  writeFileSync(n.input.output, 'retain this partial export');
  await expect(plan.apply(plan.review().approvalDigest)).rejects.toThrow('already exists');
  expect(readFileSync(n.input.output, 'utf8')).toBe('retain this partial export'); rmSync(n.input.output);
  controller.abort(); await expect(plan.apply(plan.review().approvalDigest)).rejects.toThrow();
  expect(existsSync(n.input.directory)).toBe(false);
  await expect(openAdmissionOwnerSetup({ ...n.input, output: join(n.input.directory, 'enrollment.json') })).rejects.toThrow();
  await expect(openAdmissionOwnerSetup({ ...n.input, mode: 'resume' })).rejects.toThrow();
  expect(existsSync(n.input.directory)).toBe(false);
});

it('resumes only a published pristine baseline and preserves its exact genesis through interrupted archive publication', async () => {
  const n = await fixture(); await n.createConfig();
  const protection = loadAdmissionHistoryProtectionFile(n.input.historyConfigFile);
  const history = await openProtectedAdmissionSpendHistory({ directory: n.input.directory, policy: n.policy, authority: n.issuer.authority,
    encryptionKey: n.key, initialize: true, protection: { ...protection, initializeWriter: true } });
  const original = history.enrollment(); history.close(); protection.signingKey.secretKey.fill(0);
  const archive = join(n.input.directory, 'admission-history-writer', 'payloads'), index = join(archive, 'history-writer-payloads.json');
  rmSync(index); const temporary = join(archive, '.history-writer-payloads.json.' + 'b'.repeat(16) + '.tmp'); writeFileSync(temporary, 'unpublished partial ciphertext');
  await expect(openAdmissionOwnerSetup({ ...n.input, mode: 'export' })).rejects.toThrow('explicit pristine');
  const resumed = await openAdmissionOwnerSetup({ ...n.input, mode: 'resume' }); cleanup.push(resumed.close);
  expect(resumed.review()).toMatchObject({ initializeWriter: false, initializeArchive: true, spends: 0 });
  expect(existsSync(index)).toBe(false); expect(existsSync(temporary)).toBe(true);
  await resumed.apply(resumed.review().approvalDigest); resumed.close();
  expect(readHistoryEnrollmentFile(n.input.output).root).toEqual(original.root); expect(existsSync(index)).toBe(true); expect(existsSync(temporary)).toBe(false);
});

it.each(['writer', 'archive'] as const)('refuses missing committed %s even when initial setup resumption is explicitly selected', async part => {
  const n = await admissionActivationFixture(); cleanup.push(n.close);
  const imagePath = join(n.historyDirectory, 'admission-spends-v2.jsonl'), image = readFileSync(imagePath);
  const writer = join(n.historyDirectory, 'admission-history-writer');
  rmSync(part === 'writer' ? writer : join(writer, 'payloads'), { recursive: true });
  await expect(openAdmissionOwnerSetup({ historyConfigFile: n.input.historyConfigFile, policyFile: n.input.policyFile, storageKeyFile: n.input.storageKeyFile,
    directory: n.historyDirectory, output: join(n.directory, 'resumed.json'), mode: 'resume' })).rejects.toThrow('committed missing history');
  expect(readFileSync(imagePath)).toEqual(image); expect(existsSync(join(n.directory, 'resumed.json'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('refuses redirected parent paths between review and apply and leaves both destinations untouched', async () => {
  const n = await fixture(); await n.createConfig();
  const first = join(n.directory, 'first'), second = join(n.directory, 'second'), alias = join(n.directory, 'alias'); mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
  const input = { ...n.input, directory: join(alias, 'history') }, setup = await openAdmissionOwnerSetup(input); cleanup.push(setup.close);
  rmSync(alias); symlinkSync(second, alias);
  await expect(setup.apply(setup.review().approvalDigest)).rejects.toThrow('selection changed');
  expect(existsSync(join(first, 'history'))).toBe(false); expect(existsSync(join(second, 'history'))).toBe(false);
});

it('exposes the same reviewed configuration and owner preparation through fixed commands', async () => {
  const n = await fixture(), c = n.configInput, args = [c.ownerKeyFile, c.authorityFile, c.policyFile, c.membersFile, c.output];
  const plan = (await runAdmissionHistoryCommand('owner-config-plan', args)).result;
  await expect(runAdmissionHistoryCommand('owner-config-create', ['--approve', String(plan.approvalDigest), ...args])).rejects.toThrow('Invalid');
  await runAdmissionHistoryCommand('owner-config-create', ['--approve', String(plan.approvalDigest), ...args, String(plan.historyId)]);
  const input = n.input, setupArgs = ['new', input.historyConfigFile, input.policyFile, input.storageKeyFile, input.directory, input.output];
  const preparation = (await runAdmissionHistoryCommand('owner-setup-plan', setupArgs)).result;
  expect((await runAdmissionHistoryCommand('owner-setup-apply', ['--approve', String(preparation.approvalDigest), ...setupArgs])).result.readiness).toBe('unverified');
  const replicaArgs = [input.output, n.keyFile('member.json', n.memberKeys[0]), input.storageKeyFile, join(n.directory, 'replica')];
  const volunteer = (await runAdmissionHistoryCommand('replica-plan', replicaArgs)).result;
  expect((await runAdmissionHistoryCommand('replica-enroll', ['--approve', String(volunteer.approvalDigest), ...replicaArgs])).result.result).toBe('enrolled');
});

it.each(['before-baseline', 'after-baseline', 'before-writer', 'after-writer', 'before-archive', 'after-archive', 'during-export', 'after-export'])(
  'preserves initial setup and exclusive export after process death at %s', async boundary => {
    const n = await fixture(); await n.createConfig();
    const child = fork(fileURLToPath(new URL('./fixtures/admission-setup-crash.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let error = ''; child.stderr?.on('data', bytes => { error += String(bytes); }); child.on('message', value => { if (value !== 'ready') error += JSON.stringify(value); });
    const exited = once(child, 'exit'), timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      expect((await once(child, 'message'))[0]).toBe('ready'); child.send({ input: n.input, boundary });
      const [code, signal] = await exited; expect(code, error).toBe(null); expect(signal, error).toBe('SIGKILL'); expect(error).toBe('');
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    const imagePath = join(n.input.directory, 'admission-spends-v2.jsonl'), output = join(n.directory, 'recovered-enrollment.json');
    if (boundary === 'before-baseline') {
      expect(existsSync(imagePath)).toBe(false);
      await expect(openAdmissionOwnerSetup({ ...n.input, mode: 'resume', output })).rejects.toThrow();
      await expect(openAdmissionOwnerSetup({ ...n.input, output })).rejects.toThrow('empty directory');
      const fresh = await openAdmissionOwnerSetup({ ...n.input, directory: join(n.directory, 'separate-new-history'), output }); cleanup.push(fresh.close);
      await fresh.apply(fresh.review().approvalDigest); fresh.close(); return;
    }
    const protection = loadAdmissionHistoryProtectionFile(n.input.historyConfigFile);
    const inspection = await inspectProtectedAdmissionSpendHistory({ directory: n.input.directory, encryptionKey: n.key, policy: n.policy, authority: n.issuer.authority, protection });
    const baseline = inspection.read().root; inspection.close(); protection.signingKey.secretKey.fill(0);
    const originalOutput = existsSync(n.input.output) ? readFileSync(n.input.output) : undefined;
    if (originalOutput) await expect(openAdmissionOwnerSetup({ ...n.input, mode: 'resume' })).rejects.toThrow('already exists');
    const resume = await openAdmissionOwnerSetup({ ...n.input, mode: 'resume', output }); cleanup.push(resume.close);
    await resume.apply(resume.review().approvalDigest); resume.close();
    expect(readHistoryEnrollmentFile(output).root).toEqual(baseline);
    if (originalOutput) expect(readFileSync(n.input.output)).toEqual(originalOutput);
  }, 20000);
