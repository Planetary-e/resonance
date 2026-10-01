/** Offline maintenance of an existing role. Stop its relay before review or retirement. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { openAdmissionPolicyStore, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionWitness, createAdmissionQuorumGate } from '@resonance/relay';

function read(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(maximum + 1);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Maintenance input must be a regular file within its size limit');
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    if (used > maximum) throw new Error('Maintenance input exceeds its size limit');
    return bytes.toString('utf8', 0, used);
  } finally { bytes.fill(0); closeSync(fd); }
}
function privateKey(path: string) {
  let value: { publicKey?: unknown; secretKey?: unknown };
  try { value = JSON.parse(read(path, 4096)); } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Participant private file is not valid JSON');
    throw error;
  }
  if (!value || typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.publicKey)
    || typeof value.secretKey !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.secretKey)) throw new Error('Invalid admission participant key file');
  const key = { publicKey: Buffer.from(value.publicKey, 'base64url'), secretKey: Buffer.from(value.secretKey, 'base64url') };
  value.secretKey = ''; return key;
}

try {
  const [command, ...raw] = process.argv.slice(2);
  const approved = command === 'retire' && raw[0] === '--approve' ? raw[1] : undefined;
  const args = approved ? raw.slice(2) : raw;
  if ((command !== 'plan' && command !== 'retire') || (command === 'retire' && !approved)
    || args.length !== 6 || !['witness','coordinator'].includes(args[0])) throw new Error('Invalid maintenance command or missing explicit approval');
  const [role, directory, authorityPath, storageKeyPath, participantPath, issuerKey] = args;
  const authority = read(authorityPath, 256).trim(), hex = read(storageKeyPath, 128).trim();
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error('Invalid local policy storage key');
  const encryptionKey = Buffer.from(hex, 'hex');
  let participant: ReturnType<typeof privateKey> | undefined;
  let policyStore: Awaited<ReturnType<typeof openAdmissionPolicyStore>> | undefined;
  let history: ReturnType<typeof createAdmissionWitness> | ReturnType<typeof createAdmissionQuorumGate> | undefined;
  try {
    // Read the device's installed, revision-pinned policy. Never import a policy or initialize missing history here.
    policyStore = await openAdmissionPolicyStore({ path: join(directory, 'admission-community-policy.json'), encryptionKey, mode: 'open-existing' });
    const policy = await verifyAdmissionPolicy(policyStore.current(), authority);
    participant = privateKey(participantPath);
    const options = { directory, encryptionKey, policy, signingKey: participant };
    history = role === 'witness' ? createAdmissionWitness(options) : createAdmissionQuorumGate(options);
    const result = command === 'plan' ? history.planRetirement(issuerKey) : history.retire(issuerKey, approved!);
    console.log(JSON.stringify({ ...result, result: command === 'plan' ? 'review-required' : 'permanently-retired' }, null, 2));
  } finally {
    history?.close(); policyStore?.close(); encryptionKey.fill(0); participant?.secretKey.fill(0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Admission history maintenance failed');
  console.error('Usage: node --import tsx scripts/retire-admission-history.ts');
  console.error('  plan <witness|coordinator> <directory> authority.pub local-policy-key.hex participant-private.json <issuer-key-fingerprint>');
  console.error('  retire --approve <review-digest> <witness|coordinator> <directory> authority.pub local-policy-key.hex participant-private.json <issuer-key-fingerprint>');
  process.exitCode = 1;
}
