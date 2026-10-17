import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { openHistoryGenerationProvisioner, HISTORY_PROVISION_FILENAME, HISTORY_PROVISION_JOURNAL_BYTES } from '../history-generation-provisioner.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const n = historyProvisionFixture(); cleanup.push(n.close);
  const options = n.provisionOptions(), id = historyContinuationRootId(n.continuation).slice(7);
  const open = (initialize = false) => { const role = openHistoryGenerationProvisioner({ ...options, initialize }); cleanup.push(role.close); return role; };
  function legacy(role: ReturnType<typeof open>, phase: 'empty' | 'creating' | 'ready') {
    const { location: _location, ...state } = role.read(); role.close();
    const journal = openEncryptedLocalState<Record<string, unknown>>({ path: join(options.directory, HISTORY_PROVISION_FILENAME), key: n.localKey,
      domain: 'resonance:history-provision-state:v1', maxBytes: HISTORY_PROVISION_JOURNAL_BYTES, initial: {}, mode: 'open-existing',
      validate: (value): value is Record<string, unknown> => typeof value === 'object' && value !== null });
    try { journal.write({ ...state, version: 1, phase }); } finally { journal.close(); }
  }
  return { ...n, open, legacy, generation: join(options.directory, `generation-${id}`), staging: join(options.directory, `.creating-${id}`) };
}
it('upgrades an authenticated empty v1 slot and pins new children to their permanent generation path', () => {
  const n = fixture(); n.legacy(n.open(true), 'empty'); const role = n.open();
  expect(role.read()).toMatchObject({ version: 2, phase: 'empty', location: null });
  role.provision(n.request()); expect(role.read()).toMatchObject({ phase: 'ready', location: 'generation' });
  expect(existsSync(n.staging)).toBe(false);
});
it.each(['absent', 'staging', 'generation'] as const)('pins and resumes a historical creating intent with %s child contents', location => {
  const n = fixture(), role = n.open(true); role.provision(n.request()); n.legacy(role, 'creating');
  if (location === 'staging') renameSync(n.generation, n.staging);
  if (location === 'absent') rmSync(n.generation, { recursive: true });
  const resumed = n.open(); expect(resumed.child()).toBeNull();
  const pin = location === 'staging' ? 'legacy-staging' : 'generation';
  expect(resumed.read()).toMatchObject({ version: 2, phase: 'creating', location: pin });
  resumed.provision(n.request()); const delta = n.next(n.continuation); resumed.child()!.append(delta); resumed.close();
  const reopened = n.open(); reopened.provision(n.request());
  expect(reopened.read()).toMatchObject({ phase: 'ready', location: pin });
  expect(reopened.child()!.read().envelopes).toEqual([n.continuation, delta]);
  expect(existsSync(location === 'staging' ? n.generation : n.staging)).toBe(false);
});
it('migrates ready v1 history without changing its accepted child records', () => {
  const n = fixture(), role = n.open(true); role.provision(n.request()); const delta = n.next(n.continuation); role.child()!.append(delta);
  n.legacy(role, 'ready'); const resumed = n.open();
  expect(resumed.read()).toMatchObject({ version: 2, phase: 'ready', location: 'generation' });
  expect(resumed.child()!.read().envelopes).toEqual([n.continuation, delta]);
});
it.each(['creating', 'ready'] as const)('refuses ambiguous v1 %s directories without changing the journal', phase => {
  const n = fixture(), role = n.open(true); role.provision(n.request()); n.legacy(role, phase); mkdirSync(n.staging);
  const path = join(n.provisionOptions().directory, HISTORY_PROVISION_FILENAME), before = readFileSync(path);
  expect(n.open).toThrow(/Ambiguous/); expect(readFileSync(path)).toEqual(before);
  expect(existsSync(n.generation)).toBe(true); expect(existsSync(n.staging)).toBe(true);
});
it('never substitutes a staging copy for a missing already-ready v1 generation', () => {
  const n = fixture(), role = n.open(true); role.provision(n.request()); n.legacy(role, 'ready'); renameSync(n.generation, n.staging);
  const path = join(n.provisionOptions().directory, HISTORY_PROVISION_FILENAME), before = readFileSync(path);
  expect(n.open).toThrow(); expect(readFileSync(path)).toEqual(before); expect(existsSync(n.generation)).toBe(false);
});
it('refuses a changed pinned location even when the alternative contains a valid child', () => {
  const n = fixture(), role = n.open(true); role.provision(n.request()); n.legacy(role, 'creating'); renameSync(n.generation, n.staging);
  const migrated = n.open(); migrated.provision(n.request()); migrated.close(); renameSync(n.staging, n.generation);
  expect(n.open).toThrow(/Ambiguous/); expect(existsSync(n.staging)).toBe(false);
});
it('never interprets accepted child deltas under a historical creating marker as pristine initialization', () => {
  const n = fixture(), role = n.open(true); role.provision(n.request()); const delta = n.next(n.continuation); role.child()!.append(delta);
  n.legacy(role, 'creating'); renameSync(n.generation, n.staging);
  const before = readFileSync(join(n.staging, 'history-manifest.json')), migrated = n.open();
  expect(() => migrated.provision(n.request())).toThrow(); expect(readFileSync(join(n.staging, 'history-manifest.json'))).toEqual(before);
  expect(migrated.child).toThrow(/reopen/); expect(existsSync(n.generation)).toBe(false);
});
it.each(['migration-before-pin', 'migration-after-pin'])(
  'survives SIGKILL at %s without losing the legacy directory selection', async boundary => {
    const n = fixture(), role = n.open(true); role.provision(n.request()); n.legacy(role, 'creating'); renameSync(n.generation, n.staging);
    n.roles[0].close(); n.stores[0].close();
    const process = fork(new URL('./fixtures/history-provision-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(process, 'exit'), messages: unknown[] = []; process.on('message', value => messages.push(value));
    cleanup.push(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(process, 'message'), exited.then(() => { throw new Error('Migration process exited before ready'); })]))[0]).toBe('ready');
    process.send({ options: { ...n.options, directory: join(n.directory, 'r0') }, directory: n.provisionOptions().directory,
      localKey: n.localKey.toString('hex'), request: n.request(), boundary,
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(messages).toEqual(['ready']); expect(process.signalCode).toBe('SIGKILL'); n.reopen(0);
    // Rebind the fresh parent handle; the old fixture helper intentionally captured its earlier one.
    const resumed = openHistoryGenerationProvisioner(n.provisionOptions()); cleanup.push(resumed.close);
    expect(resumed.read()).toMatchObject({ version: 2, phase: 'creating', location: 'legacy-staging' });
    resumed.provision(n.request()); expect(resumed.child()!.read().envelopes).toEqual([n.continuation]);
    expect(existsSync(n.generation)).toBe(false);
  }, 30_000);
