import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { loadAdmissionHistoryProtectionFile } from '../admission-history-config.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function command(...args: string[]) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>(resolve => execFile(process.execPath, ['--import', 'tsx', script, ...args],
    { timeout: 20000, maxBuffer: 65536 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}
async function succeed(...args: string[]) { const r = await command(...args); expect(r.stderr).toBe(''); expect(r.code).toBe(0); return JSON.parse(r.stdout); }
async function setup() {
  const issuer = await witnessFixture(), f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-operator-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const { witnesses: _, ...entry } = issuer.body.keys[0];
  const policy = await signAdmissionPolicy({ ...issuer.body, keys: [entry] }, issuer.authority, issuer.authorityKey.secretKey);
  const context = { ...f.context, authority: issuer.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const config = { version: 1, context, ownerKeyFile: 'owner-private.json', members: context.members.map((publicKey, i) => (
    { publicKey, endpoint: `ws://127.0.0.1:${43000 + i}/history-checkpoint` }
  )) };
  const keyFile = join(directory, 'owner-storage.hex'), configFile = join(directory, 'owner-config.json'), policyFile = join(directory, 'policy.json');
  writeFileSync(configFile, JSON.stringify(config)); writeFileSync(keyFile, f.key.toString('hex'), { mode: 0o600 }); writeFileSync(policyFile, JSON.stringify(policy));
  const key = (path: string, pair: typeof f.owner) => writeFileSync(path, JSON.stringify({ publicKey: Buffer.from(pair.publicKey).toString('base64url'),
    secretKey: Buffer.from(pair.secretKey).toString('base64url') }), { mode: 0o600 });
  key(join(directory, config.ownerKeyFile), f.owner);
  rmSync(configFile); const authorityFile = join(directory, 'authority.pub'), membersFile = join(directory, 'members.json');
  writeFileSync(authorityFile, issuer.authority); writeFileSync(membersFile, JSON.stringify(config.members));
  await succeed('owner-config', join(directory, config.ownerKeyFile), authorityFile, policyFile, membersFile, configFile);
  const generated = JSON.parse(readFileSync(configFile, 'utf8')) as typeof config;
  const ownerDirectory = join(directory, 'owner'), enrollment = join(directory, 'enrollment.json');
  const ownerArgs = [configFile, policyFile, keyFile, ownerDirectory, enrollment];
  const replicaArgs = context.members.map((_, i) => {
    const privateFile = join(directory, `member-${i}.json`), storageFile = join(directory, `member-${i}.hex`);
    key(privateFile, f.memberKeys[i]); writeFileSync(storageFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    return [enrollment, privateFile, storageFile, join(directory, `replica-${i}`)];
  });
  return { ...f, issuer, policy, context: generated.context, config: generated, directory, configFile, keyFile, policyFile,
    ownerDirectory, enrollment, ownerArgs, replicaArgs };
}
async function serve(args: string[], port = '0') {
  const child = spawn(process.execPath, ['--import', 'tsx', script, 'replica-serve', ...args, port], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stdout = '', stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  async function close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; }
  cleanup.push(close);
  const ready = await new Promise<{ checkpointEndpoint: string; agreementEndpoint: string; generations: number }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Volunteer command did not start')); }, 15000);
    child.stdout.on('data', bytes => {
      stdout += bytes.toString(); if (!stdout.includes('\n')) return;
      try { const value = JSON.parse(stdout.split('\n')[0]); clearTimeout(timer); resolve(value); }
      catch { clearTimeout(timer); reject(new Error('Invalid volunteer startup output')); }
    });
    exited.then(() => { clearTimeout(timer); if (!stdout.includes('\n')) reject(new Error(`Volunteer command refused startup: ${stderr}`)); });
  });
  return { ...ready, close, exited };
}

