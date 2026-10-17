import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, STORAGE_RESERVATION_MANIFEST_BYTES as MANIFEST } from '../storage-reservations.js';
import { withStorageReservationAuthority } from '../storage-reservation-context.js';
import { openEncryptedLocalState } from '../local-encrypted-state.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, writeSync: vi.fn(fs.writeSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(writeSync).mockImplementation(actual.writeSync); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'reservation-authority-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true })); return { directory, ledger: join(directory, 'authority') }; }
function fresh(n: ReturnType<typeof fixture>, extra: number) { const authority = openStorageReservationAuthority({ directory: n.ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close); return authority; }
function reopen(n: ReturnType<typeof fixture>, authorityId: string) { const authority = openStorageReservationAuthority({ directory: n.ledger, mode: 'open-existing', authorityId }); cleanup.push(authority.close); return authority; }
const file = (path: string, maximumBytes: number, component = 'test') => ({ path, maximumBytes, component, scope: 'file' as const });
it('shares one durable ceiling without freeing missing paths, smaller limits or closed components', () => {
  const n = fixture(), authority = fresh(n, 300), id = authority.status().authorityId;
  const first = file(join(n.directory, 'first'), 100), second = file(join(n.directory, 'second'), 200);
  authority.reserve(first).assertWritable(); authority.reserve(second).assertWritable();
  expect(authority.status()).toMatchObject({ reservedBytes: CONTROL + 300, availableBytes: 0, components: 2 });
  expect(existsSync(first.path)).toBe(false);
  authority.reserve({ ...first, maximumBytes: 1 });
  const digest = authority.reviewDigest();
  expect(() => authority.reserve(file(join(n.directory, 'extra'), 1))).toThrow(/exhausted/);
  expect(authority.reviewDigest()).toBe(digest); authority.close();
  expect(reopen(n, id).status()).toMatchObject({ reservedBytes: CONTROL + 300, availableBytes: 0, components: 2 });
});
it('refuses competing writers, wrong authority selection and reinitialization', () => {
  const n = fixture(), authority = fresh(n, 100), id = authority.status().authorityId;
  expect(() => reopen(n, id)).toThrow(/already open/);
  expect(() => fresh(n, 100)).toThrow(); authority.close();
  expect(() => reopen(n, '0'.repeat(32))).toThrow(/independently retained/);
  expect(reopen(n, id).status().authorityId).toBe(id);
  const other = fixture(); expect(() => fresh(other, -1)).toThrow(/headroom/); expect(existsSync(other.ledger)).toBe(false);
});
it('retains the previous allocation after a short write and refuses leases on an uncertain writer', () => {
  const n = fixture(), authority = fresh(n, 300), id = authority.status().authorityId;
  const lease = authority.reserve(file(join(n.directory, 'first'), 100));
  vi.mocked(writeSync).mockImplementationOnce(() => 0);
  expect(() => authority.reserve(file(join(n.directory, 'next'), 100))).toThrow(/stopped/);
  expect(() => lease.assertWritable()).toThrow(/uncertain/); authority.close();
  expect(reopen(n, id).status()).toMatchObject({ reservedBytes: CONTROL + 100, components: 1 });
});
it.each(['file', 'directory'] as const)('retains the correct allocation after a %s flush fails', kind => {
  if (kind === 'directory' && process.platform === 'win32') return;
  const n = fixture(), authority = fresh(n, 300), id = authority.status().authorityId;
  authority.reserve(file(join(n.directory, 'first'), 100)); let calls = 0;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === (kind === 'file' ? 1 : 2)) throw new Error('injected flush failure'); actual.fsyncSync(fd); });
  expect(() => authority.reserve(file(join(n.directory, 'next'), 100))).toThrow(/flush failure/);
  expect(() => authority.status()).toThrow(/uncertain/); authority.close();
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  expect(reopen(n, id).status()).toMatchObject({ reservedBytes: CONTROL + (kind === 'file' ? 100 : 200) });
});
it('does not recover missing primary metadata from a pending replacement or echo corrupt contents', () => {
  const n = fixture(), authority = fresh(n, 300), id = authority.status().authorityId; authority.close();
  const path = join(n.ledger, 'reservations.json'), bytes = readFileSync(path);
  writeFileSync(`${path}.next`, bytes); rmSync(path);
  expect(() => reopen(n, id)).toThrow(); expect(() => fresh(n, 300)).toThrow();
  writeFileSync(path, 'private-corrupt-content'); expect(() => reopen(n, id)).toThrow('Storage authority metadata is invalid; retain it for inspection');
  writeFileSync(path, Buffer.alloc(MANIFEST + 1)); expect(() => reopen(n, id)).toThrow(/bounded/);
});
it.skipIf(process.platform === 'win32')('binds canonical paths and refuses redirected or hard-linked output targets', () => {
  const n = fixture(), authority = fresh(n, 300), actualDir = join(n.directory, 'actual'), alias = join(n.directory, 'alias');
  mkdirSync(actualDir); symlinkSync(actualDir, alias);
  const path = join(actualDir, 'output'), aliasPath = join(alias, 'output');
  const lease = authority.reserve(file(aliasPath, 100)); authority.reserve(file(path, 100)); expect(authority.status().components).toBe(1);
  expect(() => authority.reserve(file(path, 100, 'other'))).toThrow(/another component/);
  writeFileSync(path, 'retained'); linkSync(path, join(n.directory, 'hard-link'));
  expect(() => lease.assertWritable()).toThrow(/unaliased/); rmSync(join(n.directory, 'hard-link'));
  rmSync(alias); const other = join(n.directory, 'other'); mkdirSync(other); symlinkSync(other, alias);
  expect(() => lease.assertWritable()).toThrow(/path changed/); expect(readFileSync(path, 'utf8')).toBe('retained');
});
it('refuses existing leases when the current ledger is deleted or changed', () => {
  const n = fixture(), authority = fresh(n, 300), lease = authority.reserve(file(join(n.directory, 'data'), 100));
  rmSync(join(n.ledger, 'reservations.json')); expect(() => lease.assertWritable()).toThrow();
  expect(() => authority.reserve(file(join(n.directory, 'another'), 100))).toThrow(/uncertain/);
});
const validImage = (value: unknown): value is { text: string } => !!value && typeof value === 'object' && typeof (value as { text: string }).text === 'string';
it('reserves encrypted snapshot replacement headroom before initialization and keeps existing work writable at a full budget', () => {
  const n = fixture(), maximum = 512, peak = 2 * maximum + 8192, authority = fresh(n, peak);
  const first = join(n.directory, 'first', 'state.json'), second = join(n.directory, 'second', 'state.json');
  const options = { path: first, key: Buffer.alloc(32, 7), domain: 'test:snapshot', maxBytes: maximum, initial: { text: 'initial' }, validate: validImage };
  const state = withStorageReservationAuthority(authority, () => openEncryptedLocalState(options)); cleanup.push(state.close);
  expect(authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
  expect(() => withStorageReservationAuthority(authority, () => openEncryptedLocalState({ ...options, path: second }))).toThrow(/exhausted/);
  expect(existsSync(join(n.directory, 'second'))).toBe(false);
  state.write({ text: 'accepted replacement' }); expect(state.read()).toEqual({ text: 'accepted replacement' });
  // Mutating caller options must not enlarge the component's reserved peak.
  options.maxBytes = 1000000; expect(() => state.write({ text: 'x'.repeat(1000) })).toThrow(/capacity/);
  state.close(); authority.close();
  const restored = openEncryptedLocalState({ ...options, maxBytes: maximum, mode: 'open-existing' }); cleanup.push(restored.close);
  expect(restored.read()).toEqual({ text: 'accepted replacement' });
});
it('keeps a captured snapshot lease after async scope exit and refuses writes after authority close', async () => {
  const n = fixture(), authority = fresh(n, 10000), another = fresh(fixture(), 10000);
  const state = await withStorageReservationAuthority(authority, async () => {
    await Promise.resolve();
    expect(() => withStorageReservationAuthority(another, () => {})).toThrow(/switch/);
    return openEncryptedLocalState({ path: join(n.directory, 'image'), key: Buffer.alloc(32, 1), domain: 'test:async', maxBytes: 512, initial: { text: '' }, validate: validImage });
  }); cleanup.push(state.close);
  state.write({ text: 'retained' }); authority.close();
  expect(() => state.write({ text: 'unreserved' })).toThrow(/closed/);
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
async function child(args: string[]) {
  const process_ = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/reservation-child.ts', import.meta.url)), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; process_.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const exit = once(process_, 'exit'), timer = setTimeout(() => process_.kill('SIGKILL'), 10000);
  try { return { exit: await exit, stderr }; } finally { clearTimeout(timer); }
}
it('excludes a second real process and refuses creation of another authority inside a managed scope', async () => {
  const n = fixture(), authority = fresh(n, 100), id = authority.status().authorityId;
  expect(await child([n.ledger, id, 'competing', join(n.directory, 'child')])).toEqual({ exit: [0, null], stderr: '' });
  const other = fixture(); expect(() => withStorageReservationAuthority(authority, () => fresh(other, 100))).toThrow(/before entering/);
  expect(existsSync(other.ledger)).toBe(false);
}, 15000);
it.skipIf(process.platform === 'win32').each(['before-rename', 'after-rename', 'reserved', 'written'])(
  'retains the correct reservation across SIGKILL at %s', async boundary => {
    const n = fixture(), authority = fresh(n, 100), id = authority.status().authorityId, target = join(n.directory, 'payload'); authority.close();
    expect(await child([n.ledger, id, boundary, target])).toEqual({ exit: [null, 'SIGKILL'], stderr: '' });
    const restored = reopen(n, id); expect(restored.status()).toMatchObject({ reservedBytes: CONTROL + (boundary === 'before-rename' ? 0 : 100) });
    expect(existsSync(target)).toBe(boundary === 'written');
    if (boundary !== 'before-rename') expect(() => restored.reserve(file(join(n.directory, 'another'), 1))).toThrow(/exhausted/);
  }, 15000);
it.skipIf(process.platform === 'win32')('never treats an interrupted first authority as unused storage', async () => {
  const n = fixture();
  expect(await child([n.ledger, 'new', 'partial-initial', join(n.directory, 'payload')])).toEqual({ exit: [null, 'SIGKILL'], stderr: '' });
  expect(() => fresh(n, 100)).toThrow(); expect(() => reopen(n, '0'.repeat(32))).toThrow(); expect(existsSync(join(n.directory, 'payload'))).toBe(false);
}, 15000);


it('binds a limit change to the current review and never drops an existing reservation', () => {
  const n = fixture(), authority = fresh(n, 300);
  authority.reserve(file(join(n.directory, 'first'), 100));
  const stale = authority.reviewLimit(CONTROL + 200);
  authority.reserve(file(join(n.directory, 'second'), 50));
  expect(() => authority.applyLimit(stale.limitBytes, stale.approvalDigest)).toThrow(/approval changed/);
  expect(() => authority.reviewLimit(CONTROL + 149)).toThrow(/retained/);
  const exact = authority.reviewLimit(CONTROL + 150); authority.applyLimit(exact.limitBytes, exact.approvalDigest);
  expect(authority.status()).toMatchObject({ availableBytes: 0, reservedBytes: CONTROL + 150 });
  const raised = authority.reviewLimit(CONTROL + 400); authority.applyLimit(raised.limitBytes, raised.approvalDigest);
  expect(authority.status()).toMatchObject({ availableBytes: 250, reservedBytes: CONTROL + 150, components: 2 });
});


it('retains a zero-byte component in control headroom without authorizing later growth', () => {
  const n = fixture(), authority = fresh(n, 0), request = file(join(n.directory, 'zero-capacity-journal'), 0);
  authority.reserve(request).assertWritable();
  expect(authority.status()).toMatchObject({ availableBytes: 0, components: 1, reservedBytes: CONTROL });
  expect(() => authority.reserve({ ...request, maximumBytes: 1 })).toThrow(/exhausted/);
});
