import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireLocalDirectoryOwnership, inspectLocalStateOwnership } from '../local-state-owner.js';
import { acquireLegacyLocalStateLock } from './fixtures/legacy-local-state-lock.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'local-owner-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json'), payload = join(directory, 'accepted.json');
  writeFileSync(payload, JSON.stringify({ count: 0, active: null })); return { directory, path, payload };
}
async function child() {
  const process_ = fork(new URL('./fixtures/local-directory-owner.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(process_, 'exit'), messages: unknown[] = []; process_.on('message', value => messages.push(value));
  cleanup.push(async () => { if (process_.exitCode === null && process_.signalCode === null) process_.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(process_, 'message'), exited.then(() => { throw new Error('Owner child exited before ready'); })]))[0]).toBe('ready');
  return { process: process_, exited, messages };
}

it.each(['recovery-candidate', 'before-recovery-publication', 'after-recovery-publication', 'lock-candidate',
  'before-lock-publication', 'after-lock-publication', 'recovery-marker-removed', 'held', 'lock-marker-removed', 'lock-container-removed'] as const)(
  'recovers directory ownership after real process death at %s with no partial PID publication', async boundary => {
    const n = fixture(), c = await child(), before = readFileSync(n.payload);
    const marker = join(n.directory, 'boundary.txt'); c.process.send({ ...n, boundary, marker }); await c.exited;
    expect(c.messages).toEqual(['ready']); expect(readFileSync(marker, 'utf8')).toBe(boundary); rmSync(marker);
    if (process.platform === 'win32') expect(c.process.exitCode === null || c.process.exitCode !== 0).toBe(true);
    else expect(c.process.signalCode).toBe('SIGKILL');
    const release = acquireLocalDirectoryOwnership(n.path);
    expect(lstatSync(`${n.path}.lock`).isDirectory()).toBe(true);
    expect(inspectLocalStateOwnership(`${n.path}.lock`).directories).toHaveLength(2);
    expect(() => acquireLocalDirectoryOwnership(n.path)).toThrow('already open');
    expect(readFileSync(n.payload)).toEqual(before); release(); release();
    expect(readdirSync(n.directory)).toEqual(['accepted.json']);
  }, 15000);

it('excludes an alive legacy file owner, reclaims only its proven death, and makes legacy code refuse a new owner', async () => {
  const n = fixture(), c = await child(), held = once(c.process, 'message'); c.process.send({ ...n, mode: 'legacy' });
  expect((await held)[0]).toBe('held'); const before = readFileSync(`${n.path}.lock`);
  expect(() => acquireLocalDirectoryOwnership(n.path)).toThrow('already open'); expect(readFileSync(`${n.path}.lock`)).toEqual(before);
  c.process.kill('SIGKILL'); await c.exited;
  const release = acquireLocalDirectoryOwnership(n.path); cleanup.push(release);
  expect(() => acquireLegacyLocalStateLock(n.path)).toThrow(); expect(lstatSync(`${n.path}.lock`).isDirectory()).toBe(true);
  release(); expect(readdirSync(n.directory)).toEqual(['accepted.json']);
}, 15000);

it.each(['lock', 'recovery'] as const)('preserves an old incomplete %s file instead of guessing who created it', side => {
  const n = fixture(), path = `${n.path}.${side}`; writeFileSync(path, '');
  expect(() => acquireLocalDirectoryOwnership(n.path)).toThrow(/inspect/); expect(readFileSync(path)).toHaveLength(0);
});

it('refuses unexpected ownership data and aliases without deleting them', () => {
  const n = fixture(), lock = `${n.path}.lock`; mkdirSync(lock); writeFileSync(join(lock, 'keep'), 'accepted elsewhere');
  expect(() => acquireLocalDirectoryOwnership(n.path)).toThrow(); expect(readFileSync(join(lock, 'keep'), 'utf8')).toBe('accepted elsewhere');
  rmSync(lock, { recursive: true }); symlinkSync(n.directory, lock, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => acquireLocalDirectoryOwnership(n.path)).toThrow(); expect(lstatSync(lock).isSymbolicLink()).toBe(true);
});

it('keeps one writer through three contending processes after an owner dies', async () => {
  const n = fixture(), previous = await child(), held = once(previous.process, 'message'); previous.process.send({ ...n, mode: 'hold' });
  expect((await held)[0]).toBe('held'); previous.process.kill('SIGKILL'); await previous.exited;
  const contenders = await Promise.all([child(), child(), child()]);
  for (const c of contenders) c.process.send({ ...n, mode: 'race' });
  await Promise.all(contenders.map(c => c.exited));
  for (const c of contenders) {
    expect(c.process.exitCode, JSON.stringify({ signal: c.process.signalCode, messages: c.messages })).toBe(0);
    expect(c.messages).toEqual(['ready', 'done']);
  }
  expect(JSON.parse(readFileSync(n.payload, 'utf8'))).toEqual({ count: 36, active: null });
  expect(existsSync(`${n.path}.lock`)).toBe(false); expect(readdirSync(n.directory)).toEqual(['accepted.json']);
}, 20000);