it('prepares and enrolls five volunteer processes through the CLI, refuses three copies, then accepts a real token without losing its binding', async () => {
  const n = await setup(), exported = await succeed('owner-prepare', ...n.ownerArgs);
  expect(exported.readiness).toBe('unverified');
  expect(JSON.stringify(JSON.parse(readFileSync(n.enrollment, 'utf8')))).not.toContain(Buffer.from(n.owner.secretKey).toString('base64url'));
  const volunteers: Awaited<ReturnType<typeof serve>>[] = [];
  for (const args of n.replicaArgs) {
    const plan = await succeed('replica-plan', ...args); expect(existsSync(args[3])).toBe(false);
    await succeed('replica-enroll', '--approve', plan.approvalDigest, ...args); volunteers.push(await serve(args));
  }
  const members = n.context.members.map((publicKey, i) => ({ publicKey, endpoint: volunteers[i].checkpointEndpoint }));
  writeFileSync(n.configFile, JSON.stringify({ ...n.config, members }));
  await volunteers[3].close(); await volunteers[4].close();
  expect((await command('owner-inspect', n.configFile, n.enrollment)).code).not.toBe(0);
  const protection = loadAdmissionHistoryProtectionFile(n.configFile); cleanup.push(() => { protection.signingKey.secretKey.fill(0); });
  const options = { directory: n.ownerDirectory, policy: n.policy, authority: n.context.authority, encryptionKey: n.key,
    historyProtection: protection, initializeSpendHistory: false };
  await expect(createConfiguredAdmissionVerifier({ ...options, initialize: true })).rejects.toThrow('Four durable');
  volunteers[3] = await serve(n.replicaArgs[3], new URL(members[3].endpoint).port);
  const verifier = await createConfiguredAdmissionVerifier(options); cleanup.push(() => verifier.close());
  const binding = createAdmissionRequestBindingV2('search', { query: 'CLI prepared history' }), token = await n.issuer.token();
  const capability = presentBlindAdmissionTokenV2(token, n.issuer.scope, 'search', binding), ctx = { action: 'search' as const, requestBinding: binding, now: Date.now() };
  expect(await verifier.verifyAndSpend(capability, ctx)).toEqual({ status: 'accepted' });
  expect(await verifier.verifyAndSpend(capability, ctx)).toEqual({ status: 'replay' });
  const different = createAdmissionRequestBindingV2('search', { query: 'different request' });
  expect(await verifier.verifyAndSpend(presentBlindAdmissionTokenV2(token, n.issuer.scope, 'search', different), { ...ctx, requestBinding: different }))
    .toEqual({ status: 'rejected', reason: 'double_spend' }); verifier.close();
  const reexport = [...n.ownerArgs]; reexport[4] = join(n.directory, 'reexport.json');
  expect((await succeed('owner-export', ...reexport)).genesisId).toBe(exported.genesisId);
  expect(readFileSync(reexport[4])).toEqual(readFileSync(n.enrollment));
  const damaged = join(n.directory, 'committed-but-missing-writer'); cpSync(n.ownerDirectory, damaged, { recursive: true });
  rmSync(join(damaged, 'admission-history-writer'), { recursive: true });
  const retained = readFileSync(join(damaged, 'admission-spends-v2.jsonl'));
  const recovery = [...n.ownerArgs]; recovery[3] = damaged; recovery[4] = join(n.directory, 'must-not-reset.json');
  expect((await command('owner-resume-setup', ...recovery)).code).not.toBe(0);
  expect(readFileSync(join(damaged, 'admission-spends-v2.jsonl'))).toEqual(retained);
  expect(existsSync(join(damaged, 'admission-history-writer'))).toBe(false);
  rmSync(n.ownerDirectory, { recursive: true });
  expect(await succeed('owner-inspect', n.configFile, n.enrollment)).toEqual({ result: 'history-observed', contextId: exported.contextId,
    genesisId: exported.genesisId, certifiedBoundaries: 0, observedGeneration: 0, readiness: 'unverified', mutation: 'none' });
  expect(existsSync(n.ownerDirectory)).toBe(false);
}, 60000);

it('binds enrollment approval to member, destination and local key, and never resets existing or missing owner history', async () => {
  const n = await setup(); await succeed('owner-prepare', ...n.ownerArgs);
  const args = n.replicaArgs[0], plan = await succeed('replica-plan', ...args);
  const bad = await command('replica-enroll', '--approve', 'unreviewed', ...args);
  expect(bad.code).not.toBe(0); expect(existsSync(args[3])).toBe(false);
  const changed = [...args]; changed[3] = join(n.directory, 'different');
  expect((await command('replica-enroll', '--approve', plan.approvalDigest, ...changed)).code).not.toBe(0); expect(existsSync(changed[3])).toBe(false);
  const otherMember = [...args]; otherMember[1] = n.replicaArgs[1][1];
  expect((await command('replica-enroll', '--approve', plan.approvalDigest, ...otherMember)).code).not.toBe(0);
  writeFileSync(args[2], randomBytes(32).toString('hex'));
  expect((await command('replica-enroll', '--approve', plan.approvalDigest, ...args)).code).not.toBe(0);
  const fresh = await succeed('replica-plan', ...args); await succeed('replica-enroll', '--approve', fresh.approvalDigest, ...args);
  expect((await command('replica-enroll', '--approve', fresh.approvalDigest, ...args)).code).not.toBe(0);
  const owner = [...n.ownerArgs]; owner[4] = join(n.directory, 'cannot-reset.json');
  expect((await command('owner-prepare', ...owner)).code).not.toBe(0); expect(existsSync(owner[4])).toBe(false);
  owner[3] = join(n.directory, 'missing-owner');
  expect((await command('owner-resume-setup', ...owner)).code).not.toBe(0);
  expect(existsSync(join(owner[3], 'admission-spends-v2.jsonl'))).toBe(false);
}, 60000);

it('resumes an explicitly pristine owner writer, reuses its exact genesis and preserves partial output files', async () => {
  const n = await setup(); const original = await succeed('owner-prepare', ...n.ownerArgs);
  rmSync(join(n.ownerDirectory, 'admission-history-writer'), { recursive: true });
  const next = [...n.ownerArgs]; next[4] = join(n.directory, 'resumed.json');
  expect((await command('owner-export', ...next)).code).not.toBe(0);
  expect((await succeed('owner-resume-setup', ...next)).genesisId).toBe(original.genesisId);
  expect(readFileSync(next[4])).toEqual(readFileSync(n.enrollment));
  next[4] = join(n.directory, 'interrupted.json'); writeFileSync(next[4], '{"partial":');
  expect((await command('owner-export', ...next)).code).not.toBe(0); expect(readFileSync(next[4], 'utf8')).toBe('{"partial":');
}, 30000);

it('refuses an untrusted policy authority or duplicate member pins before writing a new owner configuration', async () => {
  const n = await setup(), wrongAuthority = join(n.directory, 'wrong-authority.pub'), members = join(n.directory, 'candidate-members.json');
  const output = join(n.directory, 'refused-config.json');
  writeFileSync(wrongAuthority, n.context.members[0]); writeFileSync(members, JSON.stringify(n.config.members));
  const args = [n.config.ownerKeyFile, wrongAuthority, n.policyFile, members, output];
  expect((await command('owner-config', ...args)).code).not.toBe(0); expect(existsSync(output)).toBe(false);
  writeFileSync(wrongAuthority, n.context.authority);
  writeFileSync(members, JSON.stringify(n.config.members.map(() => n.config.members[0])));
  expect((await command('owner-config', ...args)).code).not.toBe(0); expect(existsSync(output)).toBe(false);
});
