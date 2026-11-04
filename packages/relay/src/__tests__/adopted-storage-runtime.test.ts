import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { openRelayStorageOwner, withRelayStorageControls } from '../relay-storage-owner.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPublicationRecord, generatePublicationKeyMaterial, createPublicationOperationFrame, serializePublicationOperationFrame, parseMessage } from '@resonance/core';
import { openStorageReservationAuthority, openReservedStorageControl, withStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { beginRelayMaintenance, finishRelayMaintenance } from '../relay-maintenance.js';
import { RELAY_OPERATION_LOG_FILENAME } from '../operation-log.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const holder = createServer(); holder.listen(0, '127.0.0.1'); await once(holder, 'listening');
  const port = (holder.address() as { port: number }).port; await new Promise<void>(resolve => holder.close(() => resolve()));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'adopted-runtime-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), managed = join(directory, 'managed'), data = join(managed, 'runtime'), diagnostics = join(managed, 'diagnostics');
  mkdirSync(managed); writeFileSync(join(managed, 'unknown-retained'), 'retain old work');
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + 20 * 1024 * 1024 }); cleanup.push(authority.close);
  const targets = [{ path: managed, scope: 'directory' as const }], review = authority.reviewExisting(targets); authority.adoptExisting(targets, review.approvalDigest);
  const id = authority.status().authorityId; authority.close();
  const open = () => { const value = openStorageReservationAuthority({ directory: ledger, authorityId: id, mode: 'open-existing', requireAdoptedScopes: true }); cleanup.push(value.close); return value; };
  const pins = { authorityDirectory: ledger, authorityId: id, runtimeDirectory: data }, binding = { runtimePort: port, runtimeHost: '127.0.0.1' as const };
  const runtime = openRelayStorageOwner(pins, 'runtime'); runtime.run(() => beginRelayMaintenance(data)); runtime.close();
  const stopped = openRelayStorageOwner(pins, 'maintenance'), selected = join(managed, 'selection.json');
  stopped.exportSelection(selected, binding, stopped.reviewSelectionOutput(selected, binding).approvalDigest); stopped.close();
  withRelayStorageControls(pins, [], () => finishRelayMaintenance(data));
  return { directory, ledger, managed, data, diagnostics, id, open, port, selected };
}
function start(n: Awaited<ReturnType<typeof fixture>>, overrides: NodeJS.ProcessEnv = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../main.ts', import.meta.url))], {
    env: { ...inherited, RELAY_DATA_DIR: n.data, RELAY_DIAGNOSTICS_DIRECTORY: n.diagnostics, RELAY_HOST: '127.0.0.1', RELAY_PORT: String(n.port), RELAY_STORAGE_SELECTION_FILE: n.selected,
      RELAY_STORAGE_CAPACITY_BYTES: '1048576', RELAY_STORAGE_AVAILABLE_BYTES: '1048576', RELAY_JOURNAL_STORAGE_QUOTA_BYTES: '1048576',
      RELAY_CONTACTS: '', RELAY_PUBLIC_ENDPOINTS: '', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let output = '', port = 0;
  const read = (bytes: Buffer) => { output += bytes.toString(); for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.event === 'started') port = value.port; } catch { /* partial log */ } } };
  child.stdout.on('data', read); child.stderr.on('data', read);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 25000);
  exited.finally(() => clearTimeout(deadline));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, exited, output: () => output, async listening() {
    const until = performance.now() + 15000;
    while (!port) { if (child.exitCode !== null || child.signalCode !== null || performance.now() > until) throw new Error(`Relay did not start: ${output}`); await new Promise(resolve => setTimeout(resolve, 20)); }
    return port;
  } };
}
function publication() { const now = Date.now(); return createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'adopted-runtime',
  fingerprint: new Uint8Array(64).fill(5), itemType: 'offer', createdAt: now, expiresAt: now + 3600000 }, generatePublicationKeyMaterial()); }
