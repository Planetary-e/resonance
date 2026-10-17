import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openProtectedAdmissionSpendHistory } from '../../protected-admission-history.js';
import { openAdmissionRoleCapture } from '../../admission-role-capture.js';

const [file, boundary, marker] = process.argv.slice(2), input = JSON.parse(fs.readFileSync(file, 'utf8'));
const signingKey = { publicKey: Buffer.from(input.owner.publicKey, 'base64url'), secretKey: Buffer.from(input.owner.secretKey, 'base64url') };
const history = await openProtectedAdmissionSpendHistory({ directory: input.directory, encryptionKey: Buffer.from(input.key, 'base64url'),
  authority: input.context.authority, policy: input.policy, now: () => input.time,
  protection: { context: input.context, signingKey, members: input.members, timeoutMs: 3000 } });
const capture = await openAdmissionRoleCapture({ directory: input.directory, encryptionKey: Buffer.from(input.key, 'base64url'), roles: ['witness', 'coordinator'], history });
const review = await capture.review(), rename = fs.renameSync, localDirectory = fs.realpathSync(input.directory); let imageWrites = 0;
function stop(at: string) { if (boundary === at) { fs.writeFileSync(marker, at); process.kill(process.pid, 'SIGKILL'); } }
fs.renameSync = (from, to) => {
  const path = String(to), image = path === join(input.directory, 'admission-spends-v2.jsonl');
  if (image) { imageWrites++; if (imageWrites === 1) stop('before-history-intent'); if (imageWrites === 2) stop('before-history-apply'); }
  rename(from, to);
  if (path === join(localDirectory, 'admission-witness-certificates.json')) stop('after-coordinator-fence');
  if (path === join(localDirectory, 'admission-witness-votes.json')) stop('after-witness-fence');
  if (image && imageWrites === 1) stop('after-history-intent');
  if (image && imageWrites === 2) stop('after-history-apply');
};
syncBuiltinESMExports();
await capture.apply(review.approvalDigest); stop('after-completion'); capture.close(); history.close();
throw new Error('Expected role-capture crash boundary was not reached');
