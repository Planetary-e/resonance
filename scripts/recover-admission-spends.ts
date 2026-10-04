/** Explicit offline recovery of complete legacy rows using expired, cryptographically verified tokens. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { openAdmissionPolicyStore, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { openAdmissionSpendHistory } from '@resonance/relay';

function read(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK), bytes = Buffer.alloc(maximum + 1);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Recovery input must be a regular file within its size limit');
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    if (used > maximum) throw new Error('Recovery input exceeds its size limit');
    return bytes.toString('utf8', 0, used);
  } finally { bytes.fill(0); closeSync(fd); }
}
function proofs(path: string): unknown {
  try { return JSON.parse(read(path, 65536)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Recovery proof file is not valid JSON'); throw error; }
}
try {
  const [command, ...raw] = process.argv.slice(2);
  const approved = command === 'recover' && raw[0] === '--approve' ? raw[1] : undefined;
  const args = approved ? raw.slice(2) : raw;
  if ((command !== 'plan' && command !== 'recover') || (command === 'recover' && !approved) || args.length !== 4) {
    throw new Error('Invalid recovery command or missing explicit approval');
  }
  const [directory, authorityPath, storageKeyPath, proofPath] = args;
  const authority = read(authorityPath, 256).trim(), hex = read(storageKeyPath, 128).trim();
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error('Invalid local policy storage key');
  const encryptionKey = Buffer.from(hex, 'hex');
  let store: Awaited<ReturnType<typeof openAdmissionPolicyStore>> | undefined;
  let history: ReturnType<typeof openAdmissionSpendHistory> | undefined;
  try {
    store = await openAdmissionPolicyStore({ path: join(directory, 'admission-community-policy.json'), encryptionKey, mode: 'open-existing' });
    const policy = await verifyAdmissionPolicy(store.current(), authority);
    history = openAdmissionSpendHistory({ directory, encryptionKey, policy });
    const input = proofs(proofPath);
    const result = command === 'plan' ? await history.planLegacyRecovery(input) : await history.recoverLegacy(input, approved!);
    console.log(JSON.stringify({ ...result, result: command === 'plan' ? 'review-required' : 'legacy-spends-recovered' }, null, 2));
  } finally { history?.close(); store?.close(); encryptionKey.fill(0); }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Legacy spend recovery failed');
  console.error('Usage: node --import tsx scripts/recover-admission-spends.ts');
  console.error('  plan <directory> authority.pub local-policy-key.hex proofs.json');
  console.error('  recover --approve <review-digest> <directory> authority.pub local-policy-key.hex proofs.json');
  process.exitCode = 1;
}
