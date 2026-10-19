import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync, writeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStorageReservationAuthority, withStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES } from '@resonance/core/storage-reservations';
import { openSharedHistoryPool } from '../history-shared-pool.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { openHistoryGenerationProvisioner } from '../history-generation-provisioner.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, writeSync: vi.fn(fs.writeSync) }; });
const actualWrite = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeSync;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.mocked(writeSync).mockReset().mockImplementation(actualWrite); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(maxBytes?: number) {
  const n = historyProvisionFixture(); cleanup.push(n.close);
  const options = { directory: join(n.directory, 'original-pool'), localKey: n.localKey, context: n.context, replica: n.context.members[0], genesisId: n.options.rootId, maxBytes };
  let pool = openSharedHistoryPool({ ...options, initialize: true }); cleanup.push(() => pool.close());
  return { ...n, options, get pool() { return pool; }, closePool() { pool.close(); }, reopen() { pool = openSharedHistoryPool(options); return pool; } };
}
it('shares ownership across generation handles and refuses independent legacy or second pool writers', () => {
  const n = fixture(), store = openHistoryCheckpointStore({ ...n.options, directory: n.pool.directory, replica: n.context.members[0], generation: 0, rootId: n.options.genesisId, sharedPool: n.pool, initialize: n.root }); cleanup.push(store.close);
  expect(() => openSharedHistoryPool(n.options)).toThrow(/owner|owned|lock|already open/);
  expect(() => openHistoryCheckpointStore({ ...n.options, directory: n.pool.directory, replica: n.context.members[0], generation: 0, rootId: n.options.genesisId, sharedPool: n.pool })).toThrow('owner');
  expect(() => openHistoryCheckpointStore({ ...n.options, directory: n.pool.directory, replica: n.context.members[0], generation: 0, rootId: n.options.genesisId, initialize: n.root })).toThrow();
  expect(() => n.pool.assertPins(n.context, n.context.members[1])).toThrow('pinned');
});
it.each([0, 17])('retains and accounts an interrupted %i-byte object write, then reopens the prior authenticated state', partial => {
  const n = fixture(); const spec = { rootId: n.options.genesisId, generation: 0, kind: 'manifest' as const, initial: { counter: 0 }, maxBytes: 65536,
    validate: (v: unknown): v is { counter: number } => !!v && typeof v === 'object' && 'counter' in v && typeof v.counter === 'number' };
  const record = n.pool.openRecord({ ...spec, initialize: true }); const before = n.pool.usage();
  let interrupted = false;
  vi.mocked(writeSync).mockImplementation(((fd: number, buffer: Uint8Array, ...args: unknown[]) => {
    // The version1 catalog stage must become durable before interrupting version2 immutable ciphertext.
    if (!interrupted && Buffer.from(buffer).subarray(0, 12).toString() === '{"version":2') {
      interrupted = true; if (partial) actualWrite(fd, buffer, 0, partial); throw new Error('interrupted shared write');
    }
    return (actualWrite as any)(fd, buffer, ...args);
  }) as unknown as typeof writeSync);
  expect(() => record.write({ counter: 1 })).toThrow('interrupted'); record.close(); n.closePool();
  vi.mocked(writeSync).mockImplementation(actualWrite); n.reopen();
  const reopened = n.pool.openRecord(spec); cleanup.push(reopened.close); expect(reopened.read()).toEqual({ counter: 0 });
  expect(n.pool.usage().bytes).toBe(before.bytes + partial);
  expect(interrupted).toBe(true);
  const pending = readdirSync(n.options.directory).filter(name => /^[a-f0-9]{64}\.object\.pending$/.test(name));
  expect(pending).toHaveLength(1); expect(readFileSync(join(n.options.directory, pending[0])).length).toBe(partial);
  reopened.write({ counter: 2 }); expect(reopened.read()).toEqual({ counter: 2 });
});
it('refuses invalid state and aggregate metadata exhaustion before creating more objects', () => {
  const n = fixture(4 * 1024 * 1024 + 8192 + 3000);
  const record = n.pool.openRecord({ rootId: n.options.genesisId, generation: 0, kind: 'manifest', initial: { value: '' }, initialize: true, maxBytes: 2 * 1024 * 1024,
    validate: (v: unknown): v is { value: string } => !!v && typeof v === 'object' && 'value' in v && typeof v.value === 'string' }); cleanup.push(record.close);
  const before = readdirSync(n.options.directory).sort();
  expect(() => record.write({ value: 0 } as never)).toThrow('Invalid outgoing');
  expect(() => record.write({ value: 'a'.repeat(10000) })).toThrow('capacity');
  expect(readdirSync(n.options.directory).sort()).toEqual(before); expect(record.read()).toEqual({ value: '' });
});
it('retains every superseded encrypted record and refuses a missing old version or altered ciphertext', () => {
  const n = fixture(), record = n.pool.openRecord({ rootId: n.options.genesisId, generation: 0, kind: 'manifest', initial: { n: 0 }, initialize: true, maxBytes: 65536,
    validate: (v: unknown): v is { n: number } => !!v && typeof v === 'object' && 'n' in v });
  const old = readdirSync(n.options.directory).filter(v => v.endsWith('.object')); record.write({ n: 1 });
  expect(old.every(v => existsSync(join(n.options.directory, v)))).toBe(true); record.close(); n.closePool();
  const path = join(n.options.directory, old[0]), bytes = readFileSync(path); rmSync(path); expect(() => n.reopen()).toThrow('Missing');
  writeFileSync(path, bytes); n.reopen(); n.closePool(); writeFileSync(path, Buffer.alloc(bytes.length)); expect(() => n.reopen()).toThrow();
});
it('refuses unbacked pooled enrollment before creating the directory under the unchanged authority', () => {
  const n = historyProvisionFixture(); cleanup.push(n.close); const directory = join(n.directory, 'funded-pool');
  const authority = openStorageReservationAuthority({ directory: join(n.directory, 'funding'), mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES + 256 * 1024 * 1024 - 1 }); cleanup.push(authority.close);
  expect(() => withStorageReservationAuthority(authority, () => openSharedHistoryPool({ directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], genesisId: n.options.rootId, initialize: true }))).toThrow('exhausted');
  expect(existsSync(directory)).toBe(false);
});
it.each(['before-creating', 'before-ready', 'ready'])('reopens exact pooled publication after SIGKILL at %s without extra allocation', async boundary => {
  const n = fixture(); const store = openHistoryCheckpointStore({ directory: n.pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], generation: 0, rootId: n.options.genesisId, initialize: n.root, sharedPool: n.pool });
  for (const block of n.preparation.envelopes.slice(1)) store.append(block);
  store.freeze(n.stores[0].describe().freeze!);
  const provisionOptions = { directory: n.pool.directory, localKey: n.localKey, context: n.context, signingKey: n.memberKeys[0], parent: store, sharedPool: n.pool, now: () => 10000 };
  openHistoryGenerationProvisioner({ ...provisionOptions, initialize: true }).close(); store.close(); n.closePool();
  const child = fork(new URL('./fixtures/history-original-pool-crash.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit'); cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await once(child, 'message');
  child.send({ options: n.options, localKey: n.localKey.toString('hex'), member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') }, request: n.request(), boundary });
  await exited; expect(child.signalCode).toBe('SIGKILL'); n.reopen();
  const parent = openHistoryCheckpointStore({ directory: n.pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], generation: 0, rootId: n.options.genesisId, sharedPool: n.pool }); cleanup.push(parent.close);
  const p = openHistoryGenerationProvisioner({ ...provisionOptions, parent, sharedPool: n.pool }); cleanup.push(p.close);
  expect(p.read().phase).toBe(boundary === 'before-creating' ? 'empty' : boundary === 'ready' ? 'ready' : 'creating');
  p.provision(n.request()); expect(p.child()!.read().envelopes).toEqual([n.continuation]);
  expect(n.pool.usage().peakBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
}, 30000);

it('rejects invalid shared provision bounds before changing parent authority or journal state', () => {
  const n = fixture(), store = openHistoryCheckpointStore({ directory: n.pool.directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], generation: 0, rootId: n.options.genesisId, initialize: n.root, sharedPool: n.pool }); cleanup.push(store.close);
  const before = n.pool.usage();
  expect(() => openHistoryGenerationProvisioner({ directory: n.pool.directory, localKey: n.localKey, context: n.context, signingKey: n.memberKeys[0], parent: store, sharedPool: n.pool, initialize: true, maxBlocks: 0 })).toThrow('capacity');
  expect(n.pool.usage()).toEqual(before); expect(store.activatedContinuation()).toBeNull();
});
