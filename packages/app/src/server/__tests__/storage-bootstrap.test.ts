import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { beginRelayMaintenance, readRelayMaintenance } from '@resonance/relay';
import { openDesktopStorageBootstrapReview, DESKTOP_STORAGE_BOOTSTRAP_MINIMUM_BYTES as MINIMUM } from '../relay-storage-bootstrap.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-storage-bootstrap-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'relay-data'); beginRelayMaintenance(runtime); writeFileSync(join(runtime, 'unknown-retained'), 'accepted history');
  const holder = createServer(); holder.listen(0, '127.0.0.1'); await once(holder, 'listening');
  const port = (holder.address() as { port: number }).port; await new Promise<void>(resolve => holder.close(() => resolve()));
  const options = { dataDirectory: directory, runtimePort: port, limitBytes: MINIMUM, mode: 'new' as const };
  const recovery = { dataDirectory: directory, runtimePort: port, mode: 'recover' as const };
  const ledger = join(directory, 'relay-storage-budget'), bootstrap = join(directory, 'relay-storage-bootstrap');
  const review = async (input = options) => { const handle = await openDesktopStorageBootstrapReview(input); cleanup.push(handle.close); return handle; };
  const recover = async () => { const handle = await openDesktopStorageBootstrapReview(recovery); cleanup.push(handle.close); return handle; };
  return { directory, runtime, port, options, recovery, ledger, bootstrap, review, recover };
}
it('retains its independent pin, funds controls and preserves existing work at the exact initial budget', async () => {
  const n = await fixture(), h = await n.review(), original = h.review(), changed = h.review(); changed.intent.authorityId = '0'.repeat(32);
  expect(() => acquireLocalStateLock(join(n.directory, 'relay-desktop-control'))).toThrow(/already open/);
  // A competing lock recovery can change parent metadata; restart the review.
  h.close(); const fresh = await n.review(), reviewed = fresh.review();
  expect(existsSync(n.bootstrap)).toBe(false); expect(existsSync(n.ledger)).toBe(false);
  const result = fresh.apply(reviewed.approvalDigest);
  expect(result).toMatchObject({ authorityId: reviewed.intent.authorityId, availableBytes: 0, activationReady: false, maintenanceActive: true, adoptedSelections: 0 });
  expect(result.authorityId).not.toBe(original.intent.authorityId);
  expect(JSON.parse(readFileSync(join(n.bootstrap, 'intent.json'), 'utf8')).authorityId).toBe(result.authorityId);
  expect(readFileSync(join(n.runtime, 'unknown-retained'), 'utf8')).toBe('accepted history'); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
  await expect(n.review()).rejects.toThrow(/already exists/);
  const restored = await n.recover(); expect(restored.apply(restored.review().approvalDigest)).toMatchObject({ authorityId: result.authorityId, availableBytes: 0 });
});
it.each(['wrong-approval', 'changed-parent', 'cancelled'] as const)('refuses %s before creating any bootstrap output', async boundary => {
  const n = await fixture(), controller = new AbortController(), h = await n.review({ ...n.options, signal: controller.signal } as typeof n.options), review = h.review();
  if (boundary === 'changed-parent') writeFileSync(join(n.directory, 'other'), 'changed');
  if (boundary === 'cancelled') controller.abort();
  expect(() => h.apply(boundary === 'wrong-approval' ? '0'.repeat(64) : review.approvalDigest)).toThrow();
  expect(existsSync(n.bootstrap)).toBe(false); expect(existsSync(n.ledger)).toBe(false);
  const release = acquireLocalStateLock(join(n.directory, 'relay-desktop-control')); release();
  expect(readRelayMaintenance(n.runtime)).not.toBeNull();
});
it('expires an abandoned review and releases both owners while retaining maintenance', async () => {
  const n = await fixture(), h = await openDesktopStorageBootstrapReview({ ...n.options, approvalTimeoutMs: 100 }); cleanup.push(h.close);
  await new Promise(resolve => setTimeout(resolve, 150)); expect(() => h.review()).toThrow(/closed|expired/);
  const replacement = await n.review(); replacement.close(); expect(existsSync(n.bootstrap)).toBe(false); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
});
it('requires maintenance, a closed listener and the full control budget before creating intent', async () => {
  const n = await fixture();
  await expect(openDesktopStorageBootstrapReview({ ...n.options, limitBytes: MINIMUM - 1 })).rejects.toThrow(/Invalid/);
  const holder = createServer(); holder.listen(n.port, '127.0.0.1'); await once(holder, 'listening');
  try { await expect(n.review()).rejects.toThrow(/listener/); } finally { await new Promise<void>(resolve => holder.close(() => resolve())); }
  rmSync(join(n.runtime, 'relay-maintenance.json')); await expect(n.review()).rejects.toThrow(/maintenance/);
  expect(existsSync(n.bootstrap)).toBe(false); expect(existsSync(n.ledger)).toBe(false);
});
it.each(['before', 'after'] as const)('recovers only a published primary after an initial %s-rename failure', async boundary => {
  const n = await fixture(), h = await n.review(), approved = h.review(), primary = join(n.ledger, 'reservations.json');
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to) === primary) { if (boundary === 'after') actual.renameSync(from, to); throw new Error('injected initial publication failure'); }
    actual.renameSync(from, to);
  });
  expect(() => h.apply(approved.approvalDigest)).toThrow(/injected/); vi.mocked(renameSync).mockImplementation(actual.renameSync);
  expect(existsSync(join(n.bootstrap, 'intent.json'))).toBe(true); expect(existsSync(join(n.bootstrap, 'attempt.json'))).toBe(true);
  const recover = await n.recover();
  if (boundary === 'before') {
    expect(() => recover.apply(recover.review().approvalDigest)).toThrow(); expect(existsSync(primary)).toBe(false);
    expect(existsSync(`${primary}.next`)).toBe(true);
  } else expect(recover.apply(recover.review().approvalDigest)).toMatchObject({ authorityId: approved.intent.authorityId, availableBytes: 0 });
});
it.each(['missing-primary', 'wrong-pin', 'partial-intent', 'linked-intent', 'extra-file', 'changed-port'] as const)('refuses %s without resetting the authority', async damage => {
  const n = await fixture(), h = await n.review(); h.apply(h.review().approvalDigest);
  const intent = join(n.bootstrap, 'intent.json'), primary = join(n.ledger, 'reservations.json'), before = readFileSync(primary);
  if (damage === 'missing-primary') rmSync(primary);
  if (damage === 'wrong-pin') { const record = JSON.parse(before.toString()); record.authorityId = 'f'.repeat(32); writeFileSync(primary, JSON.stringify(record)); }
  if (damage === 'partial-intent') writeFileSync(intent, '{private');
  if (damage === 'linked-intent') linkSync(intent, join(n.directory, 'alias'));
  if (damage === 'extra-file') writeFileSync(join(n.bootstrap, 'unexpected'), 'retain');
  const modified = existsSync(primary) ? readFileSync(primary) : undefined;
  await expect((async () => {
    const recover = await openDesktopStorageBootstrapReview({ ...n.recovery, runtimePort: damage === 'changed-port' ? (n.port === 65535 ? 65534 : n.port + 1) : n.port }); cleanup.push(recover.close);
    recover.apply(recover.review().approvalDigest);
  })()).rejects.toThrow();
  expect(existsSync(primary) ? readFileSync(primary) : undefined).toEqual(modified);
  expect(readFileSync(join(n.runtime, 'unknown-retained'), 'utf8')).toBe('accepted history');
});
it('never resets later allocations or the revised limit when recovering the initial intent', async () => {
  const n = await fixture(), h = await n.review(), ready = h.apply(h.review().approvalDigest);
  const authority = openStorageReservationAuthority({ directory: n.ledger, authorityId: ready.authorityId, mode: 'open-existing' });
  const limit = authority.reviewLimit(MINIMUM + 4096); authority.applyLimit(limit.limitBytes, limit.approvalDigest);
  authority.reserve({ path: join(n.runtime, 'retained-output'), scope: 'file', component: 'retained-test', maximumBytes: 4096 }); authority.close();
  const before = readFileSync(join(n.ledger, 'reservations.json')), recover = await n.recover();
  expect(recover.apply(recover.review().approvalDigest)).toMatchObject({ limitBytes: MINIMUM + 4096, availableBytes: 0 });
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
});
it.skipIf(process.platform === 'win32').each(['directory', 'intent', 'attempt', 'before-primary', 'after-primary', 'funded'] as const)(
  'preserves its creation fence and independent pin after SIGKILL at %s', async boundary => {
    const n = await fixture();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-bootstrap-crash.ts', import.meta.url)), JSON.stringify(n.options), boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
    let output = ''; child.stderr!.on('data', chunk => { output += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { expect(await once(child, 'exit'), output).toEqual([null, 'SIGKILL']); } finally { clearTimeout(timer); }
    expect(output).toBe(''); await expect(n.review()).rejects.toThrow(/already exists/);
    if (boundary === 'directory') await expect(n.recover()).rejects.toThrow();
    else {
      const pin = JSON.parse(readFileSync(join(n.bootstrap, 'intent.json'), 'utf8')).authorityId;
      const recover = await n.recover();
      if (['attempt', 'before-primary'].includes(boundary)) expect(() => recover.apply(recover.review().approvalDigest)).toThrow();
      else expect(recover.apply(recover.review().approvalDigest)).toMatchObject({ authorityId: pin, availableBytes: 0 });
    }
    expect(readFileSync(join(n.runtime, 'unknown-retained'), 'utf8')).toBe('accepted history'); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
  }, 15000);
