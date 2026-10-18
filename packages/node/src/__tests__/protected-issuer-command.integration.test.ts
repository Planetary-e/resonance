import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { signAdmissionIssuanceAllocation, admissionIssuanceAllocationDigest } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { policyObserverFixture } from '../../../relay/src/__tests__/fixtures/policy-observer-fixture.js';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../../../relay/src/protected-policy-observer.js';
import { openHistoryVolunteerService } from '../../../relay/src/history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../../../relay/src/history-agreement-exchange.js';
import { listenHistoryCheckpointReplica } from '../../../relay/src/history-checkpoint-exchange.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver } from '../../../relay/src/admission-policy-observation-transport.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Protected issuer command cleanup failed');
});

it('runs the real protected issuer CLI through four volunteer copies, protected observers, restart and a returning fourth', async () => {
  const n = await policyObserverFixture({ policyLifetimeMs: 600000, keyLifetimeMs: 600000 }); cleanup.push(n.close);
  const observerHandlers: Array<(value: unknown) => Promise<unknown>> = [], observers = [];
  const observerListeners: Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>[] = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenAdmissionPolicyObserver(value => observerHandlers[i](value));
    observerListeners.push(listener); cleanup.push(listener.close);
  }
  const observerContext = parseAdmissionPolicyObservers({ ...n.context, members: n.keys.map((key, i) => ({
    publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: observerListeners[i].endpoint,
  })) });
  for (let i = 0; i < 5; i++) {
    const encryptionKey = randomBytes(32); cleanup.push(() => { encryptionKey.fill(0); });
    const enrolled = await createPolicyObserverHistoryRoot({ context: observerContext, policy: n.first, encryptionKey, signingKey: n.keys[i] });
    const members = [];
    for (let j = 0; j < 5; j++) {
      const localKey = randomBytes(32); cleanup.push(() => { localKey.fill(0); });
      const service = openHistoryVolunteerService({ directory: join(n.directory, `observer-${i}-replica-${j}`), context: enrolled.context,
        genesisId: historyCheckpointEnvelopeId(enrolled.root), localKey, signingKey: n.keys[j], initialize: enrolled.root });
      cleanup.push(service.close);
      const listener = await listenHistoryAgreementReplica(service); cleanup.push(listener.close);
      members.push({ publicKey: Buffer.from(n.keys[j].publicKey).toString('base64url'), endpoint: listener.checkpointEndpoint });
    }
    const observer = await openProtectedPolicyObserver({ directory: join(n.directory, `observer-${i}`), context: observerContext,
      historyContext: enrolled.context, encryptionKey, signingKey: n.keys[i], root: enrolled.root, members, mode: 'create-new' });
    cleanup.push(observer.close); await observer.ready(); observers.push(observer);
    observerHandlers[i] = createAdmissionPolicyObserverExchange(observer, observerContext);
  }

  const historyOwner = generateSigningKeyPair(), historyMembers = Array.from({ length: 5 }, generateSigningKeyPair);
  cleanup.push(() => { historyOwner.secretKey.fill(0); historyMembers.forEach(key => key.secretKey.fill(0)); });
  const services: ReturnType<typeof openHistoryVolunteerService>[] = [], online = [true, true, true, false, false];
  const historyListeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
  let historyRequests = 0;
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryCheckpointReplica({ exchange(value) {
      historyRequests++; if (!online[i]) throw new Error('Volunteer unavailable in scenario');
      return services[i].checkpoint(value);
    }, close() {} });
    historyListeners.push(listener); cleanup.push(listener.close);
  }
  const file = (name: string) => join(n.directory, name);
  const json = (name: string, value: unknown) => { writeFileSync(file(name), JSON.stringify(value), { mode: 0o600 }); return file(name); };
  const read = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'));
  const profile = n.first.keys[0].profile;
  const allocation = await signAdmissionIssuanceAllocation({ version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1',
    community: 'public', epoch: profile.scope.epoch, notBefore: n.now - 1000, issueUntil: n.now + 180000, totalTokenBudget: 2,
    allocations: [{ profile, batchSize: 1, maxPermits: 2 }] }, n.authority, n.key.secretKey);
  const assignment = await signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority: n.authority,
    allocationDigest: admissionIssuanceAllocationDigest(allocation), community: 'public', epoch: profile.scope.epoch,
    claimHandle: randomBytes(32).toString('base64url'), issuerKeyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey) }, allocation, n.authority, n.key.secretKey);
  writeFileSync(file('authority.pub'), n.authority); writeFileSync(file('issuer.pem'), n.issuerPrivateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  json('profile.json', profile); json('allocation.json', allocation); json('assignment.json', assignment); json('policy.json', n.first); json('observers.json', observerContext);
  json('owner.json', { publicKey: Buffer.from(historyOwner.publicKey).toString('base64url'), secretKey: Buffer.from(historyOwner.secretKey).toString('base64url') });
  json('members.json', historyMembers.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: historyListeners[i].endpoint })));
  const main = fileURLToPath(new URL('../../../../scripts/protected-admission-issuer.ts', import.meta.url));
  const env = { ...process.env }; delete env.RESONANCE_RELAY_STORAGE_SELECTION_FILE; delete env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE;
  const run = (command: string, args: string[]) => promisify(execFile)(process.execPath,
    ['--no-addons', '--import', import.meta.resolve('tsx'), main, command, ...args], { cwd: n.directory, env, timeout: 20000 });
  const common = ['config.json', 'profile.json', 'issuer.pem', 'issuer.json', 'authority.pub'].map(file);
  await run('config', ['--approve', ...['owner.json', 'authority.pub', 'policy.json', 'members.json', 'config.json'].map(file)]);
  await run('init', ['--approve', ...common, ...['allocation.json', 'policy.json', 'observers.json', 'enrollment.json'].map(file)]);
  expect(historyRequests).toBe(0);
  expect(JSON.parse((await run('status', common)).stdout)).toMatchObject({ allocatedPermits: 0, protection: { ready: false, pending: true } });
  expect(historyRequests).toBe(0);
  const enrolled = read('enrollment.json'); expect(enrolled.context.role).toBe('admission-issuer');
  for (let i = 0; i < 5; i++) {
    const localKey = randomBytes(32); cleanup.push(() => { localKey.fill(0); });
    const service = openHistoryVolunteerService({ directory: file(`issuer-replica-${i}`), context: enrolled.context,
      genesisId: historyCheckpointEnvelopeId(enrolled.root), localKey, signingKey: historyMembers[i], initialize: enrolled.root });
    services.push(service); cleanup.push(service.close);
  }
  await expect(run('ready', common)).rejects.toThrow(/Four|four/);
  online[3] = true; await run('ready', common);
  await run('grant', ['--approve', ...common, file('assignment.json'), file('permit.json')]);
  await run('grant', ['--approve', ...common, file('assignment.json'), file('permit-retry.json')]);
  expect(read('permit-retry.json')).toEqual(read('permit.json'));
  const batch = await createAdmissionIssuanceBatch(profile, 1); json('request.json', batch.request);
  await run('issue', ['--approve', ...common, ...['permit.json', 'request.json', 'response.json'].map(file)]);
  const response = read('response.json'); expect(await batch.finalize(response)).toHaveLength(1);
  expect(services.slice(0, 4).every(service => service.describe().latest.sequence === 4)).toBe(true);
  expect(services[4].describe().latest.sequence).toBe(0);
  const beforeStatus = historyRequests;
  expect(JSON.parse((await run('status', common)).stdout)).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 1, protection: { pending: false } });
  expect(historyRequests).toBe(beforeStatus);
  online[3] = false;
  await expect(run('issue', ['--approve', ...common, ...['permit.json', 'request.json', 'unavailable.json'].map(file)])).rejects.toThrow(/Four|four/);
  expect(existsSync(file('unavailable.json'))).toBe(false);
  online[4] = true;
  await run('issue', ['--approve', ...common, ...['permit.json', 'request.json', 'response-retry.json'].map(file)]);
  expect(read('response-retry.json')).toEqual(response); expect(services[4].describe().latest.sequence).toBe(4);

  const advance = await createAdmissionPolicyAdvance(n.first, n.second, observerContext, n.key);
  for (const observer of observers) await observer.advance(advance);
  await expect(run('issue', ['--approve', ...common, ...['permit.json', 'request.json', 'old-policy.json'].map(file)])).rejects.toThrow('newer');
  expect(existsSync(file('old-policy.json'))).toBe(false);
  expect(JSON.parse((await run('status', common)).stdout)).toMatchObject({ allocatedPermits: 1, policyFreshness: { installedRevision: 1, observedRevision: 2 } });
  json('next-policy.json', n.second); json('advance.json', advance);
  await run('policy', ['--approve', ...common, file('next-policy.json'), file('advance.json')]);
  await run('issue', ['--approve', ...common, ...['permit.json', 'request.json', 'current-policy.json'].map(file)]);
  expect(read('current-policy.json')).toEqual(response);
  for (const secret of [assignment.claimHandle, read('permit.json').secret, ...response.responses]) {
    expect(readFileSync(file('issuer.json'), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(enrolled.root)).not.toContain(secret);
  }
}, 120000);
