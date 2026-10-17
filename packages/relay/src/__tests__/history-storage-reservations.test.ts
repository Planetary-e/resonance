import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHistoryFreeze, historyCheckpointContextId, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { createHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore, inspectPristineHistoryGenesis } from '../history-checkpoint-store.js';
import { openHistoryWriterArchive } from '../history-writer-archive.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { historyAgreementFixture } from './fixtures/history-agreement-fixture.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(renameSync).mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) close(); });
const MANIFEST_PEAK = 4 * 1024 * 1024 + 8192, BLOCK_BYTES = 8192;
function fixture(extra = 3 * (MANIFEST_PEAK + BLOCK_BYTES)) {
  const n = historyAgreementFixture('missing', 3); cleanup.push(n.close);
  const ledger = join(n.directory, 'authority');
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  const roles = n.stores.map((store, i) => createHistoryCheckpointReplica({ context: n.context, store, signingKey: n.memberKeys[i] })); cleanup.push(() => roles.forEach(r => r.close()));
  const archiveOptions = { directory: join(n.directory, 'archive'), localKey: n.localKey, context: n.context, rootId: n.options.rootId, generation: 0, maxBytes: BLOCK_BYTES,
    readWriter: () => ({ version: 1 as const, contextId: historyCheckpointContextId(n.context), rootId: n.options.rootId, generation: 0, committed: null, pending: n.root }) };
  const storeOptions = { ...n.options, directory: join(n.directory, 'replica'), maxBytes: 4 * 1024 * 1024 + BLOCK_BYTES };
  const downloadOptions = { directory: join(n.directory, 'download'), localKey: n.localKey, context: n.context, signingKey: n.owner, proposal: n.a, maxBytes: 4 * 1024 * 1024 + BLOCK_BYTES,
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${33000 + i}/history-checkpoint` })),
    transport: (async (member, frame) => roles[n.context.members.indexOf(member.publicKey)].exchange(frame)) as NonNullable<Parameters<typeof createHistoryAncestryDownload>[0]['transport']> };
  const open = (initialize: boolean, selected = authority) => withStorageReservationAuthority(selected, () => {
    const archive = openHistoryWriterArchive({ ...archiveOptions, initialize }); cleanup.push(archive.close);
    const store = openHistoryCheckpointStore({ ...storeOptions, ...(initialize ? { initialize: n.root } : {}) }); cleanup.push(store.close);
    const download = createHistoryAncestryDownload({ ...downloadOptions, initialize }); cleanup.push(download.close);
    return { archive, store, download, close() { download.close(); store.close(); archive.close(); } };
  });
  return { ...n, ledger, authority, archiveOptions, storeOptions, downloadOptions, open };
}
it('reserves blocks and manifest replacements together and retains writable history at a full shared budget', async () => {
  const n = fixture(), writers = n.open(true);
  expect(n.authority.status()).toMatchObject({ components: 6, availableBytes: 0 });
  writers.archive.retainPending(); writers.store.append(n.delta);
  await writers.download.run({ maxBlocks: 1 });
  expect(writers.download.read()).toMatchObject({ complete: false, blocks: 1 });
  const next = join(n.directory, 'unfunded');
  expect(() => withStorageReservationAuthority(n.authority, () => openHistoryCheckpointStore({ ...n.storeOptions, directory: next, initialize: n.root }))).toThrow(/exhausted/);
  expect(existsSync(next)).toBe(false);
  writers.store.freeze(createHistoryFreeze(n.context, 0, 1, Buffer.alloc(32, 1).toString('base64url'), n.owner));
  const id = n.authority.status().authorityId; writers.close(); n.authority.close();
  const restored = openStorageReservationAuthority({ directory: n.ledger, mode: 'open-existing', authorityId: id }); cleanup.push(restored.close);
  const reopened = n.open(false, restored);
  expect(restored.status()).toMatchObject({ components: 6, availableBytes: 0 });
  expect([...reopened.archive.blocks()]).toEqual([n.root]); expect(reopened.store.read().envelopes).toEqual([n.root, n.delta]);
  expect((await reopened.download.run()).complete).toBe(true); expect([...reopened.download.blocks()]).toEqual(n.blocks);
  const saved = readdirSync(n.downloadOptions.directory).sort().map(name => [name, readFileSync(join(n.downloadOptions.directory, name))]);
  restored.close();
  expect(() => reopened.archive.retainPending()).toThrow(/closed/);
  expect(() => reopened.store.append(n.next(n.delta))).toThrow(/closed/);
  await expect(reopened.download.run()).rejects.toThrow(/closed/);
  expect(readdirSync(n.downloadOptions.directory).sort().map(name => [name, readFileSync(join(n.downloadOptions.directory, name))])).toEqual(saved);
});
it.each(['archive', 'replica', 'download'] as const)('funds both ciphertext and manifest before creating a %s directory', kind => {
  const n = fixture(BLOCK_BYTES);
  expect(() => withStorageReservationAuthority(n.authority, () => {
    if (kind === 'archive') openHistoryWriterArchive({ ...n.archiveOptions, initialize: true });
    else if (kind === 'replica') openHistoryCheckpointStore({ ...n.storeOptions, initialize: n.root });
    else createHistoryAncestryDownload({ ...n.downloadOptions, initialize: true });
  })).toThrow(/exhausted/);
  expect(existsSync(join(n.directory, kind))).toBe(false);
  // A partial reservation remains charged. No output or local lock was authorized.
  expect(n.authority.status()).toMatchObject({ components: 1, availableBytes: 0, reservedBytes: CONTROL + BLOCK_BYTES });
});
it('refuses a larger component on reopen without losing its accepted blocks or original allocation', () => {
  const n = fixture(), writers = n.open(true); writers.store.append(n.delta); writers.close();
  const path = join(n.storeOptions.directory, `${historyCheckpointEnvelopeId(n.delta).slice(7)}.block`), before = readFileSync(path);
  expect(() => withStorageReservationAuthority(n.authority, () => openHistoryCheckpointStore({ ...n.storeOptions, maxBytes: n.storeOptions.maxBytes + 1 }))).toThrow(/exhausted/);
  expect(readFileSync(path)).toEqual(before);
  expect(n.open(false).store.read().envelopes).toEqual([n.root, n.delta]);
  expect(n.authority.status()).toMatchObject({ components: 6, availableBytes: 0 });
});
it('keeps the same reserved floor through explicit repair of a pristine interrupted genesis', () => {
  const n = fixture(MANIFEST_PEAK + BLOCK_BYTES);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to).endsWith('.block')) throw new Error('genesis publication interrupted'); actual.renameSync(from, to); });
  expect(() => withStorageReservationAuthority(n.authority, () => openHistoryCheckpointStore({ ...n.storeOptions, initialize: n.root }))).toThrow(/interrupted/);
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const repair = withStorageReservationAuthority(n.authority, () => inspectPristineHistoryGenesis({ ...n.storeOptions, genesis: n.root })); cleanup.push(repair.close);
  repair.complete(repair.reviewDigest()); repair.close();
  const store = withStorageReservationAuthority(n.authority, () => openHistoryCheckpointStore(n.storeOptions)); cleanup.push(store.close);
  expect(store.read().envelopes).toEqual([n.root]); expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 2 });
});
it('rechecks a captured download lease after asynchronous network delivery before writing a block', async () => {
  const n = fixture();
  const original = n.downloadOptions.transport;
  n.downloadOptions.transport = async (member, frame, signal) => { const reply = await original(member, frame, signal); n.authority.close(); return reply; };
  const { download } = n.open(true);
  await expect(download.run({ maxBlocks: 1 })).rejects.toThrow();
  expect(readdirSync(n.downloadOptions.directory).filter(name => name.endsWith('.block'))).toEqual([]);
});

it('adopts retained encrypted history and unknown files conservatively before reopening at the new exact ceiling', async () => {
  const n = fixture(), writers = n.open(true); writers.archive.retainPending(); writers.store.append(n.delta);
  await writers.download.run({ maxBlocks: 1 }); writers.close();
  const unknown = join(n.directory, 'legacy-unclassified'); writeFileSync(unknown, 'preserve this unclassified obligation');
  const targets = [n.archiveOptions.directory, n.storeOptions.directory, n.downloadOptions.directory].map(path => ({ path, scope: 'directory' as const }));
  const selected = [...targets, { path: unknown, scope: 'file' as const }];
  const review = n.authority.reviewExisting(selected);
  expect(review.fits).toBe(false); expect(review.observedBytes).toBeGreaterThan(0);
  expect(() => n.authority.adoptExisting(selected, review.approvalDigest)).toThrow(/exhausted/);
  n.authority.applyLimit(review.reservedBytes, n.authority.reviewLimit(review.reservedBytes).approvalDigest);
  n.authority.adoptExisting(selected, n.authority.reviewExisting(selected).approvalDigest);
  const charged = n.authority.status(); expect(charged).toMatchObject({ components: 6, adoptedSelections: 4, availableBytes: 0 });
  const reopened = n.open(false); expect(reopened.store.read().envelopes).toEqual([n.root, n.delta]);
  const next = n.next(n.delta); reopened.store.append(next); expect((await reopened.download.run()).complete).toBe(true);
  expect([...reopened.archive.blocks()]).toEqual([n.root]); expect([...reopened.download.blocks()]).toEqual(n.blocks);
  expect(readFileSync(unknown, 'utf8')).toBe('preserve this unclassified obligation'); expect(n.authority.status()).toEqual(charged);
});
