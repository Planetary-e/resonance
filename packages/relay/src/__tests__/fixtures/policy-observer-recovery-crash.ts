import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openPolicyObserverRecovery, preparePolicyObserverRecovery, POLICY_OBSERVER_RECOVERY_FILENAME } from '../../policy-observer-recovery.js';
import { openProtectedPolicyObserver, POLICY_OBSERVER_RECOVERY_FENCE } from '../../protected-policy-observer.js';

process.once('message', async (input: any) => {
  try {
    const original = fs.renameSync, boundary = input.boundary as string;
    const setup = boundary.includes('fence') || boundary.includes('workspace');
    const observerDirectory = fs.realpathSync(input.observerOptions.directory);
    const directory = join(fs.realpathSync(join(input.recoveryOptions.directory, '..')), input.recoveryOptions.directory.split(/[/\\]/).at(-1));
    let owner: Awaited<ReturnType<typeof openProtectedPolicyObserver>> | undefined;
    let review: Awaited<ReturnType<typeof preparePolicyObserverRecovery>> | undefined;
    if (setup) {
      owner = await openProtectedPolicyObserver({ ...input.observerOptions, directory: observerDirectory, now: () => input.now, mode: 'open-existing' });
      review = await preparePolicyObserverRecovery({ ...input.recoveryOptions, directory, source: owner.reviewRecoverySource() });
    }
    const target = boundary.includes('fence') ? join(observerDirectory, POLICY_OBSERVER_RECOVERY_FENCE) : join(directory, POLICY_OBSERVER_RECOVERY_FILENAME);
    const nth = setup || boundary.includes('intent') || boundary === 'after-confirm' ? 1 : boundary.includes('register') ? 2 : 3;
    const before = boundary.startsWith('before-'); let calls = 0;
    fs.renameSync = (from, to) => {
      const stop = String(to) === target && ++calls === nth;
      if (stop && before) process.kill(process.pid, 'SIGKILL');
      original(from, to);
      if (stop && !before) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    const recovery = await openPolicyObserverRecovery({ ...input.recoveryOptions, directory,
      ...(review ? { initialize: { review, approvedDigest: review.approvalDigest } } : {}) });
    if (!setup) await recovery.advance(); recovery.close(); owner?.close();
    process.send?.({ error: 'Expected interruption not reached' }); process.exitCode = 2;
  } catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
  finally { process.disconnect?.(); }
});
process.send?.('ready');
