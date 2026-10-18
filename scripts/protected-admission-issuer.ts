/** Explicit volunteer-protected issuer operations. All public pins come from operator files. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { MAX_ADMISSION_POLICY_BYTES, admissionPolicyDigest, assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES } from '@resonance/core/admission-issuance-allocation';
import { MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES } from '@resonance/core/admission-claim-assignment';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES } from '@resonance/core/admission-policy-advance';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { runProtectedIssuerRecoveryCommand } from '../packages/node/src/admission-issuer-recovery-command.js';
import { openProtectedAdmissionIssuerLedger } from '../packages/node/src/protected-admission-issuer-ledger.js';
import { IssuerPolicyObservationExpiredError } from '../packages/node/src/admission-issuer-ledger.js';
import { readOperatorFile, readOperatorJson, readOperatorSigningKey, writeOperatorJsonNew } from '../packages/relay/src/admission-operator-files.js';
import { parseAdmissionHistoryArchiveLimits } from '../packages/relay/src/admission-history-config.js';
import { createPinnedHistoryOperatorTransport } from '../packages/relay/src/history-operator-transport.js';
import { collectAdmissionPolicyObservation } from '../packages/relay/src/admission-policy-observation.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
function text(path: string, limit = 32768) {
  const bytes = readOperatorFile(path, limit);
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); }
  finally { bytes.fill(0); }
}
function configuration(value: unknown) {
  const hasLimits = !!value && typeof value === 'object' && Object.hasOwn(value, 'limits');
  if (!exactWitnessFields(value, ['version', 'context', 'members', 'ownerKeyFile', ...(hasLimits ? ['limits'] : [])]) || value.version !== 1
    || typeof value.ownerKeyFile !== 'string' || !value.ownerKeyFile.length || value.ownerKeyFile.length > 4096
    || !Array.isArray(value.members) || value.members.length !== 5) throw new Error('Invalid protected issuer configuration');
  const context = parseHistoryCheckpointContext(value.context);
  if (context.role !== 'admission-issuer') throw new Error('Protected issuer history requires its own admission-issuer role');
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string'
      || !context.members.includes(member.publicKey) || typeof member.endpoint !== 'string') throw new Error('Invalid pinned issuer history member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(member => member.publicKey)).size !== 5 || new Set(members.map(member => member.endpoint)).size !== 5) throw new Error('Protected issuer requires five distinct pinned history members and endpoints');
  return { version: 1 as const, context, members, ownerKeyFile: value.ownerKeyFile, ...(hasLimits ? { limits: parseAdmissionHistoryArchiveLimits(value.limits) } : {}) };
}
async function main() {
  if (process.env.RESONANCE_RELAY_STORAGE_SELECTION_FILE) throw new Error('Issuer tools require explicitly selected issuer files');
  const [command, ...raw] = process.argv.slice(2);
  if (command?.startsWith('recovery-')) {
    const { result } = await runProtectedIssuerRecoveryCommand(command, raw, controller.signal, { transportFile: process.env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE });
    console.log(JSON.stringify(result)); return;
  }
  const mutating = ['config', 'init', 'grant', 'issue', 'policy', 'retire'].includes(command ?? '');
  let args = raw, approval: string | undefined;
  if (mutating) {
    if (raw[0] !== '--approve') throw new Error('Protected issuer mutation requires --approve');
    args = raw.slice(1);
    if (command === 'retire') {
      approval = args.shift(); if (!/^sha256:[a-f0-9]{64}$/.test(approval ?? '')) throw new Error('Retirement requires its reviewed digest');
    }
  }
  if (command === 'config') {
    if (args.length !== 5) throw new Error('Configuration requires owner key, authority, policy, members and output files');
    const [ownerKeyFile, authorityFile, policyFile, membersFile, output] = args;
    const owner = readOperatorSigningKey(ownerKeyFile);
    try {
      const authority = text(authorityFile, 256).trim(), policy = await verifyAdmissionPolicy(readOperatorJson(policyFile, MAX_ADMISSION_POLICY_BYTES), authority);
      assertAdmissionPolicyCurrent(policy, Date.now());
      const members = readOperatorJson(membersFile, 64 * 1024);
      if (!Array.isArray(members)) throw new Error('Configuration requires five explicit history member records');
      const config = configuration({ version: 1, context: { version: 1, role: 'admission-issuer', historyId: randomBytes(32).toString('base64url'),
        owner: Buffer.from(owner.publicKey).toString('base64url'), authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}`,
        members: members.map(member => member?.publicKey).sort(), quorum: 4 }, members, ownerKeyFile: resolve(ownerKeyFile) });
      writeOperatorJsonNew(output, config, 64 * 1024);
      console.log(JSON.stringify({ result: 'protected-issuer-configuration', contextId: historyCheckpointContextId(config.context), output: resolve(output) }));
    } finally { owner.secretKey.fill(0); }
    return;
  }
  const count = { init: 9, ready: 5, status: 5, enrollment: 6, grant: 7, issue: 8, policy: 7, 'plan-retirement': 5, retire: 5 }[command ?? ''];
  if (!count || args.length !== count) throw new Error('Invalid protected issuer command');
  const [configFile, profileFile, privateFile, path, authorityFile, first, second, third, fourth] = args;
  const output = command === 'init' ? fourth : command === 'enrollment' ? first : command === 'grant' ? second : command === 'issue' ? third : undefined;
  if (output && existsSync(output)) throw new Error('Output already exists; select a new filename');
  const config = configuration(readOperatorJson(configFile, 64 * 1024));
  const signingKey = readOperatorSigningKey(resolve(dirname(resolve(configFile)), config.ownerKeyFile));
  let transport: ReturnType<typeof createPinnedHistoryOperatorTransport> | undefined;
  let ledger: Awaited<ReturnType<typeof openProtectedAdmissionIssuerLedger>> | undefined;
  try {
    if (Buffer.from(signingKey.publicKey).toString('base64url') !== config.context.owner) throw new Error('Issuer history owner key differs from its independent pin');
    const pem = text(privateFile).trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
    if (!pem) throw new Error('Expected one PKCS8 private key');
    const bytes = Buffer.from(pem[1].replace(/\s/g, ''), 'base64');
    let privateKey: CryptoKey;
    try { privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']); }
    finally { bytes.fill(0); }
    const protection = { context: config.context, members: config.members, signingKey, writerDirectory: `${path}.history`,
      ...(config.limits ? { maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks } : {}) };
    transport = createPinnedHistoryOperatorTransport(protection, process.env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE, controller.signal);
    ledger = await openProtectedAdmissionIssuerLedger({ path, expectedProfile: readOperatorJson(profileFile, 32768), privateKey,
      expectedAllocationAuthority: text(authorityFile, 256).trim(), protection: { ...transport.protection,
        ...(command === 'init' ? { initializeWriter: true, initializeArchive: true } : {}) },
      ...(command === 'init' ? { initialize: { allocation: readOperatorJson(first, MAX_ADMISSION_ISSUANCE_ALLOCATION_BYTES),
        communityPolicy: readOperatorJson(second, MAX_ADMISSION_POLICY_BYTES), observers: readOperatorJson(third, 16384) } } : {}) });
    const current = ledger;
    if (command === 'status') { console.log(JSON.stringify(current.status())); return; }
    if (command === 'init' || command === 'enrollment') {
      writeOperatorJsonNew(output!, { version: 1, kind: 'admission-history-enrollment', ...current.enrollment() }, HISTORY_ENVELOPE_MAX_BYTES + 65536);
      console.log(JSON.stringify({ result: 'protected-issuer-enrollment', output: resolve(output!), readiness: 'unverified' })); return;
    }
    await current.ready();
    if (controller.signal.aborted) throw new Error('Protected issuer operation cancelled');
    const observe = async () => {
      const { context, query } = current.preparePolicyObservation();
      const certificate = await collectAdmissionPolicyObservation({ context, request: query.request });
      if (controller.signal.aborted) throw new Error('Protected issuer operation cancelled');
      return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate };
    };
    if (command === 'grant') {
      const assignment = readOperatorJson(first, MAX_ADMISSION_CLAIM_ASSIGNMENT_BYTES);
      const permit = await current.grantForAssignment(assignment, await observe());
      if (controller.signal.aborted) throw new Error('Protected issuer operation cancelled');
      writeOperatorJsonNew(output!, permit, 32768); console.log(JSON.stringify({ result: 'permit-saved', count: permit.count }));
    } else if (command === 'issue') {
      const permit = readOperatorJson(first, 32768), request = readOperatorJson(second, 32768);
      let response;
      try { response = await current.approve(permit, request, await observe()); }
      catch (error) {
        if (!(error instanceof IssuerPolicyObservationExpiredError)) throw error;
        response = await current.approve(permit, request, await observe());
      }
      if (controller.signal.aborted) throw new Error('Protected issuer operation cancelled');
      writeOperatorJsonNew(output!, response, 32768); console.log(JSON.stringify({ result: 'response-saved', count: response.responses.length }));
    } else if (command === 'policy') {
      await current.installPolicy(readOperatorJson(first, MAX_ADMISSION_POLICY_BYTES), config.context.authority,
        { advance: readOperatorJson(second, ADMISSION_POLICY_ADVANCE_MAX_BYTES) });
      console.log(JSON.stringify({ result: 'protected-policy-installed' }));
    } else if (command === 'plan-retirement' || command === 'retire') {
      const plan = command === 'plan-retirement' ? current.planRetirement(config.context.authority) : await current.retire(config.context.authority, approval!);
      console.log(JSON.stringify({ ...plan, result: command === 'plan-retirement' ? 'review-required' : 'permanently-retired' }));
    } else console.log(JSON.stringify({ result: 'protected-issuer-ready', ...current.status() }));
  } finally { ledger?.close(); transport?.close(); signingKey.secretKey.fill(0); }
}
try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'Protected issuer operation failed');
  console.error('Usage: node --import tsx scripts/protected-admission-issuer.ts <command>');
  console.error('  config --approve owner-private.json authority.pub policy.json members.json config.json');
  console.error('  Common arguments: config.json profile.json private.pem ledger.json authority.pub');
  console.error('  init --approve <common> allocation.json policy.json observers.json enrollment.json');
  console.error('  ready|status <common>');
  console.error('  enrollment <common> new-enrollment.json');
  console.error('  grant --approve <common> assignment.json permit.json');
  console.error('  issue --approve <common> permit.json request.json response.json');
  console.error('  policy --approve <common> next-policy.json signed-advance.json');
  console.error('  plan-retirement <common>');
  console.error('  retire --approve <review-digest> <common>');
  console.error('  recovery-plan <common> original-enrollment.json recovery-dir available|unavailable view');
  console.error('  recovery-start --approve <digest> <common> original-enrollment.json recovery-dir available|unavailable view');
  console.error('  recovery-status|recovery-step <common> original-enrollment.json recovery-dir');
  console.error('  recovery-review|recovery-resume-plan <common> original-enrollment.json recovery-dir destination-ledger.json');
  console.error('  recovery-restore|recovery-resume --approve <digest> <common> original-enrollment.json recovery-dir destination-ledger.json');
  console.error('  History writer: <ledger.json>.history. Optional pinned transport: RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE.');
  process.exitCode = 1;
} finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
