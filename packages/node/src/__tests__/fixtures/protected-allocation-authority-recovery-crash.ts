import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openProtectedAdmissionAllocationAuthority } from '../../protected-admission-allocation-authority.js';
import { openProtectedAllocationAuthorityRecovery, prepareProtectedAllocationAuthorityRecovery } from '../../admission-allocation-authority-recovery.js';
process.once('message', async (input: any) => {
  let owner: Awaited<ReturnType<typeof openProtectedAdmissionAllocationAuthority>> | undefined;
  let recovery: Awaited<ReturnType<typeof openProtectedAllocationAuthorityRecovery>> | undefined;
  try {
    const authorityOptions = { ...input.authorityOptions, now: () => input.now };
    let review: Awaited<ReturnType<typeof prepareProtectedAllocationAuthorityRecovery>> | undefined;
    if (input.mode === 'start') { owner = await openProtectedAdmissionAllocationAuthority(authorityOptions);
      review = await prepareProtectedAllocationAuthorityRecovery({ ...input.recoveryOptions, source: await owner.reviewRecoverySource() }); }
    const original = fs.renameSync; let calls = 0;
    const stop = () => { fs.writeFileSync(input.marker, input.boundary); process.kill(process.pid, 'SIGKILL'); };
    fs.renameSync = (from, to) => { const target = String(to) === input.target && ++calls === input.nth;
      if (target && input.before) stop(); original(from, to); if (target && !input.before) stop(); };
    syncBuiltinESMExports();
    recovery = await openProtectedAllocationAuthorityRecovery({ ...input.recoveryOptions,
      ...(review ? { initialize: { review, approvedDigest: review.approvalDigest } } : {}) });
    if (input.mode === 'advance') await recovery.advance({ maxBlocks: 10001 });
    if (input.mode === 'restore') { const { preparation } = await recovery.reviewRestore(input.destination);
      owner = await openProtectedAdmissionAllocationAuthority({ ...authorityOptions, path: input.destination.path, mode: 'create-new',
        protection: { ...authorityOptions.protection, writerDirectory: input.destination.writerDirectory }, restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); }
    process.send?.({ error: 'Expected interruption not reached' }); process.exitCode = 2;
  } catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
  finally { recovery?.close(); owner?.close(); process.disconnect?.(); }
});
process.send?.('ready');
