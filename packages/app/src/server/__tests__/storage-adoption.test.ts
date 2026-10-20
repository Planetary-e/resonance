import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { beginRelayMaintenance, openRelayStorageOwner, readRelayMaintenance } from '@resonance/relay';
import { desktopRelayStorageControls } from '../relay-storage.js';
import { openDesktopStorageBootstrapReview, DESKTOP_STORAGE_BOOTSTRAP_MINIMUM_BYTES as MINIMUM } from '../relay-storage-bootstrap.js';
import { openDesktopStorageAdoptionReview } from '../relay-storage-adoption.js';
import type { RelayConfig } from '../session.js';
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [], LIMIT = 256 * 1024 * 1024;
afterEach(async () => { vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-storage-adoption-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'app'), home = join(root, 'home'); mkdirSync(directory); mkdirSync(home); vi.mocked(homedir).mockReturnValue(home);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const config: RelayConfig = { enabled: false, port }, runtime = join(directory, 'relay-data');
  writeFileSync(join(directory, 'relay-config.json'), JSON.stringify(config)); beginRelayMaintenance(runtime);
  writeFileSync(join(runtime, 'unknown-retained'), 'preserve accepted history');
  const bootstrap = await openDesktopStorageBootstrapReview({ dataDirectory: directory, runtimePort: port, mode: 'new', limitBytes: MINIMUM });
  const ready = bootstrap.apply(bootstrap.review().approvalDigest), options = { dataDirectory: directory, config, limitBytes: LIMIT };
  const review = async (overrides: Partial<typeof options> & { signal?: AbortSignal; approvalTimeoutMs?: number } = {}) => {
    const handle = await openDesktopStorageAdoptionReview({ ...options, ...overrides }); cleanup.push(handle.close); return handle;
  };
  const open = () => { const authority = openStorageReservationAuthority({ directory: ready.authorityDirectory, authorityId: ready.authorityId, mode: 'open-existing' }); cleanup.push(authority.close); return authority; };
  return { root, directory, home, runtime, config, ready, options, review, open, primary: join(ready.authorityDirectory, 'reservations.json') };
}
it('reviews the complete initial selection and increased limit, applies it, and safely re-reviews already approved absent outputs', async () => {
  const n = await fixture(), handle = await n.review(), review = handle.review();
  expect(review).toMatchObject({ fits: true, limit: { previousLimitBytes: MINIMUM, limitBytes: LIMIT }, activationReady: false });
  expect(review.existing.observedBytes).toBeGreaterThan(0); expect(review.future?.targets.length).toBeGreaterThan(0);
  const changed = handle.review(); changed.existing.targets.length = 0;
  expect(handle.apply(review.approvalDigest)).toMatchObject({ result: 'desktop-storage-scopes-adopted', limitBytes: LIMIT, activationReady: false });
  expect(readFileSync(join(n.runtime, 'unknown-retained'), 'utf8')).toBe('preserve accepted history');
  const retry = await n.review(), repeated = retry.review(); expect(repeated.future).toBeNull(); expect(repeated.reusable?.targets.length).toBeGreaterThan(0);
  retry.apply(repeated.approvalDigest);
  const owner = openRelayStorageOwner(n.ready, 'maintenance', desktopRelayStorageControls(n.directory)); cleanup.push(owner.close);
  const binding = { runtimePort: n.config.port, runtimeHost: '127.0.0.1' as const };
  owner.exportSelection(review.selectionFile, binding, owner.reviewSelectionOutput(review.selectionFile, binding).approvalDigest);
  expect(existsSync(review.selectionFile)).toBe(true); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
});
it('shows insufficient capacity before applying and never changes a limit or adopts files on refusal', async () => {
  const n = await fixture(), before = readFileSync(n.primary), handle = await n.review({ limitBytes: MINIMUM });
  expect(handle.review().fits).toBe(false); expect(() => handle.apply(handle.review().approvalDigest)).toThrow(/exceed/);
  expect(readFileSync(n.primary)).toEqual(before);
});
it.each(['wrong-approval', 'changed-files', 'changed-pins', 'cancelled'] as const)('rejects %s before the first durable commit', async failure => {
  const n = await fixture(), controller = new AbortController(), handle = await n.review({ signal: controller.signal }), review = handle.review(), before = readFileSync(n.primary);
  if (failure === 'changed-files') writeFileSync(join(n.runtime, 'unknown-retained'), 'changed accepted history');
  if (failure === 'changed-pins') { const path = join(n.directory, 'relay-storage-bootstrap', 'intent.json'); writeFileSync(path, readFileSync(path)); }
  if (failure === 'cancelled') controller.abort();
  expect(() => handle.apply(failure === 'wrong-approval' ? '0'.repeat(64) : review.approvalDigest)).toThrow();
  expect(readFileSync(n.primary)).toEqual(before); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
});
it('refuses a missing reserved registry even when a broader existing root covers its path', async () => {
  const n = await fixture(), owned = n.open(), limit = owned.reviewLimit(LIMIT); owned.applyLimit(limit.limitBytes, limit.approvalDigest);
  owned.reserve({ path: join(n.directory, 'relay-storage-locations'), scope: 'directory', component: 'desktop-storage-registry', maximumBytes: 1024 }); owned.close();
  await expect(n.review()).rejects.toThrow(/registry is missing/);
  await expect(n.review({ config: { ...n.config, historyStorageDirectories: [n.directory] } })).rejects.toThrow(/registry is missing/);
  expect(existsSync(join(n.directory, 'relay-storage-locations'))).toBe(false);
});
it.each([1, 2, 3])('requires fresh review and resumes after uncertain publication of commit %i', async commit => {
  const n = await fixture(), handle = await n.review(), review = handle.review(); let seen = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (String(to) === n.primary && ++seen === commit) throw new Error('uncertain adoption commit');
  });
  expect(() => handle.apply(review.approvalDigest)).toThrow(/uncertain/); vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const retry = await n.review(); expect(() => retry.apply(review.approvalDigest)).toThrow(/approval changed/);
  const fresh = await n.review(); expect(fresh.apply(fresh.review().approvalDigest).authorityId).toBe(n.ready.authorityId);
  expect(readFileSync(join(n.runtime, 'unknown-retained'), 'utf8')).toBe('preserve accepted history');
});
it('rejects an external file change between the limit and adoption commits', async () => {
  const n = await fixture(), handle = await n.review(), review = handle.review(); let injected = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (String(to) === n.primary && !injected) { injected = true; writeFileSync(join(n.runtime, 'unknown-retained'), 'changed after limit approval'); }
  });
  expect(() => handle.apply(review.approvalDigest)).toThrow(/changed after the limit/); vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const owner = n.open(); expect(owner.status()).toMatchObject({ limitBytes: LIMIT, adoptedSelections: 0 });
});
it('rejects changed new-output parent metadata between the existing and new-scope commits', async () => {
  const n = await fixture(), handle = await n.review(), review = handle.review(); let commits = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    actual.renameSync(from, to);
    if (String(to) === n.primary && ++commits === 2) writeFileSync(join(n.directory, 'new-unreviewed-sibling'), 'keep');
  });
  expect(() => handle.apply(review.approvalDigest)).toThrow(/parents changed/); vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const retry = await n.review(); expect(retry.apply(retry.review().approvalDigest).authorityId).toBe(n.ready.authorityId);
});
it('expires abandoned ownership without clearing its maintenance marker', async () => {
  const n = await fixture(), handle = await n.review({ approvalTimeoutMs: 100 }); await new Promise(resolve => setTimeout(resolve, 150));
  expect(() => handle.review()).toThrow(/closed|expired/); const retry = await n.review(); retry.close(); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
});
it.skipIf(process.platform === 'win32').each([1, 2, 3])('retains partial adoption after SIGKILL following commit %i', async commit => {
  const n = await fixture(), child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-adoption-crash.ts', import.meta.url)), JSON.stringify(n.options), n.home, String(commit)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr!.on('data', chunk => { error += String(chunk); }); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { expect(await once(child, 'exit'), error).toEqual([null, 'SIGKILL']); } finally { clearTimeout(timer); }
  expect(error).toBe(''); const retry = await n.review(); expect(retry.apply(retry.review().approvalDigest)).toMatchObject({ authorityId: n.ready.authorityId, limitBytes: LIMIT });
  expect(readFileSync(join(n.runtime, 'unknown-retained'), 'utf8')).toBe('preserve accepted history');
}, 15000);
