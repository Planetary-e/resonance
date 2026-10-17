import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createAdmissionRequestBindingV2, createPublicationRecord, generatePublicationKeyMaterial,
  presentBlindAdmissionTokenV2, serializePublicationOperationFrame, createPublicationOperationFrame,
  parseMessage, type Message, type AckPayload } from '@resonance/core';
import { admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { openConfiguredHistoryVolunteer, readHistoryVolunteerConfigurationFile } from '../history-volunteer-config.js';
import { createRelayServer, type RelayServer } from '../server.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(test: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!await test()) { if (Date.now() >= deadline) throw new Error('Protected owner startup did not settle'); await new Promise(r => setTimeout(r, 20)); }
}
function start(env: NodeJS.ProcessEnv) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../main.ts', import.meta.url))],
    { env: { ...inherited, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_PUBLIC_ENDPOINTS: `ws://127.0.0.1:${env.RELAY_PORT ?? '0'}/`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '', port = 0;
  const read = (bytes: Buffer) => {
    output += bytes.toString();
    for (const line of output.split('\n')) { try { const log = JSON.parse(line); if (log.event === 'started') port = log.port; } catch { /* partial line */ } }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  cleanup.push(close); return { child, exited, close, output: () => output, port: () => port,
    async listening() { await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owner refused startup: ${output}`);
      return port > 0;
    }); return port; } };
}
async function fixture() {
  const h = historyCheckpointFixture(), f = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'history-owner-start-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const policy = await signAdmissionPolicy({ ...f.body, keys: f.body.keys.map(({ witnesses, ...key }) => key) }, f.authority, f.authorityKey.secretKey);
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const ownerDirectory = join(directory, 'owner'), ownerId = loadOrCreateRelayIdentity(ownerDirectory).did;
  const memberDirs = context.members.map((_, i) => join(directory, `relay-${i}`));
  const ids = memberDirs.map(path => loadOrCreateRelayIdentity(path).did);
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${i + 1}/history-checkpoint` }));
  const initial = await openProtectedAdmissionSpendHistory({ directory: ownerDirectory, encryptionKey: h.key, authority: f.authority, policy,
    initialize: true, protection: { context, members, signingKey: h.owner, initializeWriter: true } });
  const root = initial.enrollment().root; initial.close();
  function json(name: string, value: unknown) { const path = join(directory, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; }
  json('owner-key.json', { publicKey: context.owner, secretKey: Buffer.from(h.owner.secretKey).toString('base64url') });
  writeFileSync(join(directory, 'authority.pub'), f.authority); writeFileSync(join(directory, 'storage.hex'), h.key.toString('hex'), { mode: 0o600 });
  writeFileSync(join(directory, 'volunteer-storage.hex'), h.localKey.toString('hex'), { mode: 0o600 });
  const historyFile = json('history.json', { version: 1, context, members, ownerKeyFile: 'owner-key.json' });
  const linksFile = json('links.json', { version: 1, members: context.members.map((publicKey, i) => ({ publicKey, relayId: ids[i] })) });
  const env = { RELAY_DATA_DIR: ownerDirectory, RELAY_ADMIN_API_KEY: 'test-admin', RELAY_ADMISSION_AUTHORITY_FILE: join(directory, 'authority.pub'),
    RELAY_ADMISSION_POLICY_FILE: json('policy.json', policy), RELAY_ADMISSION_POLICY_KEY_FILE: join(directory, 'storage.hex'),
    RELAY_ADMISSION_HISTORY_FILE: historyFile, RELAY_ADMISSION_HISTORY_LINKS_FILE: linksFile };
  for (let i = 0; i < 5; i++) {
    json(`member-${i}.json`, { publicKey: context.members[i], secretKey: Buffer.from(h.memberKeys[i].secretKey).toString('base64url') });
    const service = openHistoryVolunteerService({ directory: join(directory, `history-${i}`), context, genesisId: historyCheckpointEnvelopeId(root),
      localKey: h.localKey, signingKey: h.memberKeys[i], initialize: root }); service.close();
  }
  const volunteers: RelayServer[] = [], runtimes: ReturnType<typeof openConfiguredHistoryVolunteer>[] = [];
  cleanup.push(async () => { for (const server of volunteers) await server.stop({ graceful: false }); for (const role of runtimes) role.close(); });
  async function volunteer(i: number, port: number) {
    const path = json(`volunteer-${i}.json`, { version: 1, context, genesisId: historyCheckpointEnvelopeId(root), directory: `history-${i}`,
      signingKeyFile: `member-${i}.json`, storageKeyFile: 'volunteer-storage.hex',
      controllers: [{ relayId: ownerId, endpoint: `ws://127.0.0.1:${port}/` }],
      limits: { bytesPerGeneration: 16 * 1024 * 1024, blocksPerGeneration: 100, generations: 8 } });
    const config = readHistoryVolunteerConfigurationFile(path), runtime = openConfiguredHistoryVolunteer(config); runtimes.push(runtime);
    const server = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: memberDirs[i], historyLinks: runtime.router,
      relayDiscovery: { endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
      relayLinks: { targets: config.contacts, reconnectBaseMs: 50, reconnectMaxMs: 100 } });
    volunteers.push(server); await server.start(); return server;
  }
  return { f, directory, ownerDirectory, env, volunteer, volunteers };
}
async function stats(port: number) { return await (await fetch(`http://127.0.0.1:${port}/stats?key=test-admin`)).json() as Record<string, unknown>; }
async function health(port: number) { return (await fetch(`http://127.0.0.1:${port}/health`)).status; }
const publication = () => { const now = Date.now(); return createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
  fingerprint: new Uint8Array(64).fill(0x42), itemType: 'offer', createdAt: now, expiresAt: now + 86400000 }, generatePublicationKeyMaterial()); };