async function publish(port: number, record: ReturnType<typeof publication>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`), timer = setTimeout(() => socket.terminate(), 10000);
  try {
    await once(socket, 'open'); const response = once(socket, 'message');
    socket.send(serializePublicationOperationFrame(createPublicationOperationFrame(record)));
    expect(parseMessage((await response)[0].toString()).payload).toMatchObject({ status: 'ok' });
  } finally { clearTimeout(timer); socket.terminate(); }
}
it('runs the real selected entry point, accepts work and preserves it across a full-budget pause, SIGKILL and restart', async () => {
  const n = await fixture(), first = start(n), record = publication(); await publish(await first.listening(), record);
  const identity = readFileSync(join(n.data, 'relay-identity.json'));
  expect(n.open).toThrow(/already open/); first.child.kill('SIGTERM'); expect((await first.exited)[0]).toBe(0);
  const authority = n.open(), full = authority.status().reservedBytes, review = authority.reviewLimit(full); authority.applyLimit(full, review.approvalDigest); authority.close();
  const primary = readFileSync(join(n.ledger, 'reservations.json')), second = start(n); const port = await second.listening();
  await publish(port, record); const next = publication(); await publish(port, next);
  const controls = openReservedStorageControl({ directory: n.ledger, authorityId: n.id, controls: [
    { path: join(n.data, 'relay-runtime.lock'), component: 'local-state-lock', scope: 'file', maximumBytes: 8192 },
    { path: join(n.data, 'relay-maintenance.json'), component: 'operator-output', scope: 'file', maximumBytes: 1024 },
  ] }); cleanup.push(controls.close); withStorageReservationAuthority(controls, () => beginRelayMaintenance(n.data));
  second.child.kill('SIGKILL'); expect((await second.exited)[1]).toBe('SIGKILL');
  const refused = start(n); expect((await refused.exited)[0]).toBe(1); expect(refused.output()).toContain('maintenance is active');
  const stopped = n.open(); expect(stopped.status().availableBytes).toBe(0); withStorageReservationAuthority(stopped, () => finishRelayMaintenance(n.data)); stopped.close();
  const resumed = start(n); await publish(await resumed.listening(), record); resumed.child.kill('SIGTERM'); expect((await resumed.exited)[0]).toBe(0);
  expect(readFileSync(join(n.data, 'relay-identity.json'))).toEqual(identity);
  const journal = readFileSync(join(n.data, RELAY_OPERATION_LOG_FILENAME), 'utf8'); expect(journal).toContain(record.publicationId); expect(journal).toContain(next.publicationId);
  expect(readFileSync(join(n.managed, 'unknown-retained'), 'utf8')).toBe('retain old work'); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(primary);
}, 45000);
it('refuses unadopted diagnostics before creating any runtime or external output', async () => {
  const n = await fixture(), outside = join(n.directory, 'outside'), child = start(n, { RELAY_DIAGNOSTICS_DIRECTORY: outside });
  expect((await child.exited)[0]).toBe(1); expect(child.output()).toContain('no reviewed existing-file adoption');
  expect(existsSync(outside)).toBe(false); expect(existsSync(join(n.data, 'relay-identity.json'))).toBe(false); expect(n.open().status().components).toBe(3);
}, 15000);
it('refuses missing or corrupt selected authority before loading diagnostics or runtime', async () => {
  const n = await fixture(), path = join(n.ledger, 'reservations.json'), original = readFileSync(path);
  for (const value of [null, Buffer.from('corrupt private metadata')]) {
    if (value) writeFileSync(path, value); else rmSync(path);
    const child = start(n); expect((await child.exited)[0]).not.toBe(0); expect(child.output()).not.toContain('"event":"started"');
    expect(existsSync(n.diagnostics)).toBe(false); expect(existsSync(join(n.data, 'relay-identity.json'))).toBe(false); writeFileSync(path, original);
  }
}, 20000);

it('refuses changed endpoint pins and a missing selected document before loading runtime writers', async () => {
  const n = await fixture();
  for (const overrides of [{ RELAY_PORT: String(n.port === 65535 ? n.port - 1 : n.port + 1) },
    { RELAY_HOST: '0.0.0.0' }, { RELAY_DATA_DIR: join(n.managed, 'different-runtime') }, { RELAY_STORAGE_SELECTION_FILE: n.selected + '-missing' }]) {
    const child = start(n, overrides); expect((await child.exited)[0]).toBe(1);
    expect(child.output()).not.toContain('"event":"started"'); expect(existsSync(n.diagnostics)).toBe(false);
    expect(existsSync(join(n.data, 'relay-identity.json'))).toBe(false);
  }
}, 20000);
