/** Offline reviewed issuance allocations with an explicitly initialized durable authority journal. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { admissionIssuanceAllocationDigest, MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES } from '@resonance/core/admission-issuance-allocation';
import { openAdmissionAllocationAuthority, reviewAdmissionAllocationPlan } from '../packages/node/src/admission-allocation-authority.js';

function read(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Allocation input must be a regular file within its size limit');
    const bytes = Buffer.alloc(maximum + 1); let used = 0;
    try {
      while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
      if (used > maximum) throw new Error('Allocation input exceeds its size limit');
      try { return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, used)); }
      catch { throw new Error('Allocation input is not valid UTF-8'); }
    } finally { bytes.fill(0); }
  } finally { closeSync(fd); }
}
function json(path: string, maximum = MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES): unknown {
  try { return JSON.parse(read(path, maximum)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Allocation input is not valid JSON'); throw error; }
}
function privateKey(path: string, authority: string): Buffer {
  const value = json(path, 4096) as { publicKey?: unknown; secretKey?: unknown };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'publicKey,secretKey'
    || value.publicKey !== authority || typeof value.secretKey !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.secretKey)) throw new Error('Authority private key does not match the pinned authority');
  const secret = Buffer.from(value.secretKey, 'base64url');
  try { if (secret.length !== 64 || secret.toString('base64url') !== value.secretKey) throw new Error('Invalid authority private key encoding'); return secret; }
  catch (error) { secret.fill(0); throw error; }
  finally { value.secretKey = ''; }
}
function writeExclusive(path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES) throw new Error('Allocation output exceeds its size limit');
  const fd = openSync(path, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (!count) throw new Error('Allocation output write failed'); offset += count; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (process.platform !== 'win32') { const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
}

try {
  if (process.env.RESONANCE_RELAY_STORAGE_SELECTION_FILE) throw new Error('Offline authority tools require separately prepared files outside the relay storage budget');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'review' && args.length === 2) {
    const [publicPath, planPath] = args, authority = read(publicPath, 256).trim();
    const reviewed = await reviewAdmissionAllocationPlan(json(planPath), authority);
    console.log(JSON.stringify({ result: 'allocation-plan-reviewed', authority, ...reviewed,
      allocatedTokens: reviewed.body.allocations.reduce((total, entry) => total + entry.batchSize * entry.maxPermits, 0) }, null, 2));
  } else if ((command === 'init' && args.length === 3) || (command === 'sign' && args.length === 7 && args[0] === '--approve')
    || (command === 'reexport' && args.length === 5)) {
    const operation = command === 'sign' ? args.slice(2) : args;
    const [publicPath, privatePath, journalPath, planOrEpoch, outputPath] = operation;
    const authority = read(publicPath, 256).trim(), secret = privateKey(privatePath, authority);
    let journal: Awaited<ReturnType<typeof openAdmissionAllocationAuthority>> | undefined;
    try {
      journal = await openAdmissionAllocationAuthority({ path: journalPath, authority, secretKey: secret, mode: command === 'init' ? 'create-new' : 'open-existing' });
      if (command === 'init') console.log(JSON.stringify({ result: 'allocation-journal-initialized', authority }));
      else {
        const manifest = command === 'sign' ? await journal.sign(json(planOrEpoch), args[1]) : journal.current('public', planOrEpoch);
        if (!manifest) throw new Error('No signed allocation retained for this epoch');
        writeExclusive(outputPath, manifest);
        console.log(JSON.stringify({ result: 'signed-allocation-saved', epoch: manifest.epoch, allocationDigest: admissionIssuanceAllocationDigest(manifest) }));
      }
    } finally { journal?.close(); secret.fill(0); }
  } else throw new Error('Invalid allocation command or missing explicit plan approval');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Allocation operation failed');
  console.error('Usage: node --import tsx scripts/admission-allocation.ts');
  console.error('  init authority.pub authority-private.json journal.json');
  console.error('  review authority.pub plan.json');
  console.error('  sign --approve <approval-digest> authority.pub authority-private.json journal.json plan.json signed.json');
  console.error('  reexport authority.pub authority-private.json journal.json <epoch> signed.json');
  process.exitCode = 1;
}
