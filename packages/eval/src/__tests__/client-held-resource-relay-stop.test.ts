import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const children = new Set<ChildProcess>();
const directories: string[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('client-held resource fixture shutdown', () => {
  it('returns the final disk result before accepting an authenticated expected exit', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'resonance-resource-stop-'));
    directories.push(persistDir);
    const token = randomBytes(32).toString('base64url');
    const fixture = fileURLToPath(new URL('../fixtures/client-held-resource-relay.ts', import.meta.url));
    const child = fork(fixture, [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: resolve('packages/relay/src/__tests__/fixtures/tls/test-ca.crt'),
        RESONANCE_RESOURCE_RELAY: JSON.stringify({ persistDir, rssSampleIntervalMs: 250 }),
        RESONANCE_RESOURCE_TOKEN: token,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.add(child);
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    let nextId = 0;
    const pending = new Map<number, { accept: (value: any) => void; reject: (error: Error) => void }>();
    const ordering: string[] = [];
    const ready = new Promise<void>((accept, reject) => {
      child.on('message', (message: any) => {
        if (message.event === 'ready') accept();
        else if (message.event === 'failed') reject(new Error(message.error));
        else if (typeof message.id === 'number') {
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error));
          else request.accept(message.result);
        }
      });
      child.once('exit', (code, signal) => {
        const error = new Error(`Fixture exited early code=${code} signal=${signal}: ${stderr}`);
        reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      });
      setTimeout(() => reject(new Error(`Fixture startup timeout: ${stderr}`)), 10_000).unref();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(accept => {
      child.once('exit', (code, signal) => accept({ code, signal }));
    });
    const request = (command: string) => new Promise<any>((accept, reject) => {
      const id = ++nextId;
      pending.set(id, { accept, reject });
      child.send({ id, command, token });
    });

    await ready;
    const result = await request('stop');
    ordering.push('stop-result');
    expect(result.diskEvents.length).toBeGreaterThan(0);
    expect(result.disk.finalBytes).toBeGreaterThan(0);
    expect(pending.size).toBe(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    child.send({ command: 'exit', token: randomBytes(32).toString('base64url') });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    child.send({ command: 'exit', token });
    const exit = await exited;
    ordering.push('exit');
    expect(exit).toEqual({ code: 0, signal: null });
    expect(pending.size).toBe(0);
    expect(ordering).toEqual(['stop-result', 'exit']);
  }, 15_000);
});
