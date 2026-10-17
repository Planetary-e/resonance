import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { acquireStoppedRelayMaintenance, beginRelayMaintenance, readRelayMaintenance } from '../relay-maintenance.js';
import { openRelayStorageAdoptionReview } from '../relay-storage-adoption.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(extra = 2 * 1024 * 1024) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stopped-adoption-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const holder = createServer(); holder.listen(0, '127.0.0.1'); await once(holder, 'listening');
  const runtimePort = (holder.address() as { port: number }).port; await new Promise<void>(resolve => holder.close(() => resolve()));
  const data = join(directory, 'retained'), runtimeDirectory = join(data, 'relay-data'), authorityDirectory = join(directory, 'authority'); mkdirSync(data);
  const retained = join(data, 'unknown-records'); writeFileSync(retained, 'preserve old and interrupted work'); beginRelayMaintenance(runtimeDirectory);
  const authority = openStorageReservationAuthority({ directory: authorityDirectory, mode: 'create-new', limitBytes: CONTROL + 9216 + extra });
  const authorityId = authority.status().authorityId; authority.close();
  const options = { authorityDirectory, authorityId, runtimeDirectory, runtimePort, runtimeHost: '127.0.0.1' as const, kind: 'existing' as const,
    targets: [{ path: data, scope: 'directory' as const }] };
  const open = () => openStorageReservationAuthority({ directory: authorityDirectory, authorityId, mode: 'open-existing' });
  const prepare = async (input: Parameters<typeof openRelayStorageAdoptionReview>[0] = options) => { const review = await openRelayStorageAdoptionReview(input); cleanup.push(review.close); return review; };
  return { directory, data, retained, options, prepare, open, primary: join(authorityDirectory, 'reservations.json') };
}
it('holds both claims across a bounded approval, copies input/output and adopts unknown files without changing them', async () => {
  const n = await fixture(), before = readFileSync(n.retained), pending = n.prepare(); n.options.targets[0].path = join(n.directory, 'not-reviewed');
  const prepared = await pending, review = prepared.review();
  expect(n.open).toThrow(/already open/);
  expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
  expect(review.targets[0].path).toBe(n.data); review.targets[0].path = '/caller-cannot-redirect';
  const applied = prepared.apply(review.approvalDigest); expect(applied.appliedRevision).toBeGreaterThan(review.revision);
  expect(readFileSync(n.retained)).toEqual(before); expect(readRelayMaintenance(n.options.runtimeDirectory)).not.toBeNull();
  const reopened = n.open(); expect(reopened.status().adoptedBytes).toBeGreaterThanOrEqual(before.length); reopened.close();
  expect(() => prepared.apply(review.approvalDigest)).toThrow(/closed/);
});
it.each(['changed', 'wrong-approval', 'insufficient-budget'] as const)('retains files and closes claims after %s', async condition => {
  const n = await fixture(condition === 'insufficient-budget' ? 0 : undefined), prepared = await n.prepare(), review = prepared.review();
  if (condition === 'changed') writeFileSync(n.retained, 'updated external evidence');
  expect(() => prepared.apply(condition === 'wrong-approval' ? 'wrong' : review.approvalDigest)).toThrow(/approval|budget exhausted/);
  expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
  expect(existsSync(n.retained)).toBe(true); const opened = n.open(); opened.close();
  expect(readRelayMaintenance(n.options.runtimeDirectory)).not.toBeNull();
});
it.each(['expiry', 'cancel'] as const)('abandons a review on %s without adopting or clearing its pause', async condition => {
  const n = await fixture(), controller = new AbortController(), prepared = await n.prepare({ ...n.options, approvalTimeoutMs: 2000, signal: controller.signal });
  const review = prepared.review();
  if (condition === 'cancel') controller.abort(); else await new Promise(resolve => setTimeout(resolve, 2050));
  expect(() => prepared.apply(review.approvalDigest)).toThrow(/closed|expired/);
  expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]); const opened = n.open(); opened.close();
  expect(readRelayMaintenance(n.options.runtimeDirectory)).not.toBeNull();
});
it('refuses an older live listener, absent authority or pre-cancelled review without adopting files', async () => {
  const n = await fixture(), listener = createServer(socket => socket.destroy()); listener.listen(n.options.runtimePort, '127.0.0.1'); await once(listener, 'listening');
  cleanup.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
  await expect(n.prepare()).rejects.toThrow(/listener is not closed/);
  const opened = n.open(); opened.close(); expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
  await expect(n.prepare({ ...n.options, signal: AbortSignal.abort() })).rejects.toThrow();
  rmSync(n.primary); await expect(n.prepare()).rejects.toThrow(); expect(existsSync(n.primary)).toBe(false);
});
it('approves an explicitly new output separately and never creates it', async () => {
  const n = await fixture(), output = join(n.directory, 'new-output.json');
  const prepared = await n.prepare({ ...n.options, kind: 'new', targets: [{ path: output, scope: 'file' }] }), review = prepared.review();
  prepared.apply(review.approvalDigest); expect(existsSync(output)).toBe(false);
  expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([{ path: output, scope: 'file', maximumBytes: 0 }]);
});
it('requires fresh approval after SIGKILL during a held review and retains the independent authority identity', async () => {
  const n = await fixture(), child = fork(new URL('./fixtures/storage-adoption-review.ts', import.meta.url), [JSON.stringify(n.options)],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const received = once(child, 'message'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  let old: string;
  try { old = (await Promise.race([received, exited.then(() => { throw new Error('Review child exited before approval'); })]))[0] as string; }
  finally { clearTimeout(timer); }
  expect(n.open).toThrow(/already open/); child.kill('SIGKILL'); expect((await exited)[1]).toBe('SIGKILL');
  const resumed = await n.prepare(); expect(resumed.review().approvalDigest).not.toBe(old);
  expect(() => resumed.apply(old)).toThrow(/differs/); expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
  const fresh = await n.prepare(); fresh.apply(fresh.review().approvalDigest);
  const opened = n.open(); expect(opened.status().authorityId).toBe(n.options.authorityId); opened.close();
}, 15000);

it('refuses stale approval after even an unsuccessful competing runtime claim changes control-directory metadata', async () => {
  const n = await fixture(), prepared = await n.prepare(), review = prepared.review();
  expect(() => acquireStoppedRelayMaintenance(n.options.runtimeDirectory)).toThrow(/already open/);
  expect(() => prepared.apply(review.approvalDigest)).toThrow(/approval changed/);
  expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
  const fresh = await n.prepare(); fresh.apply(fresh.review().approvalDigest);
  expect(readFileSync(n.retained, 'utf8')).toBe('preserve old and interrupted work');
});

it('contains automatic cleanup failure, retains damaged ownership and releases the independent ledger claim', async () => {
  const n = await fixture(), controller = new AbortController(), prepared = await n.prepare({ ...n.options, signal: controller.signal });
  const lock = join(n.options.runtimeDirectory, 'relay-runtime.lock'), damaged = 'x'.repeat(4097); writeFileSync(lock, damaged);
  expect(() => controller.abort()).not.toThrow(); expect(() => prepared.review()).toThrow(/cleanup failed/);
  expect(readFileSync(lock, 'utf8')).toBe(damaged);
  const opened = n.open(); opened.close(); expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
});
it('validates target shapes before charging control headroom', async () => {
  const n = await fixture(), before = readFileSync(n.primary);
  await expect(n.prepare({ ...n.options, targets: [{ path: 'relative', scope: 'directory' }] })).rejects.toThrow(/Invalid stopped storage target/);
  expect(readFileSync(n.primary)).toEqual(before);
});

it('closes an apply attempt even when its initial authority check detects external metadata changes', async () => {
  const n = await fixture(), prepared = await n.prepare(), review = prepared.review();
  writeFileSync(n.primary, Buffer.concat([readFileSync(n.primary), Buffer.from('\n')]));
  expect(() => prepared.apply(review.approvalDigest)).toThrow(/metadata changed/);
  expect(() => prepared.review()).toThrow(/closed/); const opened = n.open(); opened.close();
  expect(JSON.parse(readFileSync(n.primary, 'utf8')).adoptions).toEqual([]);
});
