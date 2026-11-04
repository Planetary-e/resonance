import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)(
  'drains normally when %s arrives at the first started marker', async signal => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-start-signal-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
    const child = spawn(process.execPath, ['--import', 'tsx', '--import',
      fileURLToPath(new URL('./fixtures/signal-at-relay-start.ts', import.meta.url)),
      fileURLToPath(new URL('../main.ts', import.meta.url))], {
      env: { ...inherited, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1', RELAY_DATA_DIR: directory,
        RESONANCE_TEST_SHUTDOWN_SIGNAL: signal }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit'); let output = '';
    child.stdout.on('data', bytes => { output += String(bytes); });
    child.stderr.on('data', bytes => { output += String(bytes); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    cleanup.push(async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    const [code, terminatedBy] = await exited;
    expect({ code, terminatedBy }, output).toEqual({ code: 0, terminatedBy: null });
    expect(output).toContain('"event":"started"');
    expect(output).toContain('"event":"stopped"');
  }, 20000,
);
