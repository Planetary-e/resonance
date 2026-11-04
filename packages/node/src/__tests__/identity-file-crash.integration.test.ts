import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityManager } from '../identity.js';

const directories: string[] = [], children: ChildProcess[] = [];
function directory() { const value = mkdtempSync(join(tmpdir(), 'identity-crash-')); directories.push(value); return value; }
async function child() {
  const value = fork(new URL('./fixtures/identity-file-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(value); expect((await once(value, 'message'))[0]).toBe('ready'); return value;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async value => {
    if (value.exitCode === null && value.signalCode === null) { const ended = once(value, 'exit'); value.kill('SIGKILL'); await ended; }
  }));
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});
const boundaries = ['intent-partial', 'intent-written', 'intent-flushed', 'candidate-opened', 'candidate-partial',
  'candidate-written', 'candidate-flushed', 'published', ...(process.platform === 'win32' ? [] : ['directory-after-publication']), 'intent-removed'];
for (const replace of [false, true]) {
  it.each([...boundaries, ...(!replace ? ['candidate-removed'] : [])])(`preserves account after SIGKILL during ${replace ? 'replacement' : 'creation'} at %s`, async boundary => {
    const root = directory(), path = join(root, 'identity.json'), marker = join(root, 'marker'), expected = join(root, 'expected');
    const manager = createIdentityManager(path);
    if (replace) (await manager.create('old password')).secretKey.fill(0);
    const before = replace ? readFileSync(path) : undefined;
    const worker = await child(), exited = once(worker, 'exit');
    worker.send({ mode: 'kill', replace, path, marker, expected, boundary }); await exited;
    expect(readFileSync(marker, 'utf8')).toBe(boundary); expect(manager.exists()).toBe(true);
    await expect(manager.create('another password')).rejects.toThrow();
    if (boundary === 'intent-partial') {
      await expect(manager.load(replace ? 'old password' : 'new password')).rejects.toThrow();
      if (replace) expect(readFileSync(path)).toEqual(before); else expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.pending`)).toBe(true); return;
    }
    const committed = ['published', 'directory-after-publication', 'candidate-removed', 'intent-removed'].includes(boundary);
    if (replace && !committed) {
      expect(readFileSync(path)).toEqual(before);
      const retained = await manager.load('old password');
      expect(retained.did).toBe(readFileSync(expected, 'utf8'));
      await manager.save(retained, 'new password'); retained.secretKey.fill(0);
    }
    const recovered = await manager.load('new password');
    expect(recovered.did).toBe(readFileSync(expected, 'utf8')); recovered.secretKey.fill(0);
    expect(existsSync(`${path}.pending`)).toBe(false); expect(existsSync(`${path}.next`)).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(manager.load('wrong password')).rejects.toThrow();
  }, 15_000);
}

it.each(['candidate-partial', 'candidate-flushed', 'published', 'intent-removed'])('can recover after a reported I/O failure at %s', async boundary => {
  const root = directory(), path = join(root, 'identity.json'), marker = join(root, 'marker'), expected = join(root, 'expected');
  const worker = await child(), exited = once(worker, 'exit'), reply = once(worker, 'message');
  worker.send({ mode: 'throw', path, marker, expected, boundary });
  expect((await reply)[0]).toEqual({ error: `Error: Injected failure: ${boundary}` }); await exited;
  const recovered = await createIdentityManager(path).load('new password');
  expect(recovered.did).toBe(readFileSync(expected, 'utf8')); recovered.secretKey.fill(0);
}, 15_000);

it('allows only one competing process to create the account', async () => {
  const path = join(directory(), 'identity.json'), workers = await Promise.all([child(), child(), child()]);
  const replies = workers.map(worker => once(worker, 'message')), exits = workers.map(worker => once(worker, 'exit'));
  for (const worker of workers) worker.send({ mode: 'race', path });
  const results = (await Promise.all(replies)).map(result => result[0]); await Promise.all(exits);
  const created = results.filter(result => result.created); expect(created).toHaveLength(1);
  expect(results.filter(result => result.refused)).toHaveLength(2);
  const retained = await createIdentityManager(path).load('password'); expect(retained.did).toBe(created[0].created); retained.secretKey.fill(0);
}, 15_000);
