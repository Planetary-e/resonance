import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { generateIdentity } from '@resonance/core';
import { loadAdmissionHistoryProtectionFile, readAdmissionHistoryLinksFile } from '../admission-history-config.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { prepareAdmissionHistoryRestore } from '../admission-history-restore.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function configFiles(f: ReturnType<typeof historyCheckpointFixture>, directory: string, members = f.context.members.map((publicKey, i) => (
  { publicKey, endpoint: `ws://127.0.0.1:${42000 + i}/history-checkpoint` }
))) {
  const path = join(directory, 'history.json'), owner = join(directory, 'owner.json');
  const value = { version: 1, context: f.context, members, ownerKeyFile: 'owner.json' };
  writeFileSync(path, JSON.stringify(value)); writeFileSync(owner, JSON.stringify({ publicKey: Buffer.from(f.owner.publicKey).toString('base64url'),
    secretKey: Buffer.from(f.owner.secretKey).toString('base64url') }), { mode: 0o600 });
  return { path, owner, value };
}
function fixture() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'admission-config-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true })); return { f, directory, ...configFiles(f, directory) };
}
it('loads exact owner/member pins relative to its configuration without creating or initializing history', () => {
  const n = fixture(), key = Buffer.from(n.f.owner.secretKey), p = loadAdmissionHistoryProtectionFile(n.path);
  expect(p.context).toEqual(n.f.context); expect(p.members).toEqual(n.value.members);
  expect(Buffer.from(p.signingKey.secretKey)).toEqual(key); expect(p.initializeWriter).toBeUndefined(); expect(p.promoteLocalHistory).toBeUndefined();
  p.signingKey.secretKey.fill(0); expect(Buffer.from(n.f.owner.secretKey)).toEqual(key);
});
it('refuses unpinned or duplicate members, insecure remote transport and initialization instructions', () => {
  const n = fixture();
  const invalid = [
    { ...n.value, initializeWriter: true }, { ...n.value, context: { ...n.value.context, quorum: 3 } },
    { ...n.value, members: n.value.members.slice(1) },
    { ...n.value, members: n.value.members.map((m, i) => i === 4 ? n.value.members[0] : m) },
    { ...n.value, members: n.value.members.map(m => ({ ...m, endpoint: n.value.members[0].endpoint })) },
    { ...n.value, members: n.value.members.map((m, i) => i === 4 ? { ...m, publicKey: n.value.context.owner } : m) },
    { ...n.value, members: n.value.members.map(m => ({ ...m, endpoint: 'ws://example.com/history-checkpoint' })) },
  ];
  for (const value of invalid) { writeFileSync(n.path, JSON.stringify(value)); expect(() => loadAdmissionHistoryProtectionFile(n.path)).toThrow(); }
});
it('bounds regular-file input, rejects a different owner and does not echo malformed private material', () => {
  const n = fixture(); expect(() => loadAdmissionHistoryProtectionFile(n.directory)).toThrow('regular file');
  writeFileSync(n.path, ' '.repeat(65537)); expect(() => loadAdmissionHistoryProtectionFile(n.path)).toThrow('regular file');
  writeFileSync(n.path, JSON.stringify(n.value));
  const other = historyCheckpointFixture().owner;
  writeFileSync(n.owner, JSON.stringify({ publicKey: Buffer.from(other.publicKey).toString('base64url'), secretKey: Buffer.from(other.secretKey).toString('base64url') }));
  expect(() => loadAdmissionHistoryProtectionFile(n.path)).toThrow('pinned context');
  writeFileSync(n.owner, '{"secretKey":"never-log-this-private-input"');
  try { loadAdmissionHistoryProtectionFile(n.path); throw new Error('Expected refusal'); }
  catch (error) { expect(String(error)).toContain('not valid JSON'); expect(String(error)).not.toContain('never-log'); }
});

