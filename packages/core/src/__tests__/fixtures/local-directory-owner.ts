import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { acquireLocalDirectoryOwnership } from '../../local-state-owner.js';
import { acquireLegacyLocalStateLock } from './legacy-local-state-lock.js';

process.once('message', async (input: any) => {
  try {
    if (input.mode === 'race') {
      for (let turn = 0; turn < 12; turn++) {
        let release: (() => void) | undefined;
        const deadline = Date.now() + 15000;
        while (!release) {
          try { release = acquireLocalDirectoryOwnership(input.path); }
          catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 2));
          }
        }
        try {
          const before = JSON.parse(fs.readFileSync(input.payload, 'utf8'));
          if (before.active !== null) throw new Error('Another writer was active');
          fs.writeFileSync(input.payload, JSON.stringify({ count: before.count, active: process.pid }));
          await new Promise(resolve => setTimeout(resolve, 3));
          const held = JSON.parse(fs.readFileSync(input.payload, 'utf8'));
          if (held.active !== process.pid || held.count !== before.count) throw new Error('Another writer entered the claim');
          fs.writeFileSync(input.payload, JSON.stringify({ count: before.count + 1, active: null }));
        } finally { release(); }
      }
      process.send!('done', () => process.exit(0)); return;
    }
    if (input.mode === 'legacy' || input.mode === 'hold') {
      const release = input.mode === 'legacy' ? acquireLegacyLocalStateLock(input.path) : acquireLocalDirectoryOwnership(input.path);
      process.send!('held'); process.once('message', () => { release(); process.exit(0); }); return;
    }
    const mkdir = fs.mkdirSync, rename = fs.renameSync, rmdir = fs.rmdirSync;
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
  } catch (error) { process.send?.({ error: String(error) }); process.exit(1); }
});
process.send!('ready');
