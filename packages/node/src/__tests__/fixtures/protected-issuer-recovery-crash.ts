import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openProtectedAdmissionIssuerLedger } from '../../protected-admission-issuer-ledger.js';
import { openProtectedIssuerRecovery, prepareProtectedIssuerRecovery } from '../../admission-issuer-recovery.js';

process.once('message', async (input: any) => {
  let issuer: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>> | undefined;
  let recovery: Awaited<ReturnType<typeof openProtectedIssuerRecovery>> | undefined;
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', input.privateKeyBytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
    const issuerOptions = { ...input.issuerOptions, privateKey, now: () => input.now };
    let review: Awaited<ReturnType<typeof prepareProtectedIssuerRecovery>> | undefined;
    if (input.mode === 'start') {
      issuer = await openProtectedAdmissionIssuerLedger(issuerOptions);
      review = await prepareProtectedIssuerRecovery({ ...input.recoveryOptions, source: await issuer.reviewRecoverySource() });
    }
    const original = fs.renameSync; let calls = 0;
    const stop = () => { fs.writeFileSync(input.marker, input.boundary); process.kill(process.pid, 'SIGKILL'); };
    fs.renameSync = (from, to) => {
      const target = String(to) === input.target && ++calls === input.nth;
      if (target && input.before) stop();
      original(from, to);
      if (target && !input.before) stop();
    };
    syncBuiltinESMExports();
    recovery = await openProtectedIssuerRecovery({ ...input.recoveryOptions,
      ...(review ? { initialize: { review, approvedDigest: review.approvalDigest } } : {}) });
    if (input.mode === 'advance') await recovery.advance({ maxBlocks: 10001 });
    if (input.mode === 'restore') {
      const { preparation } = await recovery.reviewRestore(input.destination);
      issuer = await openProtectedAdmissionIssuerLedger({ ...issuerOptions, path: input.destination.path,
        protection: { ...issuerOptions.protection, writerDirectory: input.destination.writerDirectory, initializeWriter: true, initializeArchive: true },
        restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
    }
    process.send?.({ error: 'Expected interruption not reached' }); process.exitCode = 2;
  } catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
  finally { recovery?.close(); issuer?.close(); process.disconnect?.(); }
});
process.send?.('ready');
