/** Offline reviewed rotation. Does not install policies, contact peers, or reset histories. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkAdmissionRotation, prepareAdmissionRotation, signAdmissionRotation } from '@resonance/core/admission-rotation';

function read(path: string, maximum = 65536): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Rotation input must be a regular file within its size limit');
    const bytes = Buffer.alloc(maximum + 1); let used = 0;
    try {
      while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
      if (used > maximum) throw new Error('Rotation input exceeds its size limit');
      return bytes.toString('utf8', 0, used);
    } finally { bytes.fill(0); }
  } finally { closeSync(fd); }
}
function json(path: string, maximum = 65536): unknown {
  try { return JSON.parse(read(path, maximum)); }
  catch (error) {
    // JSON parser errors can echo private-key fragments. Never print input contents.
    if (error instanceof SyntaxError) throw new Error('Rotation input is not valid JSON');
    throw error;
  }
}
function writeExclusive(path: string, value: unknown, prettyPlan = false) {
  const output = Buffer.from(JSON.stringify(value, null, prettyPlan ? 2 : undefined) + '\n');
  if (output.length > (prettyPlan ? 131072 : 65536)) throw new Error('Rotation output exceeds its file size limit');
  const fd = openSync(path, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < output.length) { const written = writeSync(fd, output, offset, output.length - offset); if (!written) throw new Error('Rotation output write failed'); offset += written; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 4) {
    const [authorityPath, previousPath, requestPath, outputPath] = args;
    const checked = await prepareAdmissionRotation(json(previousPath), json(requestPath), read(authorityPath, 256).trim());
    writeExclusive(outputPath, checked.plan, true);
    console.log(JSON.stringify({ ...checked.summary, result: 'unsigned-plan-saved' }, null, 2));
  } else if (command === 'check' && args.length === 3) {
    const [authorityPath, previousPath, planPath] = args;
    const checked = await checkAdmissionRotation(json(previousPath), json(planPath, 131072), read(authorityPath, 256).trim());
    console.log(JSON.stringify({ ...checked.summary, result: 'plan-checked' }, null, 2));
  } else if (command === 'sign' && args.length === 7 && args[0] === '--approve') {
    const [, approvedDigest, authorityPath, privatePath, previousPath, planPath, outputPath] = args;
    const authority = read(authorityPath, 256).trim(), previous = json(previousPath), plan = json(planPath, 131072);
    const checked = await checkAdmissionRotation(previous, plan, authority);
    if (approvedDigest !== checked.summary.approvalDigest) throw new Error('Approval digest does not match this rotation plan; review it again');
    const key = json(privatePath, 4096) as { publicKey?: unknown; secretKey?: unknown };
    if (!key || key.publicKey !== authority || typeof key.secretKey !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(key.secretKey)) throw new Error('Authority private key does not match the pinned authority');
    const secret = Buffer.from(key.secretKey, 'base64url'); key.secretKey = '';
    try {
      const signed = await signAdmissionRotation(previous, plan, authority, secret, approvedDigest);
      writeExclusive(outputPath, signed.policy);
      console.log(JSON.stringify({ result: 'signed-policy-saved', approvalDigest: signed.summary.approvalDigest, revision: signed.policy.revision }));
    } finally { secret.fill(0); }
  } else throw new Error('Invalid rotation command or missing explicit plan approval');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Rotation operation failed');
  console.error('Usage: node --import tsx scripts/rotate-admission-policy.ts');
  console.error('  prepare authority.pub previous-policy.json rotation-request.json plan.json');
  console.error('  check authority.pub previous-policy.json plan.json');
  console.error('  sign --approve <approval-digest> authority.pub authority-private.json previous-policy.json plan.json policy.json');
  process.exitCode = 1;
}
