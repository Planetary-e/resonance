import { MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES } from '@resonance/core/admission-issuance-allocation';
import { MAX_ADMISSION_POLICY_BYTES } from '@resonance/core/admission-policy';
/** Community permits and durable batch approval. Enrolled issuers collect fresh
 * public policy metadata from pinned volunteers only during explicit commands. */
import { existsSync, writeFileSync } from 'node:fs';
import { openAdmissionIssuerLedger, approveAdmissionIssuerBatch } from '../packages/node/src/admission-issuer-ledger.js';
import { readOperatorFile } from '../packages/relay/src/admission-operator-files.js';
import { collectAdmissionPolicyObservation } from '../packages/relay/src/admission-policy-observation.js';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES } from '@resonance/core/admission-policy-advance';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';

async function main() {
  if (process.env.RESONANCE_RELAY_STORAGE_SELECTION_FILE) throw new Error('Offline authority and issuer tools do not use the relay storage budget; prepare their files separately before reviewed adoption');
  const args = process.argv.slice(2);
  const command = args.shift();
  let retirementApproval: string | undefined;
  if (command === 'retire') {
    if (args.shift() !== '--approve' || !/^sha256:[a-f0-9]{64}$/.test(retirementApproval = args.shift() ?? '')) throw new Error('Retirement requires --approve and the reviewed digest');
  }
  if ((command === 'grant' || command === 'issue' || command === 'policy') && args.shift() !== '--approve') throw new Error('Granting, signing, or installing policy requires --approve');
  const claimRequired = command === 'init' && args[0] === '--claim-required';
  if (claimRequired) args.shift();
  let allocationPath: string | undefined, allocationAuthorityPath: string | undefined;
  if (command === 'init-allocation') {
    if (args.shift() !== '--authority-file' || !(allocationAuthorityPath = args.shift()) || allocationAuthorityPath.startsWith('--')
      || args.shift() !== '--allocation-file' || !(allocationPath = args.shift()) || allocationPath.startsWith('--')) throw new Error('Allocation initialization requires independently pinned authority and signed allocation files');
  }
  let claimPath: string | undefined;
  if (command === 'grant' && args[0] === '--claim-file') { args.shift(); claimPath = args.shift(); if (!claimPath || claimPath.startsWith('--')) throw new Error('Claim option requires an operator file'); }
  let observersPath: string | undefined, advancePath: string | undefined;
  if (command === 'policy') while (args[0]?.startsWith('--')) {
    const option = args.shift(), path = args.shift();
    if (!path || path.startsWith('--')) throw new Error('Policy option requires a file');
    if (option === '--observers' && !observersPath) observersPath = path;
    else if (option === '--advance' && !advancePath) advancePath = path;
    else throw new Error('Unknown or repeated issuer policy option');
  }
  const expected = { init: 5, 'init-allocation': 3, grant: 4, issue: 6, status: 3, policy: 5, 'plan-retirement': 4, retire: 4 }[command ?? ''];
  if (!expected || args.length !== expected) throw new Error('Invalid issuer command');
  const [profilePath, privateKeyPath, ledgerPath, first, second, third] = args;
  const output = command === 'grant' ? first : command === 'issue' ? third : undefined;
  if (output && existsSync(output)) throw new Error('Output already exists; use a new filename to recover an exact response');
  function read(path: string, maxBytes = 32768) {
    const bytes = readOperatorFile(path, maxBytes);
    try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Issuer input must be valid UTF-8'); }
    finally { bytes.fill(0); }
  }
  function json(path: string, maxBytes?: number): unknown { try { return JSON.parse(read(path, maxBytes)); } catch { throw new Error('Issuer input must be bounded, readable JSON'); } }
  const profile = json(profilePath);
  const claimFile = claimPath ? json(claimPath, 1024) : undefined;
  if (claimFile !== undefined && (!claimFile || typeof claimFile !== 'object' || Array.isArray(claimFile)
    || Object.keys(claimFile).sort().join(',') !== 'handle,kind,version'
    || (claimFile as { version?: unknown }).version !== 1 || (claimFile as { kind?: unknown }).kind !== 'admission-operator-claim')) throw new Error('Invalid bounded operator claim file');
  const permit = command === 'issue' ? json(first) : undefined;
  const request = command === 'issue' ? json(second) : undefined;
  const pem = read(privateKeyPath).trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
  if (!pem) throw new Error('Expected one PKCS8 private key');
  const bytes = Buffer.from(pem[1].replace(/\s/g, ''), 'base64');
  let privateKey: CryptoKey;
  // Blind RSA needs extractable RSA parameters; the ledger key is derived separately.
  try { privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']); }
  finally { bytes.fill(0); }
  const ledger = await openAdmissionIssuerLedger({ path: ledgerPath, expectedProfile: profile, privateKey,
    ...(command === 'init-allocation' ? { allocation: { manifest: json(allocationPath!, MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES), authority: read(allocationAuthorityPath!, 256).trim() } } : {}),
    ...(command === 'init' ? { ...(claimRequired ? { claimRequired: true } : {}), create: { batchSize: Number(first), maxPermits: Number(second) } } : {}) });
  const observation = async () => {
    if (!ledger.status().policyFreshness) return undefined;
    const { context, query } = ledger.preparePolicyObservation();
    const certificate = await collectAdmissionPolicyObservation({ context, request: query.request });
    return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate };
  };
  try {
    if (command === 'plan-retirement' || command === 'retire') {
      const authority = read(first, 256).trim();
      const result = command === 'plan-retirement' ? ledger.planRetirement(authority) : ledger.retire(authority, retirementApproval!);
      console.log(JSON.stringify({ ...result, result: command === 'plan-retirement' ? 'review-required' : 'permanently-retired' }, null, 2));
    } else if (command === 'policy') {
      await ledger.installPolicy(json(second, MAX_ADMISSION_POLICY_BYTES), read(first, 256).trim(), {
        observers: observersPath ? json(observersPath, 16384) : undefined, advance: advancePath ? json(advancePath, ADMISSION_POLICY_ADVANCE_MAX_BYTES) : undefined });
      console.log('Signed community policy installed; existing permits and reservations retained.');
    } else if (command === 'grant') {
      const proof = await observation();
      const invitation = claimFile === undefined ? ledger.grant(proof) : ledger.grantForClaim((claimFile as { handle: unknown }).handle, proof);
      // If output fails, its allocated allowance remains consumed. Never roll back a grant.
      writeFileSync(output!, JSON.stringify(invitation) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`Permit for ${invitation.count} tokens saved. Keep it private; give it to one eligible recipient.`);
    } else if (command === 'issue') {
      const response = await approveAdmissionIssuerBatch(ledger, permit, request, observation);
      writeFileSync(output!, JSON.stringify(response) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`Approved ${response.responses.length} blinded tokens. Exact response saved; retries do not use more allowance.`);
    } else console.log(JSON.stringify(ledger.status()));
  } finally { ledger.close(); }
}
try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'Issuer operation failed');
  console.error('Usage: node --import tsx scripts/issue-admission-tokens.ts <command>');
  console.error('  init [--claim-required] profile.json private.pem ledger.json <batch-size:1–32> <max-permits:1–256>');
  console.error('  init-allocation --authority-file authority.pub --allocation-file signed-allocation.json profile.json private.pem ledger.json');
  console.error('  grant --approve [--claim-file operator-claim.json] profile.json private.pem ledger.json permit.json');
  console.error('  issue --approve profile.json private.pem ledger.json permit.json request.json response.json');
  console.error('  policy --approve [--observers observers.json] [--advance advance.json] profile.json private.pem ledger.json authority.pub policy.json');
  console.error('  status profile.json private.pem ledger.json');
  console.error('  plan-retirement profile.json private.pem ledger.json authority.pub');
  console.error('  retire --approve <review-digest> profile.json private.pem ledger.json authority.pub');
  process.exitCode = 1;
}
