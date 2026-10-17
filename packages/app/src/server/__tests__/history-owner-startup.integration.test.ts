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
import { admissionPolicyDigest, signAdmissionPolicy, openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { relayServiceEnvironment } from '../relay-supervisor.js';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openProtectedAdmissionSpendHistory } from '../../../../relay/src/protected-admission-history.js';
import { openHistoryVolunteerService } from '../../../../relay/src/history-volunteer-service.js';
import { openConfiguredHistoryVolunteer, readHistoryVolunteerConfigurationFile } from '../../../../relay/src/history-volunteer-config.js';
import { createRelayServer, type RelayServer } from '../../../../relay/src/server.js';
import { loadOrCreateRelayIdentity } from '../../../../relay/src/relay-identity-store.js';
import { historyCheckpointFixture } from '../../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { witnessFixture } from '../../../../relay/src/__tests__/fixtures/admission-witness-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(test: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!await test()) { if (Date.now() >= deadline) throw new Error('Protected owner startup did not settle'); await new Promise(r => setTimeout(r, 20)); }
}
function start(env: NodeJS.ProcessEnv) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url))],
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
async function fixture(withBridge = false, desktop = false) {
  const h = historyCheckpointFixture(), f = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'history-owner-start-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const policy = await signAdmissionPolicy({ ...f.body, keys: f.body.keys.map(({ witnesses, ...key }) => key) }, f.authority, f.authorityKey.secretKey);
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const ownerDirectory = join(directory, 'owner', ...(desktop ? ['relay-data'] : [])), ownerId = loadOrCreateRelayIdentity(ownerDirectory).did;
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
  let env: NodeJS.ProcessEnv = { RELAY_DATA_DIR: ownerDirectory, RELAY_ADMIN_API_KEY: 'test-admin', RELAY_ADMISSION_AUTHORITY_FILE: join(directory, 'authority.pub'),
    RELAY_ADMISSION_POLICY_FILE: json('policy.json', policy), RELAY_ADMISSION_POLICY_KEY_FILE: join(directory, 'storage.hex'),
    RELAY_ADMISSION_HISTORY_FILE: historyFile, RELAY_ADMISSION_HISTORY_LINKS_FILE: linksFile };
  for (let i = 0; i < 5; i++) {
    json(`member-${i}.json`, { publicKey: context.members[i], secretKey: Buffer.from(h.memberKeys[i].secretKey).toString('base64url') });
    const service = openHistoryVolunteerService({ directory: join(directory, `history-${i}`), context, genesisId: historyCheckpointEnvelopeId(root),
      localKey: h.localKey, signingKey: h.memberKeys[i], initialize: root }); service.close();
  }
  if (desktop) {
    const store = await openAdmissionPolicyStore({ path: join(ownerDirectory, 'admission-community-policy.json'), encryptionKey: h.key, mode: 'create-new' });
    try { await store.install(policy, f.authority); } finally { store.close(); }
    env = relayServiceEnvironment({ port: 0, dataDir: join(directory, 'owner'), adminKey: 'test-admin', contacts: [],
      nodePath: process.execPath, entryPath: fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)), workingDirectory: directory,
      admissionAuthorityFile: env.RELAY_ADMISSION_AUTHORITY_FILE, admissionPolicyFile: env.RELAY_ADMISSION_POLICY_FILE,
      admissionPolicyKeyFile: env.RELAY_ADMISSION_POLICY_KEY_FILE, admissionHistoryFile: historyFile, admissionHistoryLinksFile: linksFile });
  }
  const bridgeDirectory = join(directory, 'bridge', ...(desktop ? ['relay-data'] : [])), bridgeId = loadOrCreateRelayIdentity(bridgeDirectory).did;
  const passphraseFile = join(directory, 'bridge-passphrase.txt');
  if (desktop) writeFileSync(passphraseFile, 'desktop-bridge-test-passphrase\n', { mode: 0o600 });
  const bridgeFile = json('bridge.json', { version: 1, routes: ids.map(targetRelayId => ({ controllerRelayId: ownerId, targetRelayId })) });
  const bridgeEnv = desktop ? relayServiceEnvironment({ port: 0, dataDir: join(directory, 'bridge'), adminKey: 'test-admin', contacts: [],
    nodePath: process.execPath, entryPath: fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)), workingDirectory: directory,
    historyBridgeFile: bridgeFile, identityPassphraseFile: passphraseFile, publicEndpoints: ['ws://127.0.0.1:0/'] })
    : { RELAY_DATA_DIR: bridgeDirectory, RELAY_ADMIN_API_KEY: 'test-admin', RELAY_HISTORY_BRIDGE_FILE: bridgeFile };
  let bridge: ReturnType<typeof start> | undefined;
  if (withBridge) {
    bridge = start(bridgeEnv); const bridgePort = await bridge.listening();
    if (desktop) expect(JSON.parse(readFileSync(join(bridgeDirectory, 'relay-identity.json'), 'utf8')).kind).toBe('relay-infrastructure-identity-encrypted');
    json('links.json', { version: 2, members: context.members.map((publicKey, i) => ({ publicKey, relayId: ids[i] })),
      bridge: { relayId: bridgeId, endpoint: `ws://127.0.0.1:${bridgePort}/` } });
    env.RELAY_PUBLIC_ENDPOINTS = '';
  }
  async function restartBridge() {
    if (!bridge) throw new Error('No bridge in direct fixture');
    const port = bridge.port(); await bridge.close(); expect((await bridge.exited)[0]).toBe(0);
    bridge = start({ ...bridgeEnv, RELAY_PORT: String(port), RELAY_PUBLIC_ENDPOINTS: `ws://127.0.0.1:${port}/` }); await bridge.listening();
  }
  const volunteers: RelayServer[] = [], runtimes: ReturnType<typeof openConfiguredHistoryVolunteer>[] = [];
  cleanup.push(async () => { for (const server of volunteers) await server.stop({ graceful: false }); for (const role of runtimes) role.close(); });
  async function volunteer(i: number, port: number) {
    const path = json(`volunteer-${i}.json`, { version: 1, context, genesisId: historyCheckpointEnvelopeId(root), directory: `history-${i}`,
      signingKeyFile: `member-${i}.json`, storageKeyFile: 'volunteer-storage.hex',
      controllers: [{ relayId: withBridge ? bridgeId : ownerId, endpoint: `ws://127.0.0.1:${bridge?.port() ?? port}/` }],
      limits: { bytesPerGeneration: 16 * 1024 * 1024, blocksPerGeneration: 100, generations: 8 } });
    const config = readHistoryVolunteerConfigurationFile(path), runtime = openConfiguredHistoryVolunteer(config); runtimes.push(runtime);
    const server = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: memberDirs[i], historyLinks: runtime.router,
      relayDiscovery: { endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } },
      relayLinks: { targets: config.contacts, reconnectBaseMs: 50, reconnectMaxMs: 100 } });
    volunteers.push(server); await server.start(); return server;
  }
  return { f, directory, ownerDirectory, env, volunteer, volunteers, restartBridge,
    async connectedVolunteers(port: number) { return Number((await stats(bridge?.port() ?? port)).inbound_authenticated_relays) - (withBridge ? 1 : 0); } };

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

