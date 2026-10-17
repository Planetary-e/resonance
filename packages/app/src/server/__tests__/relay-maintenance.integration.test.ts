import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { EmbeddingEngine } from '@resonance/core';
import { acquireRelayRuntime, beginRelayMaintenance, acquireStoppedRelayMaintenance } from '../../../../relay/src/relay-maintenance.js';
import { beginRelayHistoryMaintenance, finishRelayHistoryMaintenance, getRelayMaintenanceStatus, runRelayHistoryOperation,
  startRelayMode, stopRelayMode, loadRelayConfig, lockSession } from '../session.js';
import { installRelayService, uninstallRelayService, relayPortClosed } from '../relay-supervisor.js';
import { createAppServer } from '../server.js';

// Never install or stop a real user service. TCP refusal and on-disk exclusion
// remain real; separate relay tests exercise main.ts and forced process death.
vi.mock('../relay-supervisor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../relay-supervisor.js')>(),
  installRelayService: vi.fn(), uninstallRelayService: vi.fn(),
}));
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  lockSession(); for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs();
});
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-maintenance-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.stubEnv('RESONANCE_DATA_DIR', directory); vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
  const server = createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await new Promise<void>(resolve => server.close(() => resolve())); } };
  cleanup.push(close);
  const config = join(directory, 'relay-config.json'), history = join(directory, 'relay-data');
  writeFileSync(config, JSON.stringify({ enabled: false, port, adminKey: 'test-admin' }));
  return { directory, config, history, port, server, close };
}

it('persists maintenance before stop, holds exclusion throughout an operation, and never starts on finish', async () => {
  const n = await setup(); await n.close();
  expect(await beginRelayHistoryMaintenance()).toMatchObject({ active: true });
  expect(uninstallRelayService).toHaveBeenCalledOnce(); expect(loadRelayConfig().enabled).toBe(false);
  const retained = join(n.history, 'retained-history'); writeFileSync(retained, 'accepted history');
  let entered!: () => void, complete!: () => void;
  const running = new Promise<void>(r => { entered = r; }); const hold = new Promise<void>(r => { complete = r; });
  const pending = runRelayHistoryOperation(async () => { entered(); await hold; return 'done'; });
  try {
    await running;
    for (const competing of [() => startRelayMode(), () => stopRelayMode(), () => finishRelayHistoryMaintenance(),
      () => runRelayHistoryOperation(async () => { throw new Error('Must not enter'); })]) {
      await expect(competing()).rejects.toThrow('already open');
    }
    expect(() => acquireStoppedRelayMaintenance(n.history)).toThrow('already open');
    expect(() => acquireRelayRuntime(n.history)).toThrow('already open');
  } finally { complete(); }
  expect(await pending).toBe('done');
  expect(getRelayMaintenanceStatus().active).toBe(true);
  await expect(startRelayMode()).rejects.toThrow('maintenance is active');
  await expect(runRelayHistoryOperation(async () => { throw new Error('Interrupted recovery'); })).rejects.toThrow('Interrupted recovery');
  expect(getRelayMaintenanceStatus().active).toBe(true);
  expect(await finishRelayHistoryMaintenance()).toEqual({ active: false, createdAt: null });
  expect(installRelayService).not.toHaveBeenCalled();
  expect(readFileSync(retained, 'utf8')).toBe('accepted history');
  const runtime = acquireRelayRuntime(n.history); runtime();
});

it('retains maintenance after stop failure or a busy unauthenticated listener and releases cancelled claims', async () => {
  const n = await setup();
  vi.mocked(uninstallRelayService).mockImplementationOnce(() => { throw new Error('Supervisor refused stop'); });
  await expect(beginRelayHistoryMaintenance()).rejects.toThrow('Supervisor refused stop');
  expect(getRelayMaintenanceStatus().active).toBe(true);
  expect(await relayPortClosed(n.port)).toBe(false);
  const cancel = new AbortController(); n.server.once('connection', () => cancel.abort());
  await expect(beginRelayHistoryMaintenance(cancel.signal)).rejects.toThrow('cancelled');
  expect(getRelayMaintenanceStatus().active).toBe(true);
  await n.close(); expect(await relayPortClosed(n.port)).toBe(true);
  const alreadyCancelled = AbortSignal.abort();
  const operation = vi.fn(async () => 'must not run');
  await expect(runRelayHistoryOperation(operation, alreadyCancelled)).rejects.toThrow('cancelled');
  expect(operation).not.toHaveBeenCalled();
  const runtime = acquireStoppedRelayMaintenance(n.history); runtime();
  expect(await beginRelayHistoryMaintenance()).toMatchObject({ active: true });
  await finishRelayHistoryMaintenance();
});

