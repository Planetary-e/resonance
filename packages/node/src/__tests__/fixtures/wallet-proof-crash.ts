/** Actual process death after completed proof progress and before profile activation. */
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openManagedAdmissionWallet } from '../../managed-admission-wallet.js';
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const authority = openStorageReservationAuthority({ directory: input.authorityDirectory, mode: 'open-existing', authorityId: input.authorityId });
const wallet = await openManagedAdmissionWallet({ directory: input.directory, encryptionKey: Buffer.from(input.key, 'hex'), now: () => 1010,
  proofStorage: { authority, authorityId: input.authorityId, directory: input.proofDirectory,
    maxCiphertextBytes: input.maxCiphertextBytes, maxRecords: input.maxRecords, limits: input.limits } });
await wallet.beginPolicyProof(input.genesis, input.context);
const rename = fs.renameSync;
function die() {
  const marker = fs.openSync(input.marker, 'wx', 0o600);
  try { fs.writeSync(marker, input.boundary); fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
  process.kill(process.pid, 'SIGKILL');
}
fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
  const catalogue = basename(String(target)).startsWith('catalogue-'), activation = String(target).endsWith('admission-profile.json');
  if ((catalogue && input.boundary === 'before-catalogue') || (activation && input.boundary === 'before-profile-activation')) die();
  const result = rename(source, target);
  if ((catalogue && input.boundary === 'after-catalogue') || (activation && input.boundary === 'after-profile-activation')) die();
  return result;
}) as typeof fs.renameSync;
syncBuiltinESMExports();
await wallet.appendPolicyProof({ advance: input.advance, pages: [] });
throw new Error('Expected process death before profile activation');