it.each(['direct', 'bridge', 'desktop-bridge'] as const)('starts transport before admission and preserves credentials across fourth-copy arrival/restart through %s connections', async topology => {
  const bridged = topology !== 'direct', desktop = topology === 'desktop-bridge';
  const n = await fixture(bridged, desktop); let owner = start({ ...n.env, ...(!desktop ? { RELAY_ADMISSION_POLICY_INITIALIZE: 'true' } : {}) });
  const port = await owner.listening(); expect(await health(port)).toBe(503); expect((await stats(port)).admission_ready).toBe(false);
  expect((await stats(port)).history).toMatchObject({ owner: { state: 'starting' },
    transport: { state: 'available', usage: { configuredMembers: 5, configuredOwnerBridges: bridged ? 1 : 0 } } });
  const token = await n.f.token(), first = publication();
  const frame = (record: ReturnType<typeof publication>, credential = token) => serializePublicationOperationFrame(createPublicationOperationFrame(record,
    presentBlindAdmissionTokenV2(credential, n.f.scope, 'publication-write', createAdmissionRequestBindingV2('publication-write', record))));
  const raw = frame(first);
  expect((await send(port, raw)).payload.message).toBe('admission_unavailable');
  for (const i of bridged ? [1, 2, 3] : [0, 1, 2]) await n.volunteer(i, port);
  await waitFor(async () => await n.connectedVolunteers(port) === 3);
  if (bridged) expect(await (await fetch(`http://127.0.0.1:${port}/relay-descriptor`)).json()).toMatchObject({ endpoints: [], reachability: 'outbound-only' });
  expect(await health(port)).toBe(503); expect((await send(port, raw)).payload.message).toBe('admission_unavailable');
  expect((await stats(port)).stored_publications).toBe(0);
  await n.volunteer(bridged ? 4 : 3, port); await waitFor(async () => await health(port) === 200);
  expect((await stats(port)).admission_ready).toBe(true); expect(owner.output()).toContain('"event":"admission_ready"');
  expect((await stats(port)).history).toMatchObject({ owner: { state: 'available', usage: { initialized: true, pending: false, retainedBlocks: 1 } } });
  expect((await send(port, raw)).payload.message).toBe('accepted');
  const history = (await stats(port)).history;
  expect(history).toMatchObject({ owner: { state: 'available', usage: { pending: false, retainedBlocks: 2 } } });
  expect(JSON.stringify(history)).not.toMatch(/did:key:|sha256:|replica|envelope|rootId|authority|signature|secretKey/);
  expect((await fetch(`http://127.0.0.1:${port}/stats`)).status).toBe(401);
  expect((await send(port, raw)).payload.message).toBe('duplicate');
  expect((await send(port, frame(publication()))).payload.message).toBe('admission_rejected');
  if (bridged) {
    await n.restartBridge(); await waitFor(async () => await n.connectedVolunteers(port) === 4);
    expect((await send(port, frame(publication(), await n.f.token()))).payload.message).toBe('accepted');
  }
  await owner.close(); expect((await owner.exited)[0]).toBe(0);
  owner = start({ ...n.env, RELAY_PORT: String(port) }); await owner.listening(); await waitFor(async () => await health(port) === 200);
  expect((await send(port, raw)).payload.message).toBe('duplicate');
  expect((await send(port, frame(publication()))).payload.message).toBe('admission_rejected');
  expect((await stats(port)).stored_publications).toBe(bridged ? 2 : 1);
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
