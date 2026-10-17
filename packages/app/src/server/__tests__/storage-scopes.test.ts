import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { beginRelayMaintenance, acquireStoppedRelayMaintenance, openRelayStorageOwner } from '@resonance/relay';
import { openDesktopStorageBootstrapReview } from '../relay-storage-bootstrap.js';
import { collectDesktopRelayStorageScopes } from '../relay-storage-scopes.js';
import { retainRelayStorageRegistry } from '../history-storage-registry.js';
import { desktopRelayStorageControls } from '../relay-storage.js';
import { prepareRelayServiceInstallation, relayServiceOutputPaths } from '../relay-supervisor.js';
import type { RelayConfig } from '../session.js';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.clearAllMocks(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-storage-scopes-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'app'), home = join(root, 'home'); mkdirSync(directory); mkdirSync(home); vi.mocked(homedir).mockReturnValue(home);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const config: RelayConfig = { enabled: false, port }, runtime = join(directory, 'relay-data');
  writeFileSync(join(directory, 'relay-config.json'), JSON.stringify(config)); beginRelayMaintenance(runtime);
  const bootstrap = await openDesktopStorageBootstrapReview({ dataDirectory: directory, runtimePort: port, mode: 'new', limitBytes: 256 * 1024 * 1024 });
  const ready = bootstrap.apply(bootstrap.review().approvalDigest);
  const authority = openStorageReservationAuthority({ directory: ready.authorityDirectory, authorityId: ready.authorityId, mode: 'open-existing' }); cleanup.push(authority.close);
  const releaseControl = withStorageReservationAuthority(authority, () => acquireLocalStateLock(join(directory, 'relay-desktop-control'))); cleanup.push(releaseControl);
  const releaseRuntime = withStorageReservationAuthority(authority, () => acquireStoppedRelayMaintenance(runtime)); cleanup.push(releaseRuntime);
  const collect = (platform: NodeJS.Platform = process.platform) => collectDesktopRelayStorageScopes(config, directory, { platform, userDirectory: home });
  return { root, directory, home, config, port, runtime, ready, authority, releaseControl, releaseRuntime, collect };
}
it.each(['darwin', 'linux', 'win32'] as const)('selects retained files and absent %s service parents without creating outputs', async platform => {
  const n = await fixture(), history = join(n.root, 'history'), recovery = join(n.root, 'recovery'), output = join(n.root, 'old-enrollment.json');
  mkdirSync(history); mkdirSync(recovery); writeFileSync(join(history, 'unknown'), 'preserve'); writeFileSync(output, 'old export');
  retainRelayStorageRegistry(n.runtime, [history, recovery], [output]);
  writeFileSync(join(n.directory, '.relay-config.json.unrecognized'), 'retain interrupted');
  writeFileSync(join(n.directory, 'relay-service.log'), 'legacy log');
  writeFileSync(join(n.directory, 'unrelated-wallet'), 'not a relay output');
  const plan = n.collect(platform), paths = plan.existing.map(t => t.path);
  for (const path of [history, recovery, output, join(n.directory, 'relay-storage-locations'), join(n.directory, '.relay-config.json.unrecognized'), join(n.directory, 'relay-service.log')]) expect(paths).toContain(path);
  expect(paths).not.toContain(join(n.directory, 'unrelated-wallet')); expect(paths).not.toContain(n.directory);
  expect(plan.new).toContainEqual({ path: plan.selectionFile, scope: 'file' });
  for (const path of relayServiceOutputPaths(n.directory, platform, n.home)) expect(existsSync(path)).toBe(false);
  const review = n.authority.reviewExisting(plan.existing); expect(review.observedBytes).toBeGreaterThan(0);
  expect(review.targets.some(t => t.path === history && t.observedBytes >= 8)).toBe(true);
  expect(() => n.authority.reviewNewScopes(plan.new)).not.toThrow(); expect(execFileSync).not.toHaveBeenCalled();
});
it('adopts the complete selection then funds actual native preparation and immutable export under the scoped owner', async () => {
  const n = await fixture(), plan = n.collect();
  n.authority.adoptExisting(plan.existing, n.authority.reviewExisting(plan.existing).approvalDigest);
  n.authority.approveNewScopes(plan.new, n.authority.reviewNewScopes(plan.new).approvalDigest);
  n.releaseRuntime(); n.releaseControl(); n.authority.close();
  const owner = openRelayStorageOwner(n.ready, 'maintenance', desktopRelayStorageControls(n.directory)); cleanup.push(owner.close);
  const binding = { runtimePort: n.port, runtimeHost: '127.0.0.1' as const };
  owner.exportSelection(plan.selectionFile, binding, owner.reviewSelectionOutput(plan.selectionFile, binding).approvalDigest);
  const entry = join(n.root, 'relay.mjs'); writeFileSync(entry, '// fixture only');
  owner.run(() => prepareRelayServiceInstallation({ dataDir: n.directory, port: n.port, adminKey: 'test-admin', contacts: [], nodePath: process.execPath,
    workingDirectory: n.root, entryPath: entry, storageSelectionFile: plan.selectionFile }));
  expect(owner.status().adoptedSelections).toBeGreaterThan(0); expect(execFileSync).not.toHaveBeenCalled();
  for (const path of relayServiceOutputPaths(n.directory, process.platform, n.home)) expect(readFileSync(path, 'utf8')).toContain('RELAY_STORAGE_SELECTION_FILE');
});
it('requires recovery for a missing retained history root or approved output', async () => {
  const n = await fixture(), retained = join(n.root, 'missing-history');
  n.config.historyStorageDirectories = [retained]; expect(n.collect).toThrow(/retained.*missing/); expect(existsSync(retained)).toBe(false);
  n.config.historyStorageDirectories = undefined;
  retainRelayStorageRegistry(n.runtime, [n.runtime], [join(n.root, 'missing-approved-export')]); expect(n.collect).toThrow(/retained.*missing/);
});
it('includes an old native definition and every namespaced interrupted sidecar without including other services', async () => {
  const n = await fixture(), path = relayServiceOutputPaths(n.directory, 'darwin', n.home)[0]; mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'legacy stdout capture'); writeFileSync(path + '.old', 'retained old definition');
  writeFileSync(join(dirname(path), 'other-app.plist'), 'another service');
  const plan = n.collect('darwin'); expect(plan.existing).toContainEqual({ path: realpathSync(path), scope: 'file' });
  expect(plan.existing).toContainEqual({ path: realpathSync(path + '.old'), scope: 'file' });
  expect(plan.existing.some(target => target.path.endsWith('other-app.plist'))).toBe(false);
  expect(plan.new.some(target => target.path === path)).toBe(false);
});
it.each(['symlink', 'hardlink'] as const)('refuses a %s in an interrupted output family before any adoption', async kind => {
  const n = await fixture(), target = join(n.directory, '.relay-config.json.retained'), source = join(n.root, 'source'); writeFileSync(source, 'retain');
  if (kind === 'symlink') symlinkSync(source, target); else linkSync(source, target);
  const before = n.authority.status(); expect(n.collect).toThrow(/ordinary/); expect(n.authority.status()).toEqual(before); expect(readFileSync(source, 'utf8')).toBe('retain');
});
it('does not flatten overlapping retained roots or lose unknown nested files in the byte review', async () => {
  const n = await fixture(), parent = join(n.root, 'history'), child = join(parent, 'older'); mkdirSync(child, { recursive: true });
  writeFileSync(join(child, 'unknown.pending'), 'old accepted data');
  n.config.historyStorageDirectories = [parent, child];
  const plan = n.collect(); expect(plan.existing).toContainEqual({ path: parent, scope: 'directory' }); expect(plan.existing.some(t => t.path === child)).toBe(false);
  expect(n.authority.reviewExisting(plan.existing).targets.find(t => t.path === parent)?.observedBytes).toBe(17);
});
it('bounds unknown sidecar enumeration instead of silently omitting excess files', async () => {
  const n = await fixture(); for (let i = 0; i < 260; i++) writeFileSync(join(n.directory, `relay-config.json.unknown-${i}`), 'retain');
  expect(n.collect).toThrow(/target bound/); expect(n.authority.status().adoptedSelections).toBe(0);
});

it('refuses a history root that would also adopt independently written desktop account data', async () => {
  const n = await fixture(); n.config.historyStorageDirectories = [n.directory];
  expect(n.collect).toThrow(/desktop account data/); expect(n.authority.status().adoptedSelections).toBe(0);
});
