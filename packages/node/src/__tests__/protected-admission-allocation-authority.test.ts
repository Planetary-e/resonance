import { afterEach, beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openHistoryCheckpointStore } from '../../../relay/src/history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../../../relay/src/history-checkpoint-exchange.js';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { openProtectedIssuerHistory } from '../../../relay/src/protected-issuer-history.js';
import { HISTORY_WRITER_FILENAME } from '../../../relay/src/history-checkpoint-quorum.js';
import { openProtectedAdmissionAllocationAuthority } from '../protected-admission-allocation-authority.js';
import { openAdmissionAllocationAuthority } from '../admission-allocation-authority.js';
import { allocationAuthorityHistoryAnchor, deriveAdmissionAllocationAuthorityEncryptionKey } from '../admission-allocation-authority-state.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
let publicKeys: string[];
beforeAll(() => { publicKeys = [0, 1].map(() => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()); });
function plan(epoch = 'one') {
  return { version: 2 as const, kind: 'admission-issuance-allocation' as const, claimPolicy: 'authority-assigned-v1' as const,
    community: 'public' as const, epoch, notBefore: 100, issueUntil: 200, totalTokenBudget: 4,
    allocations: publicKeys.map((issuerPublicKey, i) => ({ batchSize: 1, maxPermits: 2, profile: { version: 1 as const,
      scope: { issuer: `allocator-${i}`, community: 'public' as const, epoch }, issuerPublicKey, relayUrls: ['ws://127.0.0.1:44010/'] } })) };
}
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'protected-allocation-'))), h = historyCheckpointFixture(), authorityKey = generateSigningKeyPair();
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => { h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); authorityKey.secretKey.fill(0); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const context = { ...h.context, role: 'admission-allocation-authority' as const, authority, policyDigest: allocationAuthorityHistoryAnchor(authority) };
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${45001 + i}/history-checkpoint` }));
  let online = 5, now = 150, calls = 0, failSequence: number | undefined, onAppend: (() => void) | undefined;
  const roles: ReturnType<typeof createHistoryCheckpointReplica>[] = [], stores: ReturnType<typeof openHistoryCheckpointStore>[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame) => {
    calls++; const i = context.members.indexOf(member.publicKey);
    if (i >= online || failSequence !== undefined && frame.envelope && frame.envelope.sequence >= failSequence && i >= 3) throw new Error('offline');
    if (frame.envelope && frame.envelope.sequence > 0) onAppend?.(); return roles[i].exchange(frame);
  };
  const options = { path: join(directory, 'authority.json'), authority, secretKey: authorityKey.secretKey, now: () => now,
    protection: { context, signingKey: h.owner, members, writerDirectory: join(directory, 'writer'), transport, timeoutMs: 1000 } };
  let ledger = await openProtectedAdmissionAllocationAuthority({ ...options, mode: 'create-new' }); cleanup.push(() => ledger.close());
  const root = ledger.enrollment().root;
  for (let i = 0; i < 5; i++) {
    const store = openHistoryCheckpointStore({ directory: join(directory, `replica-${i}`), context, replica: context.members[i], localKey: h.localKey,
      rootId: historyCheckpointEnvelopeId(root), generation: 0, initialize: root }); stores.push(store); cleanup.push(store.close);
    const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); roles.push(role); cleanup.push(role.close);
  }
  return { directory, context, options, stores, authorityKey, h, get ledger() { return ledger; }, get calls() { return calls; },
    online(value: number) { online = value; }, clock(value: number) { now = value; }, failAt(value?: number) { failSequence = value; }, onAppend(value: () => void) { onAppend = value; },
    async reopen() { ledger.close(); ledger = await openProtectedAdmissionAllocationAuthority({ ...options, mode: 'open-existing' }); return ledger; } };
}
const claim = (issuer = 0) => ({ community: 'public' as const, epoch: 'one', claimHandle: randomBytes(32).toString('base64url'), issuerKeyFingerprint: admissionKeyFingerprint(publicKeys[issuer]) });
it('requires four fresh exact-head copies for new plans, but permits offline exact applied exports after expiry', async () => {
  const n = await fixture(), reviewed = await n.ledger.review(plan()); expect(n.calls).toBe(0);
  await expect(n.ledger.sign(plan(), reviewed.approvalDigest)).rejects.toThrow('readiness');
  n.online(3); await expect(n.ledger.ready()).rejects.toThrow('Four'); n.online(4); await n.ledger.ready();
  const signed = await n.ledger.sign(plan(), reviewed.approvalDigest);
  expect(n.ledger.status()).toMatchObject({ manifestCount: 1, assignmentCount: 0, protection: { ready: true, pending: false } });
  expect(n.stores.filter(store => store.describe().sequence === 1)).toHaveLength(4);
  await n.reopen(); const count = n.calls; n.clock(300);
  expect(await n.ledger.sign(plan(), reviewed.approvalDigest)).toEqual(signed); expect(n.calls).toBe(count);
  const other = await n.ledger.review(plan('two')); await expect(n.ledger.sign(plan('two'), other.approvalDigest)).rejects.toThrow('readiness');
  await n.ledger.ready(); await expect(n.ledger.sign(plan('two'), other.approvalDigest)).rejects.toThrow('not current');
  const conflicting = { ...plan(), issueUntil: 201 }, conflict = await n.ledger.review(conflicting);
  await expect(n.ledger.sign(conflicting, conflict.approvalDigest)).rejects.toThrow('Conflicting');
});
it('does not expose a pending manifest or claim until exact durable completion, including after expiry', async () => {
  const n = await fixture(); await n.ledger.ready(); const reviewed = await n.ledger.review(plan()); n.failAt(1);
  await expect(n.ledger.sign(plan(), reviewed.approvalDigest)).rejects.toThrow('Four'); expect(n.ledger.current('public', 'one')).toBeUndefined();
  expect(n.ledger.status()).toMatchObject({ manifestCount: 0, protection: { pending: true, ready: false } });
  n.failAt(); await n.reopen(); expect(n.ledger.current('public', 'one')).toBeUndefined(); await n.ledger.ready();
  const request = claim(), assignment = await n.ledger.reviewAssignment(request); n.failAt(2);
  await expect(n.ledger.assignClaim(request, assignment.approvalDigest)).rejects.toThrow('Four');
  expect(n.ledger.currentAssignment('public', 'one', request.claimHandle)).toBeUndefined();
  n.failAt(); n.clock(300); await n.reopen(); await n.ledger.ready();
  const retained = n.ledger.currentAssignment('public', 'one', request.claimHandle); expect(retained).toBeDefined();
  await n.reopen(); const count = n.calls; expect(await n.ledger.assignClaim(request, assignment.approvalDigest)).toEqual(retained); expect(n.calls).toBe(count);
});
it('retains single-issuer claim decisions and capacity across restart with independent authority and history owner keys', async () => {
  const n = await fixture(); expect(n.context.owner).not.toBe(n.context.authority); await n.ledger.ready();
  const reviewed = await n.ledger.review(plan()); await n.ledger.sign(plan(), reviewed.approvalDigest);
  const request = claim(), reviewedClaim = await n.ledger.reviewAssignment(request), first = await n.ledger.assignClaim(request, reviewedClaim.approvalDigest);
  await n.reopen(); expect(n.ledger.currentAssignment('public', 'one', request.claimHandle)).toEqual(first); await n.ledger.ready();
  const reassigned = { ...request, issuerKeyFingerprint: admissionKeyFingerprint(publicKeys[1]) }, rereview = await n.ledger.reviewAssignment(reassigned);
  await expect(n.ledger.assignClaim(reassigned, rereview.approvalDigest)).rejects.toThrow('different issuer');
  const second = claim(), secondReview = await n.ledger.reviewAssignment(second); await n.ledger.assignClaim(second, secondReview.approvalDigest);
  const third = claim(), thirdReview = await n.ledger.reviewAssignment(third); await expect(n.ledger.assignClaim(third, thirdReview.approvalDigest)).rejects.toThrow('exhausted');
  expect(n.ledger.status()).toMatchObject({ assignmentCount: 2 });
});
it('rechecks currentness after quorum without returning a newly expired artifact', async () => {
  const n = await fixture(); await n.ledger.ready(); const reviewed = await n.ledger.review(plan()); n.onAppend(() => n.clock(200));
  await expect(n.ledger.sign(plan(), reviewed.approvalDigest)).rejects.toThrow('not current');
  expect(n.ledger.current('public', 'one')).toBeDefined(); // The retained exact decision can be explicitly re-exported.
  expect(n.ledger.status().protection.pending).toBe(false);
});
it('checks the allocation window at the durable intent boundary after asynchronous snapshot verification', async () => {
  const n = await fixture(); let reads = 0; n.options.now = () => ++reads < 3 ? 150 : 200;
  await n.reopen(); await n.ledger.ready(); const reviewed = await n.ledger.review(plan());
  await expect(n.ledger.sign(plan(), reviewed.approvalDigest)).rejects.toThrow('not current');
  expect(reads).toBe(3); expect(n.ledger.current('public', 'one')).toBeUndefined();
  expect(n.ledger.status().protection).toMatchObject({ pending: false, ready: false, applied: { sequence: 0 } });
});
it('fences legacy and issuer disk formats, rejects privileged options, and never recreates a missing writer', async () => {
  const n = await fixture(); await n.ledger.ready(); n.ledger.close();
  await expect(openAdmissionAllocationAuthority({ path: n.options.path, authority: n.options.authority, secretKey: n.authorityKey.secretKey, mode: 'open-existing' })).rejects.toThrow();
  const key = deriveAdmissionAllocationAuthorityEncryptionKey(n.authorityKey.secretKey, n.options.authority); cleanup.push(() => key.fill(0));
  await expect(openProtectedIssuerHistory({ ...n.options.protection, path: n.options.path, domain: 'resonance:admission-allocation-authority-journal:v1',
    encryptionKey: key, initial: undefined, validate: value => value, context: { ...n.context, role: 'admission-issuer' } })).rejects.toThrow();
  for (const field of ['role', 'domain', 'validate', 'initialize', 'restore', 'resumeRestoration']) {
    await expect(openProtectedAdmissionAllocationAuthority({ ...n.options, mode: 'open-existing', protection: { ...n.options.protection, [field]: true } } as never)).rejects.toThrow('fixed');
  }
  const before = readFileSync(n.options.path); rmSync(join(n.options.protection.writerDirectory, HISTORY_WRITER_FILENAME));
  await expect(openProtectedAdmissionAllocationAuthority({ ...n.options, mode: 'open-existing' })).rejects.toThrow();
  expect(readFileSync(n.options.path)).toEqual(before); expect(existsSync(join(n.options.protection.writerDirectory, HISTORY_WRITER_FILENAME))).toBe(false);
  const localPath = join(n.directory, 'legacy.json'), local = await openAdmissionAllocationAuthority({ path: localPath, authority: n.options.authority, secretKey: n.authorityKey.secretKey, mode: 'create-new' }); local.close();
  await expect(openProtectedAdmissionAllocationAuthority({ ...n.options, path: localPath, mode: 'open-existing', protection: { ...n.options.protection, writerDirectory: join(n.directory, 'new-writer') } })).rejects.toThrow();
});
