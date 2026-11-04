import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { acquireLocalDirectoryOwnership } from '../../local-state-owner.js';
import { acquireLegacyLocalStateLock } from './legacy-local-state-lock.js';

type Failure = { reason: 'already-open' | 'contended' | 'ownership-layout' | 'overlapping-writers' | 'system' | 'other'; code?: string; syscall?: string };
type Stage = 'acquire' | 'payload-read' | 'payload-mark' | 'payload-wait' | 'payload-check' | 'payload-commit' | 'release' | 'boundary';
const syscalls = new Set(['access', 'close', 'fsync', 'lstat', 'mkdir', 'opendir', 'open', 'read', 'readdir', 'rename', 'rmdir', 'scandir', 'stat', 'unlink', 'write']);
const maximumCount = 1_000_000;
const increment = (value: number) => Math.min(maximumCount, value + 1);
function summarize(error: unknown): Failure {
  const value = error as NodeJS.ErrnoException | undefined;
  const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(value.code) ? value.code : undefined;
  const syscall = typeof value?.syscall === 'string' && syscalls.has(value.syscall) ? value.syscall : undefined;
  const message = error instanceof Error ? error.message : '';
  const reason: Failure['reason'] = code ? 'system' : message === 'Encrypted outbox is already open' ? 'already-open'
    : message.startsWith('Local ownership is contended') ? 'contended'
      : message.startsWith('Local ownership') ? 'ownership-layout'
        : message === 'Another writer was active' || message === 'Another writer entered the claim' ? 'overlapping-writers' : 'other';
  return { reason, ...(code ? { code } : {}), ...(syscall ? { syscall } : {}) };
}

process.once('message', async (input: any) => {
  let stage: Stage = 'acquire';
  let turn = -1, attempts = 0, completedTurns = 0, otherAcquisitionFailures = 0;
  const acquisitionFailures: Array<{ failure: Failure; count: number }> = [];
  const fail = (error: unknown) => {
    // Only enum stages/reasons and bounded OS codes cross IPC. Never include
    // paths, marker nonces, payload contents, arbitrary messages or stacks.
    const detail = { type: 'owner-child-failure', mode: input.mode === 'race' || input.mode === 'hold' || input.mode === 'legacy' ? input.mode : 'boundary',
      stage, turn, attempts, completedTurns, failure: summarize(error), acquisitionFailures, otherAcquisitionFailures };
    if (process.connected && process.send) process.send(detail, () => process.exit(1));
    else process.exit(1);
  };
  try {
    if (input.mode === 'race') {
      for (turn = 0; turn < 12; turn++) {
        let release: (() => void) | undefined;
        const deadline = Date.now() + 15000;
        while (!release) {
          stage = 'acquire'; attempts = increment(attempts);
          try { release = acquireLocalDirectoryOwnership(input.path); }
          catch (error) {
            const failure = summarize(error), existing = acquisitionFailures.find(entry => JSON.stringify(entry.failure) === JSON.stringify(failure));
            if (existing) existing.count = increment(existing.count);
            else if (acquisitionFailures.length < 8) acquisitionFailures.push({ failure, count: 1 });
            else otherAcquisitionFailures = increment(otherAcquisitionFailures);
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 2));
          }
        }
        try {
          stage = 'payload-read';
          const before = JSON.parse(fs.readFileSync(input.payload, 'utf8'));
          if (before.active !== null) throw new Error('Another writer was active');
          stage = 'payload-mark';
          fs.writeFileSync(input.payload, JSON.stringify({ count: before.count, active: process.pid }));
          stage = 'payload-wait';
          await new Promise(resolve => setTimeout(resolve, 3));
          stage = 'payload-check';
          const held = JSON.parse(fs.readFileSync(input.payload, 'utf8'));
          if (held.active !== process.pid || held.count !== before.count) throw new Error('Another writer entered the claim');
          stage = 'payload-commit';
          fs.writeFileSync(input.payload, JSON.stringify({ count: before.count + 1, active: null }));
        } finally {
          const previousStage: Stage = stage; stage = 'release'; release(); stage = previousStage;
        }
        completedTurns++;
      }
      process.send!('done', () => process.exit(0)); return;
    }
    if (input.mode === 'legacy' || input.mode === 'hold') {
      const release = input.mode === 'legacy' ? acquireLegacyLocalStateLock(input.path) : acquireLocalDirectoryOwnership(input.path);
      process.send!('held'); process.once('message', () => { try { stage = 'release'; release(); process.exit(0); } catch (error) { fail(error); } }); return;
    }
    stage = 'boundary'; const mkdir = fs.mkdirSync, rename = fs.renameSync, rmdir = fs.rmdirSync;
    const stop = (boundary: string) => {
      if (input.boundary === boundary) { fs.writeFileSync(input.marker, boundary); process.kill(process.pid, 'SIGKILL'); }
    };
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      const path = String(args[0]).replaceAll('\\', '/'), result = Reflect.apply(mkdir, fs, args);
      if (path.includes('.recovery.claim-') && !path.includes('/owner-')) stop('recovery-candidate');
      if (path.includes('.lock.claim-') && !path.includes('/owner-')) stop('lock-candidate');
      return result;
    }) as typeof fs.mkdirSync;
    fs.renameSync = (from, to) => {
      const recovery = String(to) === `${input.path}.recovery`, lock = String(to) === `${input.path}.lock`;
      if (recovery) stop('before-recovery-publication'); if (lock) stop('before-lock-publication');
      rename(from, to);
      if (recovery) stop('after-recovery-publication'); if (lock) stop('after-lock-publication');
    };
    fs.rmdirSync = ((...args: Parameters<typeof fs.rmdirSync>) => {
      const path = String(args[0]).replaceAll('\\', '/'), result = Reflect.apply(rmdir, fs, args);
      if (path.includes('.recovery/owner-')) stop('recovery-marker-removed');
      if (path.includes('.lock/owner-')) stop('lock-marker-removed');
      if (String(args[0]) === `${input.path}.lock`) stop('lock-container-removed');
      return result;
    }) as typeof fs.rmdirSync;
    syncBuiltinESMExports();
    const release = acquireLocalDirectoryOwnership(input.path); stop('held'); release();
    process.send?.('unexpected-completion'); process.exit(2);
  } catch (error) { fail(error); }
});
process.send!('ready');
