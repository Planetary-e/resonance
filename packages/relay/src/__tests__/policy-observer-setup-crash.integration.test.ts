import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { POLICY_OBSERVER_ROOT_SUFFIX } from '../policy-observer-setup.js';
import { readPolicyObserverConfigurationFile } from '../policy-observer-config.js';
import { policyObserverSetupFixture } from './fixtures/policy-observer-setup-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(['anchor-empty', 'anchor-partial', 'after-anchor', 'export-empty', 'export-partial', 'after-export'])(
  'preserves one-time preparation after process termination at %s', async boundary => {
    const n = await policyObserverSetupFixture(close => cleanup.push(close)), marker = join(n.directory, 'boundary.txt');
    const child = fork(fileURLToPath(new URL('./fixtures/policy-observer-setup-crash.ts', import.meta.url)), [], {
      execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], cwd: n.directory });
    const exited = once(child, 'exit'); let errors = ''; child.stderr?.on('data', bytes => { errors += String(bytes); });
    child.on('message', value => { if (value !== 'ready') errors += JSON.stringify(value); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      expect((await once(child, 'message'))[0]).toBe('ready');
      child.send({ input: { setupFile: n.setupFile, output: n.configPath, mode: 'new' }, boundary, marker });
      const [code, signal] = await exited; expect(errors).toBe('');
      expect(readFileSync(marker, 'utf8')).toBe(boundary);
      if (process.platform === 'win32') expect(code).not.toBe(0); else expect(signal).toBe('SIGKILL');
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    const anchor = n.keyFiles[0] + POLICY_OBSERVER_ROOT_SUFFIX, original = readFileSync(anchor), copy = join(n.directory, 'recovered-config.json');
    await expect(n.call('setup-plan', [n.setupFile, copy])).rejects.toThrow('already exists');
    expect(existsSync(n.ownerDirectory)).toBe(false);
    if (boundary.startsWith('anchor-')) {
      await expect(n.call('setup-export', [n.setupFile, copy])).rejects.toThrow('UTF-8'); expect(existsSync(copy)).toBe(false);
    } else {
      await n.call('setup-export', [n.setupFile, copy]);
      expect(readPolicyObserverConfigurationFile(copy)).toEqual(readPolicyObserverConfigurationFile(anchor));
      if (boundary === 'export-partial') expect(readFileSync(n.configPath, 'utf8')).toBe('partial');
      if (boundary === 'export-empty') expect(readFileSync(n.configPath).length).toBe(0);
      if (boundary === 'after-export') expect(readPolicyObserverConfigurationFile(n.configPath)).toEqual(readPolicyObserverConfigurationFile(copy));
    }
    expect(readFileSync(anchor)).toEqual(original);
  }, 30000);
