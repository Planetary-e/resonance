import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { acquireRelayRuntime, beginRelayMaintenance, readRelayMaintenance, acquireStoppedRelayMaintenance,
  finishRelayMaintenance, RELAY_MAINTENANCE_FILENAME, RELAY_RUNTIME_RESOURCE } from '../relay-maintenance.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'relay-maintenance-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path;
}
function start(path: string) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../main.ts', import.meta.url))], {
    env: { ...inherited, RELAY_DATA_DIR: path, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_CONTACTS: '', RELAY_PUBLIC_ENDPOINTS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let output = '', port = 0;
  const read = (bytes: Buffer) => {
    output += bytes.toString();
    for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.event === 'started') port = value.port; } catch { /* partial log */ } }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, exited, output: () => output, async listening() {
    const deadline = performance.now() + 15000;
    while (!port) {
      if (child.exitCode !== null || child.signalCode !== null || performance.now() > deadline) throw new Error(`Relay did not start: ${output}`);
      await new Promise(r => setTimeout(r, 20));
    }
    return port;
  } };
}

it('excludes runtime and maintenance owners and retains the pause through failed operations', () => {
  const path = directory(), history = join(path, 'retained-history'); writeFileSync(history, 'accepted work');
  expect(() => acquireStoppedRelayMaintenance(path)).toThrow('Start relay maintenance');
  const runtime = acquireRelayRuntime(path);
  expect(() => acquireRelayRuntime(path)).toThrow('already open');
  const marker = beginRelayMaintenance(path);
  expect(beginRelayMaintenance(path)).toEqual(marker);
  expect(() => acquireStoppedRelayMaintenance(path)).toThrow('already open');
  expect(() => finishRelayMaintenance(path)).toThrow('already open');
  runtime();
  expect(() => acquireRelayRuntime(path)).toThrow('maintenance is active');
  const operation = acquireStoppedRelayMaintenance(path);
  expect(() => finishRelayMaintenance(path)).toThrow('already open');
  expect(() => acquireStoppedRelayMaintenance(path)).toThrow('already open');
  operation();
  expect(readRelayMaintenance(path)).toEqual(marker);
  finishRelayMaintenance(path); expect(readRelayMaintenance(path)).toBeNull();
  const restarted = acquireRelayRuntime(path); restarted();
  expect(readFileSync(history, 'utf8')).toBe('accepted work');
});

it('refuses corrupt and dangling maintenance markers without clearing them or opening history', () => {
  const path = directory(), marker = join(path, RELAY_MAINTENANCE_FILENAME);
  for (const value of ['{', 'null', '{"version":1,"kind":"relay-maintenance","createdAt":-1}', 'x'.repeat(1025)]) {
    writeFileSync(marker, value);
    expect(() => acquireRelayRuntime(path)).toThrow('maintenance is active');
    expect(() => acquireStoppedRelayMaintenance(path)).toThrow();
    expect(() => finishRelayMaintenance(path)).toThrow();
    expect(readFileSync(marker, 'utf8')).toBe(value);
  }
  if (process.platform !== 'win32') {
    rmSync(marker); symlinkSync(join(path, 'absent'), marker);
    expect(() => acquireRelayRuntime(path)).toThrow('maintenance is active');
    expect(() => beginRelayMaintenance(path)).toThrow();
  }
});

it('refuses a live competing main process and reclaims a killed owner only after it is dead', async () => {
  const path = directory(), first = start(path); await first.listening();
  const identity = readFileSync(join(path, 'relay-identity.json'));
  const second = start(path); expect((await second.exited)[0]).not.toBe(0);
  expect(second.output()).toContain('already open');
  beginRelayMaintenance(path);
  expect(() => acquireStoppedRelayMaintenance(path)).toThrow('already open');
  first.child.kill('SIGKILL'); await first.exited;
  expect(existsSync(join(path, `${RELAY_RUNTIME_RESOURCE}.lock`))).toBe(true);
  const resumedBySupervisor = start(path); expect((await resumedBySupervisor.exited)[0]).not.toBe(0);
  expect(resumedBySupervisor.output()).toContain('maintenance is active');
  const operation = acquireStoppedRelayMaintenance(path); operation();
  expect(readFileSync(join(path, 'relay-identity.json'))).toEqual(identity);
  finishRelayMaintenance(path);
  const next = start(path); await next.listening(); next.child.kill('SIGTERM');
  expect((await next.exited)[0]).toBe(0);
  expect(existsSync(join(path, `${RELAY_RUNTIME_RESOURCE}.lock`))).toBe(false);
  expect(readFileSync(join(path, 'relay-identity.json'))).toEqual(identity);
}, 30000);
