import fs from 'node:fs';
import { basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { runAdmissionHistoryCommand } from '../../admission-history-command.js';
import { canonicalHistorySetupPath } from '../../admission-history-setup.js';
import { HISTORY_PROVISION_FILENAME } from '../../history-generation-provisioner.js';

process.once('message', async (message: { args: string[]; boundary: string; resume?: boolean }) => {
  try {
    const plan = await runAdmissionHistoryCommand(message.resume ? 'replica-resume-plan' : 'replica-plan', message.args);
    const directory = canonicalHistorySetupPath(message.args[3]), manifest = join(directory, 'genesis', 'history-manifest.json');
    const block = join(directory, 'genesis', `${String(plan.result.genesisId).slice(7)}.block`);
    const rename = fs.renameSync, [when, stage] = message.boundary.split('-'); let writes = 0;
    fs.renameSync = (from, to) => {
      const target = canonicalHistorySetupPath(String(to));
      if (target === manifest) writes++;
      const at = target === manifest ? writes === (message.resume ? 1 : 2) ? 'index' : 'manifest'
        : target === block ? 'block' : basename(target) === HISTORY_PROVISION_FILENAME ? 'slot' : '';
      if (at === stage && when === 'before') process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (at === stage && when === 'after') process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    await runAdmissionHistoryCommand(message.resume ? 'replica-resume' : 'replica-enroll', ['--approve', String(plan.result.approvalDigest), ...message.args]);
    throw new Error('Enrollment interruption boundary was not reached');
  } catch (error) { process.send!({ error: error instanceof Error ? error.message : 'Enrollment crash fixture failed' }); process.exitCode = 1; process.disconnect?.(); }
});
process.send!('ready');
