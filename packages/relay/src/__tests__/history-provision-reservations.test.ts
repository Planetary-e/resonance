import { afterEach, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { openHistoryGenerationProvisioner, HISTORY_PROVISION_JOURNAL_BYTES } from '../history-generation-provisioner.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const MAX_BYTES = 4 * 1024 * 1024 + 256 * 1024, STORE_PEAK = MAX_BYTES + 8192;
const SLOT_PEAK = 2 * HISTORY_PROVISION_JOURNAL_BYTES + 8192;
function fixture(bytes: number) {
  const n = historyProvisionFixture(); cleanup.push(n.close);
  const directory = join(n.directory, 'authority');
  const authority = openStorageReservationAuthority({ directory, mode: 'create-new', limitBytes: CONTROL + bytes }); cleanup.push(authority.close);
  const options = { ...n.provisionOptions(), maxBytes: MAX_BYTES };
  const serviceOptions = { directory: join(n.directory, 'volunteer'), localKey: n.localKey, context: n.context, signingKey: n.memberKeys[0],
    genesisId: n.options.rootId, maxBytes: MAX_BYTES, now: () => 10_000 };
  return { ...n, authority, authorityDirectory: directory, provision: options, serviceOptions };
}
function freeze(n: ReturnType<typeof fixture>, service: ReturnType<typeof openHistoryVolunteerService>) {
  const intent = n.request(), barrier = n.stores[0].describe().freeze!;
  service.checkpoint({ request: createHistoryExchangeRequest({ action: 'freeze', rootId: n.options.rootId, generation: 0,
    replica: n.context.members[0], challenge: barrier.challenge, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt,
    sequence: 1, envelopeId: null }, n.context, n.owner), envelope: null, freeze: barrier });
}
it('retains one fixed allocation after leaving the authority scope, publication, retry and restart at a full budget', () => {
  const n = fixture(SLOT_PEAK + STORE_PEAK);
  let role = withStorageReservationAuthority(n.authority, () => openHistoryGenerationProvisioner({ ...n.provision, initialize: true })); cleanup.push(() => role.close());
  role.provision(n.request()); const delta = n.next(n.continuation); role.child()!.append(delta);
  const charged = n.authority.status(); expect(charged).toMatchObject({ components: 3, availableBytes: 0 });
  expect(role.read()).toMatchObject({ version: 2, phase: 'ready', location: 'generation' });
  const path = `generation-${historyContinuationRootId(n.continuation).slice(7)}`;
  expect(readdirSync(n.provision.directory).filter(name => name.includes('generation-') || name.startsWith('.creating-'))).toEqual([path]);
  role.provision(n.request()); expect(n.authority.status()).toEqual(charged); role.close(); n.authority.close();
  const reopened = openStorageReservationAuthority({ directory: n.authorityDirectory, mode: 'open-existing', authorityId: charged.authorityId }); cleanup.push(reopened.close);
  role = withStorageReservationAuthority(reopened, () => openHistoryGenerationProvisioner(n.provision));
  expect(role.child()!.read().envelopes).toEqual([n.continuation, delta]); role.provision(n.request());
  expect(reopened.status()).toEqual(charged);
  reopened.close(); expect(() => role.provision(n.request())).toThrow(/closed/);
});
it('refuses an unfunded child before parent activation and can retry after an explicit budget increase', () => {
  const n = fixture(SLOT_PEAK), role = withStorageReservationAuthority(n.authority, () => openHistoryGenerationProvisioner({ ...n.provision, initialize: true })); cleanup.push(role.close);
  expect(() => role.provision(n.request())).toThrow(/exhausted/);
  expect(n.stores[0].activatedContinuation()).toBeNull(); expect(role.read().phase).toBe('empty');
  expect(readdirSync(n.provision.directory).some(name => name.startsWith('generation-'))).toBe(false);
  const limit = CONTROL + SLOT_PEAK + STORE_PEAK;
  n.authority.applyLimit(limit, n.authority.reviewLimit(limit).approvalDigest);
  role.provision(n.request()); expect(n.authority.status().availableBytes).toBe(0);
});
it('preflights the first volunteer slot before creating any enrollment directory', () => {
  const n = fixture(STORE_PEAK);
  expect(() => withStorageReservationAuthority(n.authority, () => openHistoryVolunteerService({ ...n.serviceOptions, initialize: n.root }))).toThrow(/exhausted/);
  expect(existsSync(n.serviceOptions.directory)).toBe(false);
  expect(n.authority.status()).toMatchObject({ components: 2, availableBytes: 0 });
});
it.each([0, STORE_PEAK])('funds the entire next generation before activation with %i extra bytes', extra => {
  const n = fixture(STORE_PEAK + SLOT_PEAK + extra);
  let service = withStorageReservationAuthority(n.authority, () => openHistoryVolunteerService({ ...n.serviceOptions, initialize: n.root })); cleanup.push(() => service.close());
  freeze(n, service); const review = service.reviewDigest();
  expect(() => service.provision(n.request())).toThrow(/exhausted/);
  expect(service.reviewDigest()).toBe(review); expect(service.describe().generations).toBe(1);
  const limit = CONTROL + 2 * (STORE_PEAK + SLOT_PEAK);
  n.authority.applyLimit(limit, n.authority.reviewLimit(limit).approvalDigest);
  service.provision(n.request());
  expect(service.describe()).toMatchObject({ generations: 2, provisioning: 'empty' });
  const charged = n.authority.status(); expect(charged).toMatchObject({ components: 6, availableBytes: 0 });
  service.provision(n.request()); expect(n.authority.status()).toEqual(charged);
  service.close(); service = withStorageReservationAuthority(n.authority, () => openHistoryVolunteerService(n.serviceOptions));
  expect(service.describe().generations).toBe(2); expect(n.authority.status()).toEqual(charged);
});
it('rejects invalid and wrong-member requests before reserving successor space', () => {
  const n = fixture(2 * (STORE_PEAK + SLOT_PEAK));
  const service = withStorageReservationAuthority(n.authority, () => openHistoryVolunteerService({ ...n.serviceOptions, initialize: n.root })); cleanup.push(service.close);
  const charged = n.authority.status();
  expect(() => service.provision({ ...n.request(), signature: 'invalid' })).toThrow(/signature/);
  expect(() => service.provision(n.request(1))).toThrow(/another volunteer/);
  expect(n.authority.status()).toEqual(charged);
});
it('refuses a switched authority or later adoption of an unmanaged provisioner', () => {
  const n = fixture(SLOT_PEAK + STORE_PEAK);
  const managed = withStorageReservationAuthority(n.authority, () => openHistoryGenerationProvisioner({ ...n.provision, initialize: true })); cleanup.push(managed.close);
  const unmanaged = openHistoryGenerationProvisioner({ ...n.provisionOptions(1), initialize: true }); cleanup.push(unmanaged.close);
  expect(() => withStorageReservationAuthority(n.authority, () => unmanaged.provision(n.request(1)))).toThrow(/switch/);
  const other = openStorageReservationAuthority({ directory: join(n.directory, 'other'), mode: 'create-new', limitBytes: CONTROL + SLOT_PEAK + STORE_PEAK }); cleanup.push(other.close);
  expect(() => withStorageReservationAuthority(other, () => managed.provision(n.request()))).toThrow(/switch/);
  expect(n.stores[0].activatedContinuation()).toBeNull(); expect(n.stores[1].activatedContinuation()).toBeNull();
});

it.each(['before-parent-activation', 'before-ready', 'ready-marker'])(
  'preserves the child allocation through SIGKILL at %s and retries with no spare budget', async boundary => {
    const n = fixture(SLOT_PEAK + STORE_PEAK);
    withStorageReservationAuthority(n.authority, () => openHistoryGenerationProvisioner({ ...n.provision, initialize: true })).close();
    const authorityId = n.authority.status().authorityId;
    n.authority.close(); n.roles[0].close(); n.stores[0].close();
    const child = fork(new URL('./fixtures/history-provision-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Provision process exited before ready'); })]))[0]).toBe('ready');
    child.send({ options: { ...n.options, directory: join(n.directory, 'r0') }, directory: n.provision.directory,
      localKey: n.localKey.toString('hex'), request: n.request(), boundary, maxBytes: MAX_BYTES,
      authority: { directory: n.authorityDirectory, authorityId },
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL'); n.reopen(0);
    const authority = openStorageReservationAuthority({ directory: n.authorityDirectory, authorityId, mode: 'open-existing' }); cleanup.push(authority.close);
    const charged = authority.status(); expect(charged).toMatchObject({ components: 3, availableBytes: 0 });
    const role = withStorageReservationAuthority(authority, () => openHistoryGenerationProvisioner({ ...n.provisionOptions(), maxBytes: MAX_BYTES })); cleanup.push(role.close);
    expect(role.read().phase).toBe(boundary === 'before-parent-activation' ? 'empty' : boundary === 'before-ready' ? 'creating' : 'ready');
    role.provision(n.request()); expect(role.child()!.read().envelopes).toEqual([n.continuation]);
    expect(authority.status()).toEqual(charged);
  }, 30_000);

it('rejects a root that cannot fit its configured child before activating the predecessor', () => {
  const n = fixture(SLOT_PEAK + STORE_PEAK);
  const role = withStorageReservationAuthority(n.authority, () => openHistoryGenerationProvisioner({ ...n.provision, initialize: true, maxBytes: 4 * 1024 * 1024 + 1 })); cleanup.push(role.close);
  const before = n.authority.status(); expect(() => role.provision(n.request())).toThrow(/child capacity/);
  expect(n.authority.status()).toEqual(before); expect(n.stores[0].activatedContinuation()).toBeNull(); expect(role.read().phase).toBe('empty');
});