it('does not treat a closed listener as a stopped runtime and retains all files on cancellation', async () => {
  const n = await setup(); await n.close();
  const release = acquireRelayRuntime(n.history); cleanup.push(release);
  const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(), 250);
  try { await expect(beginRelayHistoryMaintenance(cancel.signal)).rejects.toThrow('cancelled'); }
  finally { clearTimeout(timer); }
  expect(getRelayMaintenanceStatus().active).toBe(true);
  expect(() => acquireStoppedRelayMaintenance(n.history)).toThrow('already open');
  release(); await finishRelayHistoryMaintenance();
});

it('refuses damaged settings and dangling paths without a default-port stop or overwriting evidence', async () => {
  const n = await setup(); await n.close();
  for (const value of ['{', 'null', JSON.stringify({ enabled: false, port: 0 }), JSON.stringify({ enabled: false, port: n.port, runtime: 'bad' }),
    JSON.stringify({ enabled: false, port: n.port, runtime: { storageSelectionFile: 42 } }),
    JSON.stringify({ enabled: false, port: n.port, runtime: { storageSelectionFile: '' } }), 'x'.repeat(65537)]) {
    writeFileSync(n.config, value);
    await expect(startRelayMode()).rejects.toThrow('settings are invalid');
    await expect(stopRelayMode()).rejects.toThrow('settings are invalid');
    await expect(beginRelayHistoryMaintenance()).rejects.toThrow('settings are invalid');
    await expect(finishRelayHistoryMaintenance()).rejects.toThrow('settings are invalid');
    expect(readFileSync(n.config, 'utf8')).toBe(value);
    // Invalid settings cannot identify a funded control scope. Refuse before writing.
    expect(getRelayMaintenanceStatus().active).toBe(false);
  }
  if (process.platform !== 'win32') {
    rmSync(n.config); symlinkSync(join(n.directory, 'missing'), n.config);
    expect(() => loadRelayConfig()).toThrow('settings are invalid');
  }
  expect(installRelayService).not.toHaveBeenCalled(); expect(uninstallRelayService).not.toHaveBeenCalled();
});

it('requires an unlocked authenticated desktop session for every maintenance API operation', async () => {
  const n = await setup(); await n.close();
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${n.port}/` });
  const base = `http://127.0.0.1:${await app.start()}`; cleanup.push(() => app.stop());
  const request = async (path: string, method = 'GET', token = '', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  for (const method of ['GET', 'POST', 'DELETE']) expect((await request('/api/relay/maintenance', method)).status).toBe(401);
  expect(existsSync(n.history)).toBe(false); expect(uninstallRelayService).not.toHaveBeenCalled();
  expect((await request('/api/init', 'POST', '', { password: 'maintenance test password' })).status).toBe(200);
  const unlocked = await request('/api/unlock', 'POST', '', { password: 'maintenance test password' });
  expect(unlocked.status).toBe(200); const token = unlocked.body.token;
  for (const method of ['GET', 'POST', 'DELETE']) expect((await request('/api/relay/maintenance', method, 'wrong')).status).toBe(401);
  expect((await request('/api/relay/maintenance', 'GET', token)).body).toEqual({ active: false, createdAt: null });
  expect((await request('/api/relay/maintenance', 'POST', token)).body).toMatchObject({ active: true });
  expect((await request('/api/relay/start', 'POST', token, {})).status).toBeGreaterThanOrEqual(400);
  expect((await request('/api/relay/maintenance', 'DELETE', token)).body).toEqual({ active: false, createdAt: null });
  expect(installRelayService).not.toHaveBeenCalled();
  beginRelayMaintenance(n.history); writeFileSync(join(n.history, 'relay-maintenance.json'), '{');
  expect((await request('/api/relay/maintenance', 'GET', token)).status).toBe(409);
  expect(readFileSync(join(n.history, 'relay-maintenance.json'), 'utf8')).toBe('{');
});

it('does not guess a default port when settings disappear from an existing relay', async () => {
  const n = await setup(); await n.close(); beginRelayMaintenance(n.history);
  const history = join(n.history, 'accepted-history'); writeFileSync(history, 'retained'); rmSync(n.config);
  expect(() => loadRelayConfig()).toThrow('settings are missing');
  await expect(stopRelayMode()).rejects.toThrow('settings are missing');
  await expect(finishRelayHistoryMaintenance()).rejects.toThrow('settings are missing');
  expect(existsSync(n.config)).toBe(false); expect(readFileSync(history, 'utf8')).toBe('retained');
  expect(getRelayMaintenanceStatus().active).toBe(true); expect(uninstallRelayService).not.toHaveBeenCalled();
});
