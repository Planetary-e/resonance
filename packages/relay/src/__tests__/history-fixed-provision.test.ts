import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openHistoryGenerationProvisioner, HISTORY_PROVISION_FILENAME, HISTORY_PROVISION_JOURNAL_BYTES } from '../history-generation-provisioner.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const n = historyProvisionFixture(); cleanup.push(n.close);
  const pool = join(n.directory, 'pool-slot'); mkdirSync(pool);
  const childDirectory = join(pool, 'history'), options = { ...n.provisionOptions(), childDirectory };
  const open = (initialize = false) => { const role = openHistoryGenerationProvisioner({ ...options, initialize }); cleanup.push(role.close); return role; };
  return { ...n, pool, childDirectory, provision: options, open };
}
it('binds the independent fixed destination before activation and refuses occupied capacity without erasing it', () => {
  const n = fixture(), role = n.open(true), before = role.read();
  expect(before).toMatchObject({ version: 3, phase: 'empty', childDirectory: n.childDirectory });
  mkdirSync(n.childDirectory); writeFileSync(join(n.childDirectory, 'accepted-evidence'), 'preserve');
  expect(() => role.provision(n.request())).toThrow('Unregistered'); expect(role.read()).toEqual(before);
  expect(n.stores[0].activatedContinuation()).toBeNull(); expect(readFileSync(join(n.childDirectory, 'accepted-evidence'), 'utf8')).toBe('preserve');
  // This fixture owns the dummy occupant. Production reuse needs its separately
  // committed service retirement boundary; the provisioner never deletes it.
  rmSync(n.childDirectory, { recursive: true }); role.provision(n.request());
  const delta = n.next(n.continuation); role.child()!.append(delta); role.close();
  const reopened = n.open(); expect(reopened.read()).toMatchObject({ version: 3, phase: 'ready', location: 'pool', childDirectory: n.childDirectory });
  expect(reopened.child()!.read().envelopes).toEqual([n.continuation, delta]); reopened.provision(n.request());
  expect(readdirSync(n.provision.directory).some(name => name.startsWith('generation-'))).toBe(false);
});
it('requires the same independent destination after restart and never converts an existing legacy slot implicitly', () => {
  const n = fixture(); n.open(true).close();
  const path = join(n.provision.directory, HISTORY_PROVISION_FILENAME), before = readFileSync(path);
  for (const childDirectory of [undefined, join(n.pool, 'different'), n.provision.directory, join(n.provision.directory, 'child'), n.directory, 'relative']) {
    expect(() => openHistoryGenerationProvisioner({ ...n.provision, childDirectory })).toThrow(); expect(readFileSync(path)).toEqual(before);
  }
  const legacy = n.provisionOptions(1); openHistoryGenerationProvisioner({ ...legacy, initialize: true }).close();
  const legacyPath = join(legacy.directory, HISTORY_PROVISION_FILENAME), retained = readFileSync(legacyPath);
  expect(() => openHistoryGenerationProvisioner({ ...legacy, childDirectory: n.childDirectory })).toThrow('state is invalid');
  expect(readFileSync(legacyPath)).toEqual(retained);
});
it('refuses a missing pool parent before activating the predecessor', () => {
  const n = fixture(), role = n.open(true); rmSync(n.pool, { recursive: true });
  expect(() => role.provision(n.request())).toThrow(); expect(n.stores[0].activatedContinuation()).toBeNull();
  expect(role.read().phase).toBe('empty'); expect(existsSync(n.pool)).toBe(false);
  mkdirSync(n.pool); role.provision(n.request()); expect(role.child()!.envelopeAt(0)).toEqual(n.continuation);
});
it('funds the same fixed allocation across provisioning, retry, append and reopen', () => {
  const n = fixture(), maxBytes = 4 * 1024 * 1024 + 256 * 1024, journalPeak = 2 * HISTORY_PROVISION_JOURNAL_BYTES + 8192;
  const authority = openStorageReservationAuthority({ directory: join(n.directory, 'authority'), mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES + journalPeak }); cleanup.push(authority.close);
  const options = { ...n.provision, maxBytes };
  let role = withStorageReservationAuthority(authority, () => openHistoryGenerationProvisioner({ ...options, initialize: true })); cleanup.push(() => role.close());
  expect(() => role.provision(n.request())).toThrow('exhausted'); expect(n.stores[0].activatedContinuation()).toBeNull(); expect(existsSync(n.childDirectory)).toBe(false);
  const limit = STORAGE_RESERVATION_CONTROL_BYTES + journalPeak + maxBytes + 8192;
  authority.applyLimit(limit, authority.reviewLimit(limit).approvalDigest);
  role.provision(n.request()); const delta = n.next(n.continuation); role.child()!.append(delta);
  const charged = authority.status(); expect(charged).toMatchObject({ components: 3, availableBytes: 0 });
  role.provision(n.request()); role.close();
  role = withStorageReservationAuthority(authority, () => openHistoryGenerationProvisioner(options));
  expect(role.child()!.read().envelopes).toEqual([n.continuation, delta]); expect(authority.status()).toEqual(charged);
});
it.each(['before-parent-activation', 'intent', 'directory', 'empty-manifest', 'root-block', 'root-manifest', 'before-ready', 'ready-marker'] as const)(
  'resumes the exact fixed destination after real SIGKILL at %s', async boundary => {
    const n = fixture(); n.open(true).close(); n.roles[0].close(); n.stores[0].close();
    const child = fork(new URL('./fixtures/history-provision-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before readiness'); })]))[0]).toBe('ready');
    child.send({ options: { ...n.options, directory: join(n.directory, 'r0') }, directory: n.provision.directory,
      childDirectory: n.childDirectory, localKey: n.localKey.toString('hex'), request: n.request(), boundary,
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL'); n.reopen(0);
    const role = openHistoryGenerationProvisioner({ ...n.provisionOptions(), childDirectory: n.childDirectory }); cleanup.push(role.close);
    role.provision(n.request()); expect(role.read()).toMatchObject({ version: 3, phase: 'ready', location: 'pool' });
    const delta = n.next(n.continuation); role.child()!.append(delta); expect(role.child()!.read().envelopes).toEqual([n.continuation, delta]);
  }, 30000);
