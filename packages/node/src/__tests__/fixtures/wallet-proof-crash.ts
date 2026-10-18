/** Actual process death after completed proof progress and before profile activation. */
import fs from 'node:fs';
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
fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
  if (String(target).endsWith('admission-profile.json')) {
    const marker = fs.openSync(input.marker, 'wx', 0o600);
    try { fs.writeSync(marker, 'before-profile-activation'); fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
    process.kill(process.pid, 'SIGKILL');
  }
  return rename(source, target);
}) as typeof fs.renameSync;
syncBuiltinESMExports();
await wallet.appendPolicyProof({ advance: input.advance, pages: [] });
throw new Error('Expected process death before profile activation');
