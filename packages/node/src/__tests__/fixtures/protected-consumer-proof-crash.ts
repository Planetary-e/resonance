/** Actual process-death boundaries for protected proof intent and local policy mirroring. */
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openProtectedAdmissionIssuerLedger } from '../../protected-admission-issuer-ledger.js';
import { createConfiguredAdmissionVerifier } from '../../../../relay/src/configured-admission-verifier.js';
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const funding = openStorageReservationAuthority({ directory: input.authorityDirectory, mode: 'open-existing', authorityId: input.authorityId });
const protection = { ...input.protection, signingKey: { publicKey: Buffer.from(input.protection.signingKey.publicKey, 'base64'), secretKey: Buffer.from(input.protection.signingKey.secretKey, 'base64') } };
const run = <T>(work: () => T): T => withStorageReservationAuthority(funding, work);
function die() {
  const marker = fs.openSync(input.marker, 'wx', 0o600);
  try { fs.writeSync(marker, input.stage); fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
  process.kill(process.pid, 'SIGKILL');
}
function intercept(targetName: string, after = false) {
  const rename = fs.renameSync;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (basename(String(target)) !== targetName) return rename(source, target);
    if (!after) die();
    rename(source, target); die();
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
}
if (input.stage === 'before-policy-mirror') {
  intercept('admission-community-policy.json');
  await run(() => createConfiguredAdmissionVerifier({ directory: input.directory, encryptionKey: Buffer.from(input.encryptionKey, 'hex'), authority: input.authority,
    policy: input.policy, now: () => input.now, historyProtection: protection }));
} else {
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(input.privateKey, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  const issuer = await run(() => openProtectedAdmissionIssuerLedger({ path: input.path, expectedProfile: input.profile, privateKey, expectedAllocationAuthority: input.authority, now: () => input.now, protection }));
  await issuer.ready();
  intercept('issuer.json', input.stage === 'after-intent');
  await issuer.installPolicy(input.policy, input.authority, { advance: input.advance, pages: input.pages.map((page: { digest: string; data: string }) => ({ digest: page.digest, bytes: Buffer.from(page.data, 'base64url') })) });
}
throw new Error('Expected process death at the selected protected proof boundary');