it('returns the acquired lock when the next recovery owner releases between nonempty removal and inspection', () => {
  const n = fixture(), recovery = `${n.path}.recovery`, rmdir = fs.rmdirSync;
  let interleaved = false;
  vi.spyOn(fs, 'rmdirSync').mockImplementation(((...args: Parameters<typeof fs.rmdirSync>) => {
    if (String(args[0]) !== recovery || interleaved) return Reflect.apply(rmdir, fs, args);
    interleaved = true;
    expect(readdirSync(recovery)).toEqual([]); // Our marker has already gone.
    const other = join(recovery, `owner-${process.pid}-${'b'.repeat(32)}`);
    mkdirSync(other);
    let nonempty: unknown;
    try { Reflect.apply(rmdir, fs, args); } catch (error) { nonempty = error; }
    expect((nonempty as NodeJS.ErrnoException)?.code).toMatch(/^(ENOTEMPTY|EEXIST)$/);
    // The next recovery owner sees our live lock and releases its own claim
    // before our post-ENOTEMPTY inspection can look at the recovery container.
    rmdir(other); rmdir(recovery); throw nonempty;
  }) as typeof fs.rmdirSync);
  syncBuiltinESMExports();
  const release = acquireLocalDirectoryOwnership(n.path); cleanup.push(release);
  expect(interleaved).toBe(true);
  expect(() => acquireLocalDirectoryOwnership(n.path)).toThrow('already open');
  release(); expect(readdirSync(n.directory)).toEqual(['accepted.json']);
});

it('reports bounded child failure metadata without paths, payload contents or stacks', async () => {
  const n = fixture(), c = await child();
  c.process.send({ ...n, mode: 'race', payload: join(n.directory, 'missing-payload') }); await c.exited;
  expect(c.process.exitCode).toBe(1);
  expect(c.messages).toEqual(['ready', {
    type: 'owner-child-failure', mode: 'race', stage: 'payload-read', turn: 0, attempts: 1, completedTurns: 0,
    failure: { reason: 'system', code: 'ENOENT', syscall: 'open' }, acquisitionFailures: [], otherAcquisitionFailures: 0,
  }]);
  const report = JSON.stringify(c.messages[1]);
  expect(report.length).toBeLessThan(2048); expect(report).not.toContain(n.directory); expect(report).not.toContain('stack');
  expect(JSON.parse(readFileSync(n.payload, 'utf8'))).toEqual({ count: 0, active: null });
  expect(readdirSync(n.directory)).toEqual(['accepted.json']);
});

it.each(['missing-marker', 'live-successor', 'unexpected-content', 'inspection-denied'] as const)(
  'handles the recovery release inspection boundary with %s', boundary => {
    const n = fixture(), recovery = `${n.path}.recovery`, name = `owner-${process.pid}-${'c'.repeat(32)}`;
    const other = join(recovery, name), rmdir = fs.rmdirSync, lstat = fs.lstatSync, before = readFileSync(n.payload);
    let interleaved = false, inspecting = false, removedMarker = false;
    vi.spyOn(fs, 'rmdirSync').mockImplementation(((...args: Parameters<typeof fs.rmdirSync>) => {
      if (String(args[0]) !== recovery || interleaved) return Reflect.apply(rmdir, fs, args);
      interleaved = true; expect(readdirSync(recovery)).toEqual([]);
      if (boundary === 'unexpected-content') writeFileSync(join(recovery, 'keep'), 'accepted elsewhere');
      else mkdirSync(other);
      try { return Reflect.apply(rmdir, fs, args); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toMatch(/^(ENOTEMPTY|EEXIST)$/); inspecting = true; throw error; }
    }) as typeof fs.rmdirSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (inspecting && String(args[0]) === recovery && boundary === 'inspection-denied') {
        throw Object.assign(new Error('Inspection denied'), { code: 'EPERM', syscall: 'lstat' });
      }
      if (inspecting && String(args[0]) === other && boundary === 'missing-marker' && !removedMarker) {
        removedMarker = true; rmdir(other);
      }
      return Reflect.apply(lstat, fs, args);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    if (boundary === 'unexpected-content' || boundary === 'inspection-denied') {
      let failure: unknown;
      try { acquireLocalDirectoryOwnership(n.path); } catch (error) { failure = error; }
      if (boundary === 'unexpected-content') {
        expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe('Invalid local ownership marker');
        expect(readFileSync(join(recovery, 'keep'), 'utf8')).toBe('accepted elsewhere');
      } else {
        expect(failure).toMatchObject({ code: 'EPERM', syscall: 'lstat' });
        expect(readdirSync(recovery)).toEqual([name]); expect(readdirSync(other)).toEqual([]);
      }
      // Unsafe inspection errors preserve the already-published lock and all
      // successor metadata; this test fixture alone removes them in cleanup.
      expect(lstatSync(`${n.path}.lock`).isDirectory()).toBe(true);
    } else {
      const release = acquireLocalDirectoryOwnership(n.path); cleanup.push(release);
      if (boundary === 'missing-marker') { expect(removedMarker).toBe(true); expect(readdirSync(recovery)).toEqual([]); }
      else { expect(inspectLocalStateOwnership(recovery).directories).toEqual([recovery, other]); }
      release();
      if (boundary === 'live-successor') { expect(readdirSync(recovery)).toEqual([name]); rmdir(other); }
      rmdir(recovery); expect(readdirSync(n.directory)).toEqual(['accepted.json']);
    }
    expect(interleaved).toBe(true); expect(readFileSync(n.payload)).toEqual(before);
  });
