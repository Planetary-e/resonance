import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateRelayIdentity, RELAY_IDENTITY_FILENAME } from '../relay-identity-store.js';

const directories: string[] = [], children: ChildProcess[] = [];
const passphrase = 'relay key public fixture password';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'relay-key-crash-')); directories.push(directory);
  return { directory, path: join(directory, RELAY_IDENTITY_FILENAME), candidate: join(directory, `.${RELAY_IDENTITY_FILENAME}.pending`), marker: join(directory, 'marker') };
}
async function child() {
  const value = fork(new URL('./fixtures/relay-identity-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(value); expect((await once(value, 'message'))[0]).toBe('ready'); return value;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async value => {
    if (value.exitCode === null && value.signalCode === null) { const ended = once(value, 'exit'); value.kill('SIGKILL'); await ended; }
  }));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const boundaries = ['candidate-opened', 'candidate-partial', 'candidate-written', 'candidate-flushed', 'published',
  ...(process.platform === 'win32' ? [] : ['directory-before-publication', 'directory-after-publication'])];
for (const migrate of [false, true]) {
  it.each(boundaries)(`preserves relay identity after SIGKILL during ${migrate ? 'encryption migration' : 'creation'} at %s`, async boundary => {
    const n = fixture(), original = migrate ? loadOrCreateRelayIdentity(n.directory) : undefined;
    const before = migrate ? readFileSync(n.path) : undefined;
    const worker = await child(), exited = once(worker, 'exit');
    worker.send({ ...n, mode: 'kill', boundary, passphrase }); await exited;
    expect(readFileSync(n.marker, 'utf8')).toBe(boundary);
    const partial = ['candidate-opened', 'candidate-partial'].includes(boundary);
    if (partial) {
      const retained = readFileSync(n.candidate);
      expect(() => loadOrCreateRelayIdentity(n.directory, passphrase)).toThrow();
      expect(readFileSync(n.candidate)).toEqual(retained);
      if (migrate) expect(readFileSync(n.path)).toEqual(before); else expect(existsSync(n.path)).toBe(false);
      original?.secretKey.fill(0); return;
    }
    const encoded = readFileSync(existsSync(n.candidate) ? n.candidate : n.path);
    const recovered = loadOrCreateRelayIdentity(n.directory, passphrase);
    if (original) expect(recovered).toEqual(original);
    expect(readFileSync(n.path)).toEqual(encoded); expect(existsSync(n.candidate)).toBe(false);
    const reopened = loadOrCreateRelayIdentity(n.directory, passphrase); expect(reopened).toEqual(recovered);
    expect(() => loadOrCreateRelayIdentity(n.directory, 'wrong password with sufficient length')).toThrow();
    original?.secretKey.fill(0); recovered.secretKey.fill(0); reopened.secretKey.fill(0);
  }, 15000);
}
it.each(['candidate-partial', 'candidate-flushed', 'published'])('retains evidence after a reported I/O error at %s', async boundary => {
  const n = fixture(), original = loadOrCreateRelayIdentity(n.directory), before = readFileSync(n.path);
  const worker = await child(), exited = once(worker, 'exit'), message = once(worker, 'message');
  worker.send({ ...n, mode: 'throw', boundary, passphrase });
  expect((await message)[0]).toEqual({ error: `Error: Injected failure: ${boundary}` }); await exited;
  if (boundary === 'candidate-partial') {
    expect(() => loadOrCreateRelayIdentity(n.directory, passphrase)).toThrow(); expect(readFileSync(n.path)).toEqual(before);
  } else {
    const recovered = loadOrCreateRelayIdentity(n.directory, passphrase); expect(recovered).toEqual(original); recovered.secretKey.fill(0);
  }
  original.secretKey.fill(0);
}, 15000);
it.each([false, true])('serializes competing processes with distinct passwords (migration=%s)', async migrate => {
  const n = fixture(), original = migrate ? loadOrCreateRelayIdentity(n.directory) : undefined;
  const workers = await Promise.all([child(), child(), child()]);
  const messages = workers.map(worker => once(worker, 'message')), exits = workers.map(worker => once(worker, 'exit'));
  workers.forEach((worker, i) => worker.send({ ...n, mode: 'race', passphrase: `${passphrase} ${i}` }));
  const results = (await Promise.all(messages)).map(value => value[0]); await Promise.all(exits);
  const winners = results.map((value, i) => ({ ...value, i })).filter(value => value.did); expect(winners).toHaveLength(1);
  const recovered = loadOrCreateRelayIdentity(n.directory, `${passphrase} ${winners[0].i}`);
  expect(recovered.did).toBe(winners[0].did); if (original) expect(recovered).toEqual(original);
  original?.secretKey.fill(0); recovered.secretKey.fill(0);
}, 15000);
