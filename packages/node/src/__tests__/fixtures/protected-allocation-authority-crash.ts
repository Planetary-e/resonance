import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openProtectedAdmissionAllocationAuthority } from '../../protected-admission-allocation-authority.js';

process.once('message', async (input: any) => {
  let journal: Awaited<ReturnType<typeof openProtectedAdmissionAllocationAuthority>> | undefined;
  try {
    journal = await openProtectedAdmissionAllocationAuthority({ ...input.options, now: () => 150 }); await journal.ready();
    const original = fs.renameSync; let calls = 0;
    const stop = () => { fs.writeFileSync(input.marker, input.boundary); process.kill(process.pid, 'SIGKILL'); };
    fs.renameSync = (from, to) => {
      const selected = String(to) === input.target && ++calls === input.nth;
      if (selected && input.before) stop(); original(from, to); if (selected && !input.before) stop();
    };
    syncBuiltinESMExports();
    if (input.operation === 'plan') { const review = await journal.review(input.value); await journal.sign(input.value, review.approvalDigest); }
    else { const review = await journal.reviewAssignment(input.value); await journal.assignClaim(input.value, review.approvalDigest); }
    process.send?.({ error: 'Expected interruption not reached' }); process.exitCode = 2;
  } catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
  finally { journal?.close(); process.disconnect?.(); }
});
process.send?.('ready');
