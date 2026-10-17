import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { preparePolicyObserverRestore, POLICY_OBSERVER_RESTORATION_FILENAME } from '../../policy-observer-history-restore.js';
import { openProtectedPolicyObserver } from '../../protected-policy-observer.js';

process.once('message', async (input: any) => {
  try {
    fs.mkdirSync(input.openOptions.directory, { recursive: true });
    const directory = fs.realpathSync(input.openOptions.directory);
    const preparation = await preparePolicyObserverRestore({ ...input.restoreOptions, directory });
    const rename = fs.renameSync; let writer = 0, archive = 0;
    const stop = (phase: string) => {
      if (input.boundary !== phase) return;
      fs.writeFileSync(input.marker, phase); process.kill(process.pid, 'SIGKILL');
    };
    fs.renameSync = (from, to) => {
      const file = basename(String(to));
      if (file === POLICY_OBSERVER_RESTORATION_FILENAME) stop('before-baseline');
      rename(from, to);
      if (file === POLICY_OBSERVER_RESTORATION_FILENAME) stop('after-baseline');
      else if (file === 'history-writer.json') stop(['after-writer', 'after-root-intent', 'after-root-certificate'][writer++]);
      else if (file === 'history-writer-payloads.json') stop(['after-archive', 'after-root-index'][archive++]);
    };
    syncBuiltinESMExports();
    const observer = await openProtectedPolicyObserver({ ...input.openOptions, directory, now: () => input.now, mode: 'create-new',
      restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
    try { await observer.ready(); }
    catch (error) { if (!input.blocked || !String(error).includes('equivocated')) throw error; }
    stop('durable');
    process.send!({ error: 'Expected interruption not reached' }, () => process.exit(2));
  } catch (error) { process.send!({ error: String(error) }, () => process.exit(1)); }
});
process.send!('ready');
