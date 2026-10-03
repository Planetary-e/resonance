import { MAX_ADMISSION_POLICY_BYTES } from '@resonance/core/admission-policy';
/** Offline community permits and durable batch approval. No account directory or network. */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { openAdmissionIssuerLedger } from '../packages/node/src/admission-issuer-ledger.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  let retirementApproval: string | undefined;
  if (command === 'retire') {
    if (args.shift() !== '--approve' || !/^sha256:[a-f0-9]{64}$/.test(retirementApproval = args.shift() ?? '')) throw new Error('Retirement requires --approve and the reviewed digest');
  }
  if ((command === 'grant' || command === 'issue' || command === 'policy') && args.shift() !== '--approve') throw new Error('Granting, signing, or installing policy requires --approve');
  const expected = { init: 5, grant: 4, issue: 6, status: 3, policy: 5, 'plan-retirement': 4, retire: 4 }[command ?? ''];
  if (!expected || args.length !== expected) throw new Error('Invalid issuer command');
  const [profilePath, privateKeyPath, ledgerPath, first, second, third] = args;
  const output = command === 'grant' ? first : command === 'issue' ? third : undefined;
  if (output && existsSync(output)) throw new Error('Output already exists; use a new filename to recover an exact response');
  function read(path: string, maxBytes = 32768) {
    if (statSync(path).size > maxBytes) throw new Error(`Issuer input exceeds ${maxBytes / 1024} KiB`);
    return readFileSync(path, 'utf8');
  }
  const profile = JSON.parse(read(profilePath));
  const permit = command === 'issue' ? JSON.parse(read(first)) : undefined;
  const request = command === 'issue' ? JSON.parse(read(second)) : undefined;
  const pem = read(privateKeyPath).trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
  if (!pem) throw new Error('Expected one PKCS8 private key');
  const bytes = Buffer.from(pem[1].replace(/\s/g, ''), 'base64');
  let privateKey: CryptoKey;
  // Blind RSA needs extractable RSA parameters; the ledger key is derived separately.
  try { privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']); }
  finally { bytes.fill(0); }
  const ledger = await openAdmissionIssuerLedger({ path: ledgerPath, expectedProfile: profile, privateKey,
    ...(command === 'init' ? { create: { batchSize: Number(first), maxPermits: Number(second) } } : {}) });
  try {
    if (command === 'plan-retirement' || command === 'retire') {
      const authority = read(first, 256).trim();
      const result = command === 'plan-retirement' ? ledger.planRetirement(authority) : ledger.retire(authority, retirementApproval!);
      console.log(JSON.stringify({ ...result, result: command === 'plan-retirement' ? 'review-required' : 'permanently-retired' }, null, 2));
    } else if (command === 'policy') {
      await ledger.installPolicy(JSON.parse(read(second, MAX_ADMISSION_POLICY_BYTES)), read(first).trim());
      console.log('Signed community policy installed; existing permits and reservations retained.');
    } else if (command === 'grant') {
      const invitation = ledger.grant();
      // If output fails, its allocated allowance remains consumed. Never roll back a grant.
      writeFileSync(output!, JSON.stringify(invitation) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`Permit for ${invitation.count} tokens saved. Keep it private; give it to one eligible recipient.`);
    } else if (command === 'issue') {
      const response = await ledger.approve(permit, request);
      writeFileSync(output!, JSON.stringify(response) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`Approved ${response.responses.length} blinded tokens. Exact response saved; retries do not use more allowance.`);
    } else console.log(JSON.stringify(ledger.status()));
  } finally { ledger.close(); }
}
try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'Issuer operation failed');
  console.error('Usage: node --import tsx scripts/issue-admission-tokens.ts <command>');
  console.error('  init profile.json private.pem ledger.json <batch-size:1–32> <max-permits:1–256>');
  console.error('  grant --approve profile.json private.pem ledger.json permit.json');
  console.error('  issue --approve profile.json private.pem ledger.json permit.json request.json response.json');
  console.error('  policy --approve profile.json private.pem ledger.json authority.pub policy.json');
  console.error('  status profile.json private.pem ledger.json');
  console.error('  plan-retirement profile.json private.pem ledger.json authority.pub');
  console.error('  retire --approve <review-digest> profile.json private.pem ledger.json authority.pub');
  process.exitCode = 1;
}