function startRelay(env: NodeJS.ProcessEnv) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../main.ts', import.meta.url))],
    { env: { ...inherited, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '';
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Relay startup exceeded test budget')); }, 20000);
    const read = (bytes: Buffer) => { output += bytes.toString(); if (output.includes('"event":"started"')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    exited.then(() => { clearTimeout(timer); if (!output.includes('"event":"started"')) reject(new Error('Relay refused startup')); });
  });
  // Negative cases wait on process exit; observe this rejection immediately too.
  started.catch(() => {});
  async function close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; }
  cleanup.push(close);
  return { child, started, exited, close, output: () => output };
}
it('gates the real relay process on four copies, resumes exact pending state and refuses local-only fallback or missing history', async () => {
  const n = await admissionRestoreFixture(true); cleanup.push(() => n.close());
  const files = configFiles(n, n.directory, n.members), input = n.restoreOptions(), preparation = await prepareAdmissionHistoryRestore(input);
  const h = await openProtectedAdmissionSpendHistory({ ...input, authority: n.context.authority, initialize: true,
    protection: { context: n.context, signingKey: n.owner, members: n.members, initializeWriter: true,
      restore: { preparation, approvedDigest: preparation.review.approvalDigest } } }); h.close();
  const authority = join(n.directory, 'authority.pub'), policy = join(n.directory, 'policy.json'), key = join(n.directory, 'policy-key.hex');
  writeFileSync(authority, n.context.authority); writeFileSync(policy, JSON.stringify(n.policy)); writeFileSync(key, n.key.toString('hex'), { mode: 0o600 });
  const env = { RELAY_DATA_DIR: input.directory, RELAY_ADMISSION_AUTHORITY_FILE: authority,
    RELAY_ADMISSION_POLICY_FILE: policy, RELAY_ADMISSION_POLICY_KEY_FILE: key, RELAY_ADMISSION_HISTORY_FILE: files.path };
  writeFileSync(files.path, JSON.stringify({ ...files.value, members: n.members.map((m, i) => i < 3 ? m : {
    ...m, endpoint: `ws://127.0.0.1:${i - 2}/history-checkpoint`,
  }) }));
  const refused = startRelay({ ...env, RELAY_ADMISSION_POLICY_INITIALIZE: 'true' });
  expect((await refused.exited)[0]).not.toBe(0); expect(refused.output()).toContain('Four durable history acknowledgements unavailable');
  expect(refused.output()).not.toContain('"event":"started"');
  writeFileSync(files.path, JSON.stringify(files.value));
  const running = startRelay(env); await running.started; await running.close(); expect((await running.exited)[0]).toBe(0);
  const resumed = await openProtectedAdmissionSpendHistory({ ...input, authority: n.context.authority,
    protection: { context: n.context, signingKey: n.owner, members: n.members } });
  try { await resumed.ready(); expect(resumed.read().image).toEqual(n.image); expect(resumed.read().applied?.sequence).toBe(0); }
  finally { resumed.close(); }
  const bytes = readFileSync(join(input.directory, 'admission-spends-v2.jsonl'));
  const fallback = startRelay({ ...env, RELAY_ADMISSION_HISTORY_FILE: '' });
  expect((await fallback.exited)[0]).not.toBe(0); expect(fallback.output()).not.toContain('"event":"started"');
  expect(readFileSync(join(input.directory, 'admission-spends-v2.jsonl'))).toEqual(bytes);
  const missing = startRelay({ ...env, RELAY_DATA_DIR: join(n.directory, 'missing-history'), RELAY_ADMISSION_POLICY_INITIALIZE: 'true' });
  expect((await missing.exited)[0]).not.toBe(0); expect(missing.output()).toContain('missing'); expect(missing.output()).not.toContain('"event":"started"');
  const noPolicy = startRelay({ RELAY_DATA_DIR: join(n.directory, 'no-policy'), RELAY_ADMISSION_HISTORY_FILE: files.path });
  expect((await noPolicy.exited)[0]).not.toBe(0); expect(noPolicy.output()).toContain('requires all three');
}, 60000);

it('requires all five existing history members and distinct explicit infrastructure pins for reverse startup', () => {
  const n = fixture(), path = join(n.directory, 'links.json');
  const value = { version: 1, members: n.f.context.members.map(publicKey => ({ publicKey, relayId: generateIdentity().did })) };
  writeFileSync(path, JSON.stringify(value)); expect(readAdmissionHistoryLinksFile(path, n.f.context)).toEqual(value.members);
  const invalid = [{ ...value, initialize: true }, { ...value, members: value.members.slice(1) },
    { ...value, members: value.members.map((m, i) => i === 4 ? value.members[0] : m) },
    { ...value, members: value.members.map(m => ({ ...m, relayId: value.members[0].relayId })) },
    { ...value, members: value.members.map((m, i) => i === 4 ? { ...m, publicKey: n.f.context.owner } : m) },
    { ...value, members: value.members.map(m => ({ ...m, relayId: 'not-a-pin' })) },
    { ...value, members: value.members.map(m => ({ ...m, endpoint: 'wss://implicit.example/' })) }];
  for (const raw of invalid) { writeFileSync(path, JSON.stringify(raw)); expect(() => readAdmissionHistoryLinksFile(path, n.f.context)).toThrow(); }
  writeFileSync(path, ' '.repeat(65537)); expect(() => readAdmissionHistoryLinksFile(path, n.f.context)).toThrow('regular file');
  expect(() => readAdmissionHistoryLinksFile(n.directory, n.f.context)).toThrow('regular file');
});
