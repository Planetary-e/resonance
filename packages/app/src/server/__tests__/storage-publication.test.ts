import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginRelayMaintenance, openRelayStorageOwner, RELAY_STORAGE_SELECTION_MAX_BYTES } from '@resonance/relay';
import { reserveManagedStorage, openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { desktopRelayStorageControls, desktopStorageSelectionPaths } from '../relay-storage.js';
import { openDesktopStorageBootstrapReview } from '../relay-storage-bootstrap.js';
import { openDesktopStorageAdoptionReview } from '../relay-storage-adoption.js';
import { reviewDesktopStoragePublication } from '../relay-storage-publication.js';
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, openSync: vi.fn(fs.openSync), writeSync: vi.fn(fs.writeSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(openSync).mockReset().mockImplementation(actual.openSync); vi.mocked(writeSync).mockReset().mockImplementation(actual.writeSync); vi.mocked(fsyncSync).mockReset().mockImplementation(actual.fsyncSync); for (const close of cleanup.splice(0).reverse()) close(); vi.clearAllMocks(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'storage-selection-publication-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'app'), home = join(root, 'home'); mkdirSync(directory); mkdirSync(home); vi.mocked(homedir).mockReturnValue(home);
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const runtime = join(directory, 'relay-data'), config = { enabled: false, port }; writeFileSync(join(directory, 'relay-config.json'), JSON.stringify(config)); beginRelayMaintenance(runtime);
  const bootstrap = await openDesktopStorageBootstrapReview({ dataDirectory: directory, runtimePort: port, mode: 'new', limitBytes: 256 * 1024 * 1024 });
  const ready = bootstrap.apply(bootstrap.review().approvalDigest), adoption = await openDesktopStorageAdoptionReview({ dataDirectory: directory, config }); adoption.apply(adoption.review().approvalDigest);
  const open = () => { const owner = openRelayStorageOwner(ready, 'maintenance', desktopRelayStorageControls(directory)); cleanup.push(owner.close); return owner; };
  const owner = open(), input = { ...ready, dataDirectory: directory, runtimePort: port, runtimeHost: '127.0.0.1' as const };
  const paths = desktopStorageSelectionPaths(directory), request = (path: string) => ({ path, scope: 'file' as const, component: 'operator-output', maximumBytes: RELAY_STORAGE_SELECTION_MAX_BYTES });
  function partial(path: string) { owner.run(() => { reserveManagedStorage(request(path))!.assertWritable(); writeFileSync(path, '{'); }); }
  return { root, directory, runtime, ready, input, owner, open, paths, partial, request, review: () => reviewDesktopStoragePublication(owner, input) };
}
it('publishes one immutable selection and reuses it without another allocation', async () => {
  const n = await fixture(), before = n.owner.status(), h = n.review(), review = h.review();
  expect(review.output).toBe(n.paths[0]); expect(review.reusesPublishedOutput).toBe(false);
  expect(n.owner.status()).toEqual(before); const result = h.apply(review.approvalDigest);
  expect(result.snapshot.configuration.authorityId).toBe(n.ready.authorityId); expect(() => h.apply(review.approvalDigest)).toThrow(/already attempted/);
  const bytes = readFileSync(n.paths[0]), status = n.owner.status(), repeated = n.review(); expect(repeated.review().reusesPublishedOutput).toBe(true);
  repeated.apply(repeated.review().approvalDigest); expect(readFileSync(n.paths[0])).toEqual(bytes); expect(n.owner.status()).toEqual(status);
  expect(n.paths.slice(1).every(path => !existsSync(path))).toBe(true);
});
it.each(['partial-write', 'uncertain-flush'] as const)('retains an interrupted output after %s and chooses the correct recovery path', async boundary => {
  const n = await fixture(), h = n.review(); let target: number | undefined, failed = false;
  vi.mocked(openSync).mockImplementation((path, flags, mode) => { const fd = actual.openSync(path, flags, mode); if (String(path) === n.paths[0] && flags === 'wx') target = fd; return fd; });
  vi.mocked(writeSync).mockImplementation(((fd: number, ...args: unknown[]) => {
    if (!failed && fd === target && boundary === 'partial-write') { failed = true; actual.writeSync(fd, Buffer.from('{')); throw new Error('selection write interrupted'); }
    return Reflect.apply(actual.writeSync, actual, [fd, ...args]);
  }) as typeof writeSync);
  vi.mocked(fsyncSync).mockImplementation(fd => { actual.fsyncSync(fd); if (!failed && fd === target && boundary === 'uncertain-flush') { failed = true; throw new Error('selection flush uncertain'); } });
  expect(() => h.apply(h.review().approvalDigest)).toThrow(/interrupted|uncertain/);
  vi.mocked(openSync).mockImplementation(actual.openSync); vi.mocked(writeSync).mockImplementation(actual.writeSync); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  const retained = readFileSync(n.paths[0]); expect(retained.length).toBeGreaterThan(0);
  const retry = n.review(), review = retry.review();
  expect(review.output).toBe(n.paths[boundary === 'partial-write' ? 1 : 0]); expect(review.reusesPublishedOutput).toBe(boundary === 'uncertain-flush');
  retry.apply(review.approvalDigest); expect(readFileSync(n.paths[0])).toEqual(retained);
});
it('refuses conflicting complete pins instead of skipping them as a partial attempt', async () => {
  const n = await fixture(), h = n.review(), result = h.apply(h.review().approvalDigest);
  writeFileSync(n.paths[0], JSON.stringify({ ...result.snapshot.configuration, authorityId: 'f'.repeat(32) }));
  expect(n.review).toThrow(/conflicting/); expect(existsSync(n.paths[1])).toBe(false);
});
it('retains all eight incomplete attempts and refuses a ninth output', async () => {
  const n = await fixture(); for (const path of n.paths) n.partial(path);
  expect(n.review).toThrow(/slots are full/); for (const path of n.paths) expect(readFileSync(path, 'utf8')).toBe('{');
});
it('rejects changed partial files and wrong approvals before any new output', async () => {
  const n = await fixture(); n.partial(n.paths[0]); const h = n.review(), reviewed = h.review(), before = n.owner.status();
  writeFileSync(n.paths[0], '[partial'); expect(() => h.apply(reviewed.approvalDigest)).toThrow(/approval changed/);
  const fresh = n.review(); expect(() => fresh.apply('0'.repeat(64))).toThrow(/approval changed/);
  expect(n.owner.status()).toEqual(before); expect(existsSync(n.paths[1])).toBe(false);
});
it('preflights the sum of distinct peaks and rejects duplicate targets without reserving either', async () => {
  const n = await fixture(), before = n.owner.status(), requests = [n.request(n.paths[0]), n.request(n.paths[1])];
  const review = n.owner.reviewWriteBudget(requests); expect(review.additionalBytes).toBe(2 * RELAY_STORAGE_SELECTION_MAX_BYTES); expect(n.owner.status()).toEqual(before);
  expect(() => n.owner.reviewWriteBudget([requests[0], requests[0]])).toThrow(/only once/); expect(n.owner.status()).toEqual(before);
});
it('retains a funded partial file at full capacity and refuses to create the next slot', async () => {
  const n = await fixture(); n.partial(n.paths[0]); n.owner.close();
  const raw = openStorageReservationAuthority({ directory: n.ready.authorityDirectory, authorityId: n.ready.authorityId, mode: 'open-existing' });
  const limit = raw.reviewLimit(raw.status().reservedBytes); raw.applyLimit(limit.limitBytes, limit.approvalDigest); raw.close();
  const owner = n.open(); expect(() => reviewDesktopStoragePublication(owner, n.input)).toThrow(/budget/);
  expect(readFileSync(n.paths[0], 'utf8')).toBe('{'); expect(existsSync(n.paths[1])).toBe(false);
});

it.skipIf(process.platform === 'win32').each(['partial', 'complete'] as const)('recovers a %s immutable output after real process death', async boundary => {
  const n = await fixture(); n.owner.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-publication-crash.ts', import.meta.url)), JSON.stringify(n.input), boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr!.on('data', chunk => { error += String(chunk); }); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { expect(await once(child, 'exit'), error).toEqual([null, 'SIGKILL']); } finally { clearTimeout(timer); }
  expect(error).toBe(''); const retained = readFileSync(n.paths[0]), owner = n.open(), retry = reviewDesktopStoragePublication(owner, n.input), review = retry.review();
  expect(review.output).toBe(n.paths[boundary === 'partial' ? 1 : 0]); expect(review.reusesPublishedOutput).toBe(boundary === 'complete');
  expect(retry.apply(review.approvalDigest).snapshot.configuration.authorityId).toBe(n.ready.authorityId); expect(readFileSync(n.paths[0])).toEqual(retained);
}, 15000);
