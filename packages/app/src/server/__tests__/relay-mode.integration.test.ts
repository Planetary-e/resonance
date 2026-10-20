import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRelayServer } from '@resonance/relay';
import { createDeferredAdmission } from '../../../../relay/src/deferred-admission.js';
import { startRelayMode, stopRelayMode, getRelayStats, loadRelayConfig } from '../session.js';
import { installRelayService, uninstallRelayService, relayServiceStats } from '../relay-supervisor.js';

// Exercise actual loopback stats and durable desktop settings. Native OS service
// installation is replaced; process startup with the generated environment has
// separate coverage in history-owner-startup.integration.test.ts.
vi.mock('../relay-supervisor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../relay-supervisor.js')>(),
  installRelayService: vi.fn(), uninstallRelayService: vi.fn(),
}));
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
function settings(port: number) {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-relay-status-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.stubEnv('RESONANCE_DATA_DIR', directory); vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
  for (const key of Object.keys(process.env)) if (key.startsWith('RESONANCE_RELAY_') && key !== 'RESONANCE_RELAY_ENTRY') vi.stubEnv(key, undefined);
  writeFileSync(join(directory, 'relay-config.json'), JSON.stringify({ enabled: false, port, adminKey: 'test-admin' }));
  return directory;
}

it('preserves service role paths across GUI restarts and reports transport separately from admission readiness', async () => {
  const directory = settings(9091), gate = createDeferredAdmission();
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, 'test-server'),
    adminApiKey: 'test-admin', admissionVerifier: gate.verifier });
  cleanup.push(async () => { gate.close(); await relay.stop(); });
  await relay.start(); const port = relay.getListeningPort()!;
  vi.stubEnv('RESONANCE_RELAY_HISTORY_BRIDGE_FILE', '/private/bridge.json');
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_HISTORY_FILE', '/private/history.json');
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_HISTORY_LINKS_FILE', '/private/links.json');
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_AUTHORITY_FILE', '/private/authority.pub');
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_POLICY_FILE', '/private/policy.json');
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_POLICY_KEY_FILE', '/private/storage.hex');
  await startRelayMode(port, []);
  expect(await getRelayStats()).toMatchObject({ enabled: true, running: true, admissionReady: false });
  expect(installRelayService).toHaveBeenCalledTimes(1);
  const retained = loadRelayConfig().runtime;
  expect(retained).toMatchObject({ historyBridgeFile: expect.stringContaining('bridge.json'), admissionHistoryLinksFile: expect.stringContaining('links.json') });
  for (const key of Object.keys(process.env)) if (key.startsWith('RESONANCE_RELAY_') && key !== 'RESONANCE_RELAY_ENTRY') vi.stubEnv(key, undefined);
  await startRelayMode(port, []); expect(installRelayService).toHaveBeenCalledTimes(1);
  gate.install({ verifyAndSpend: () => ({ status: 'rejected' }), close() {} });
  expect(await getRelayStats()).toMatchObject({ running: true, admissionReady: true });
  expect(JSON.stringify(await getRelayStats())).not.toContain('/private/');
  await stopRelayMode(); expect(uninstallRelayService).toHaveBeenCalledOnce();
  expect(await getRelayStats()).toMatchObject({ enabled: false, running: false, admissionReady: null });
  await startRelayMode(port, []); expect(installRelayService).toHaveBeenCalledTimes(2);
  expect(loadRelayConfig().runtime).toEqual(retained);
  vi.stubEnv('RESONANCE_RELAY_HISTORY_BRIDGE_FILE', '/private/replacement.json');
  await startRelayMode(port, []); expect(installRelayService).toHaveBeenCalledTimes(3);
  expect(readFileSync(join(directory, 'relay-config.json'), 'utf8')).toContain('replacement.json');
});

it('retains an installed service and its configuration when it never responds, allowing a later stop', async () => {
  settings(9091); vi.stubEnv('RESONANCE_RELAY_HISTORY_BRIDGE_FILE', '/private/bridge.json');
  vi.spyOn(await import('../relay-supervisor.js'), 'relayServiceStats').mockResolvedValue(null);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const pending = expect(startRelayMode(9091, [])).rejects.toThrow(/installed but has not responded/);
  await vi.runAllTimersAsync(); await pending;
  expect(loadRelayConfig()).toMatchObject({ enabled: true, runtime: { historyBridgeFile: expect.stringContaining('bridge.json') } });
  expect(await getRelayStats()).toMatchObject({ enabled: true, running: false, admissionReady: null });
  await stopRelayMode(); expect(uninstallRelayService).toHaveBeenCalledOnce();
  expect(loadRelayConfig().enabled).toBe(false);
});

it('treats malformed, oversized and interrupted stats as unavailable and preserves unknown readiness', async () => {
  let body = '{}', interrupted = false;
  const server = createServer((_, response) => {
    if (interrupted) { response.writeHead(200, { 'content-length': 1000 }); response.write('{'); setImmediate(() => response.destroy()); }
    else response.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  settings(port);
  await startRelayMode(port, []);
  expect(await getRelayStats()).toMatchObject({ running: true, admissionReady: null });
  for (const value of ['null', '[]', 'true', 'not json', '{"padding":"' + 'x'.repeat(100001) + '"}']) {
    body = value; expect(await relayServiceStats(port, 'test-admin')).toBeNull();
  }
  interrupted = true; expect(await relayServiceStats(port, 'test-admin')).toBeNull();
});

it('bounds a stats response by one deadline even when bytes keep arriving', async () => {
  const server = createServer((_, response) => {
    response.writeHead(200); response.write('{');
    const timer = setInterval(() => response.write(' '), 50);
    response.once('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const start = performance.now();
  expect(await relayServiceStats((server.address() as { port: number }).port, 'test-admin')).toBeNull();
  expect(performance.now() - start).toBeLessThan(2500);
});