async function send(port: number, raw: string) {
  return new Promise<Message<AckPayload>>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Publication request timed out')); }, 10000);
    socket.once('open', () => socket.send(raw)); socket.once('message', data => { clearTimeout(timer); socket.close(); resolve(parseMessage(data.toString()) as Message<AckPayload>); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

it('starts transport before admission, rejects at three copies without spending and accepts the same credential after a fourth reverse connection', async () => {
  const n = await fixture(); let owner = start({ ...n.env, RELAY_ADMISSION_POLICY_INITIALIZE: 'true' });
  const port = await owner.listening(); expect(await health(port)).toBe(503); expect((await stats(port)).admission_ready).toBe(false);
  const token = await n.f.token(), first = publication();
  const frame = (record: ReturnType<typeof publication>) => serializePublicationOperationFrame(createPublicationOperationFrame(record,
    presentBlindAdmissionTokenV2(token, n.f.scope, 'publication-write', createAdmissionRequestBindingV2('publication-write', record))));
  const raw = frame(first);
  expect((await send(port, raw)).payload.message).toBe('admission_unavailable');
  for (let i = 0; i < 3; i++) await n.volunteer(i, port);
  await waitFor(async () => (await stats(port)).inbound_authenticated_relays === 3);
  expect(await health(port)).toBe(503); expect((await send(port, raw)).payload.message).toBe('admission_unavailable');
  expect((await stats(port)).stored_publications).toBe(0);
  await n.volunteer(3, port); await waitFor(async () => await health(port) === 200);
  expect((await stats(port)).admission_ready).toBe(true); expect(owner.output()).toContain('"event":"admission_ready"');
  expect((await send(port, raw)).payload.message).toBe('accepted');
  expect((await send(port, raw)).payload.message).toBe('duplicate');
  expect((await send(port, frame(publication()))).payload.message).toBe('admission_rejected');
  await owner.close(); expect((await owner.exited)[0]).toBe(0);
  owner = start({ ...n.env, RELAY_PORT: String(port) }); await owner.listening(); await waitFor(async () => await health(port) === 200);
  expect((await send(port, raw)).payload.message).toBe('duplicate');
  expect((await send(port, frame(publication()))).payload.message).toBe('admission_rejected');
  expect((await stats(port)).stored_publications).toBe(1);
}, 60000);

it('cancels an unready owner cleanly, reopens its exact history and refuses missing state without enabling admission', async () => {
  const n = await fixture(), history = join(n.ownerDirectory, 'admission-spends-v2.jsonl');
  let owner = start({ ...n.env, RELAY_ADMISSION_POLICY_INITIALIZE: 'true' }); await owner.listening();
  expect(await health(owner.port())).toBe(503); await owner.close(); expect((await owner.exited)[0]).toBe(0);
  const retained = readFileSync(history); owner = start(n.env); const port = await owner.listening();
  expect(readFileSync(history)).toEqual(retained);
  for (let i = 0; i < 4; i++) await n.volunteer(i, port);
  await waitFor(async () => await health(port) === 200); await owner.close(); expect((await owner.exited)[0]).toBe(0);
  const committed = readFileSync(history);
  const missing = start({ ...n.env, RELAY_DATA_DIR: join(n.directory, 'missing'), RELAY_ADMISSION_POLICY_INITIALIZE: 'true' });
  const timeout = setTimeout(() => missing.child.kill('SIGKILL'), 15000);
  try { expect((await missing.exited)[0]).toBe(1); } finally { clearTimeout(timeout); }
  expect(missing.output()).toContain('"event":"admission_startup_failed"'); expect(missing.output()).not.toContain('"event":"admission_ready"');
  expect(readFileSync(history)).toEqual(committed);
}, 60000);
