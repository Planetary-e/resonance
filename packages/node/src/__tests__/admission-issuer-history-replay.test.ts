import { afterEach, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionPolicyDigest, admissionKeyFingerprint, signAdmissionPolicy, type AdmissionWalletProfileV1 } from '@resonance/core/admission-policy';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { createHistoryFreeze, sealHistoryCheckpoint, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryAgreementRequest, createHistoryAgreementVote } from '@resonance/core/history-agreement';
import { createHistorySuccessorProposal, historySuccessorProposalId } from '@resonance/core/history-successor';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { claimDigest, claimScopeBinding, permitHash, totals, type State } from '../admission-issuer-state.js';
import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor } from '../protected-admission-issuer-state.js';
import { replayProtectedIssuerHistory } from '../admission-issuer-history-replay.js';
import { prepareProtectedIssuerRestore, readPreparedProtectedIssuerRestore } from '../admission-issuer-history-restore.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

let profile: AdmissionWalletProfileV1, base: State, granted: State, bound: State, prepared: State, completed: State, advanced: State, retired: State;
const authorityKey = generateSigningKeyPair(), authority = Buffer.from(authorityKey.publicKey).toString('base64url');
beforeAll(async () => {
  const pair = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  profile = { version: 1, scope: { issuer: 'issuer-replay', community: 'public', epoch: 'one' }, issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45111/'] };
  const policy = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: 100, expiresAt: 1000,
    activeKey: admissionKeyFingerprint(profile.issuerPublicKey), keys: [{ profile, notBefore: 100, issueUntil: 200, spendUntil: 300, retryUntil: 400 }] }, authority, authorityKey.secretKey);
  profile = policy.keys[0].profile;
  const allocation = await signAdmissionIssuanceAllocation({ version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1', community: 'public', epoch: 'one',
    notBefore: 100, issueUntil: 200, totalTokenBudget: 2, allocations: [{ profile, batchSize: 1, maxPermits: 2 }] }, authority, authorityKey.secretKey);
  const observers = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(policy), quorum: 4,
    members: Array.from({ length: 5 }, (_, i) => ({ publicKey: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${35001 + i}/` })) });
  base = { version: 8, profile, claimMode: 'authority-assigned-v1', allocation: { manifest: allocation, authority, digest: admissionIssuanceAllocationDigest(allocation) },
    policy: { batchSize: 1, maxPermits: 2 }, entries: [], communityPolicy: policy, freshness: { context: observers, installed: observers.genesis, observed: observers.genesis } };
  const handle = randomBytes(32).toString('base64url'), secret = randomBytes(32).toString('base64url'), binding = claimScopeBinding(profile, base.policy, base.allocation!.digest);
  const assignment = await signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority, allocationDigest: base.allocation!.digest,
    community: 'public', epoch: 'one', claimHandle: handle, issuerKeyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey) }, allocation, authority, authorityKey.secretKey);
  granted = { ...base, entries: [{ permitHash: permitHash(secret), claim: { binding, digest: claimDigest(binding, handle), secret }, assignment }] };
  bound = { ...granted, entries: [{ ...granted.entries[0], batchId: 'a'.repeat(64) }] };
  prepared = { ...bound, entries: [{ ...bound.entries[0], preparedResponse: { version: 1, kind: 'admission-issuance-response', batchId: 'a'.repeat(64), responses: [Buffer.alloc(256, 1).toString('base64url')] } }] };
  completed = { ...bound, entries: [{ ...bound.entries[0], response: prepared.entries[0].preparedResponse }] };
  // The old key remains present but inactive; historical replay is independent of current wall time.
  const other = { ...profile, scope: { ...profile.scope, issuer: 'successor' }, issuerPublicKey: profile.issuerPublicKey };
  // Policy active-key identity is key-based, so use the same entry with issue cutoff reached for retirement via a different generated key.
  const otherPair = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  other.issuerPublicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', otherPair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
  const { authority: _authority, signature: _signature, ...body } = policy;
  const nextPolicy = await signAdmissionPolicy({ ...body, revision: 2, activeKey: admissionKeyFingerprint(other.issuerPublicKey), keys: [...policy.keys,
    { profile: other, notBefore: 100, issueUntil: 200, spendUntil: 300, retryUntil: 400 }] }, authority, authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(policy, nextPolicy, observers, authorityKey);
  advanced = { ...completed, communityPolicy: nextPolicy, freshness: { ...base.freshness!, installed: advance.commitment.next, observed: advance.commitment.next } };
  retired = { ...advanced, version: 9, communityPolicy: nextPolicy, entries: [], retirement: { retiredAt: 400, ...totals(advanced) } };
});
function selected(images: State[]) {
  // Build sequentially because each owner-signed header commits the previous ciphertext.
  const h = historyCheckpointFixture(), context = { ...h.context, role: 'admission-issuer' as const, authority, policyDigest: `sha256:${admissionPolicyDigest(base.communityPolicy!)}` };
  const blocks: HistoryCheckpointEnvelope[] = [];
  images.forEach((image, sequence) => blocks.push(sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence,
    previous: sequence ? historyCheckpointEnvelopeId(blocks[sequence - 1]) : null }, plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: h.key, signingKey: h.owner })));
  const rootId = historyCheckpointEnvelopeId(blocks[0]), challenge = randomBytes(32).toString('base64url'), freeze = createHistoryFreeze(context, 0, 1, challenge, h.owner);
  const receipts = h.memberKeys.slice(0, 4).map((key, i) => {
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId, generation: 0, replica: context.members[i], challenge, issuedAt: 100, expiresAt: 200, sequence: 1, envelopeId: null }, context, h.owner);
    return createHistoryExchangeResponse(request, 'frozen', { generation: 0, rootId, sequence: blocks.length - 1, envelopeId: historyCheckpointEnvelopeId(blocks.at(-1)!), freeze }, null, context, key);
  });
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation: 0, nextGeneration: 1, receipts, envelopes: blocks }, context, h.owner);
  return { context, genesisId: rootId, profile: structuredClone(profile), authority, encryptionKey: h.key, proposal, blocks, owner: h.owner, memberKeys: h.memberKeys };
}
it('replays expired historical policies and every grant/signing/retirement edge without current-policy gating', async () => {
  const result = await replayProtectedIssuerHistory(selected([base, granted, bound, prepared, completed, advanced, retired]));
  expect(result.state).toEqual(retired); expect(result.blocks).toBe(7); expect(totals(result.state)).toEqual(totals(completed));
});
it.each(['delete', 'quota', 'claim', 'rebind', 'skip-prepared', 'response-swap', 'floor', 'conflict', 'resurrection', 'combined'])(
  'rejects owner-signed selected history containing %s', async damage => {
    let images: State[] = [base, granted, bound, prepared, completed];
    if (damage === 'delete') images = [base, granted, base];
    if (damage === 'quota') {
      const { authority: _a, signature: _s, ...allocationBody } = base.allocation!.manifest;
      const allocation = await signAdmissionIssuanceAllocation({ ...allocationBody, totalTokenBudget: 1, allocations: [{ profile, batchSize: 1, maxPermits: 1 }] }, authority, authorityKey.secretKey);
      const reset = { ...base, policy: { batchSize: 1, maxPermits: 1 }, allocation: { manifest: allocation, authority, digest: admissionIssuanceAllocationDigest(allocation) } };
      await expect(parseProtectedIssuerImage(reset, { profile, authority })).resolves.toEqual(reset);
      images = [base, granted, reset];
    }
    if (damage === 'claim') {
      const handle = randomBytes(32).toString('base64url'), secret = randomBytes(32).toString('base64url');
      const { signature: _signature, ...body } = granted.entries[0].assignment!;
      const assignment = await signAdmissionClaimAssignment({ ...body, claimHandle: handle }, base.allocation!.manifest, authority, authorityKey.secretKey);
      const binding = granted.entries[0].claim!.binding;
      const reassigned = { ...granted, entries: [{ permitHash: permitHash(secret), claim: { binding, digest: claimDigest(binding, handle), secret }, assignment }] };
      await expect(parseProtectedIssuerImage(reassigned, { profile, authority })).resolves.toEqual(reassigned);
      images = [base, granted, reassigned];
    }
    if (damage === 'rebind') images = [base, granted, bound, { ...bound, entries: [{ ...bound.entries[0], batchId: 'b'.repeat(64) }] }];
    if (damage === 'skip-prepared') images = [base, granted, bound, completed];
    if (damage === 'response-swap') images[4] = { ...completed, entries: [{ ...completed.entries[0], response: { ...completed.entries[0].response!, responses: [Buffer.alloc(256, 2).toString('base64url')] } }] };
    const floor = { ...base.freshness!.observed, revision: 2, digest: 'c'.repeat(64) };
    const fenced = { ...base, freshness: { ...base.freshness!, observed: floor } };
    if (damage === 'floor') images = [base, fenced, base];
    if (damage === 'conflict') images = [base, fenced, { ...fenced, freshness: { ...fenced.freshness, conflict: { ...floor, digest: 'd'.repeat(64) } } }, fenced];
    if (damage === 'resurrection') images = [base, granted, bound, prepared, completed, advanced, retired, advanced];
    if (damage === 'combined') images = [base, { ...granted, freshness: { ...base.freshness!, observed: floor } }];
    await expect(replayProtectedIssuerHistory(selected(images))).rejects.toThrow();
  });
it.each(['missing-genesis', 'gap', 'duplicate', 'wrong-key', 'wrong-pin', 'block-bound', 'byte-bound', 'cancelled', 'minimum'])(
  'rejects %s without a partial issuer recovery image', async damage => {
    const input = selected([base, granted, bound, prepared, completed]), controller = new AbortController();
    if (damage === 'missing-genesis') input.blocks.shift();
    if (damage === 'gap') input.blocks.splice(2, 1);
    if (damage === 'duplicate') input.blocks.splice(2, 0, input.blocks[1]);
    if (damage === 'wrong-key') input.encryptionKey = randomBytes(32);
    if (damage === 'wrong-pin') input.genesisId = `sha256:${'0'.repeat(64)}`;
    if (damage === 'cancelled') controller.abort();
    await expect(replayProtectedIssuerHistory({ ...input, signal: controller.signal, ...(damage === 'block-bound' ? { maxBlocks: 4 } : {}),
      ...(damage === 'byte-bound' ? { maxBytes: 100 } : {}), ...(damage === 'minimum' ? { minimumEvidence: [retired] } : {}) })).rejects.toThrow();
  });
it('snapshots all selected inputs and exact local minimum evidence before awaiting cryptography', async () => {
  const input = selected([base, granted, bound, prepared, completed]), minimum = structuredClone(bound), key = Buffer.from(input.encryptionKey);
  const replay = replayProtectedIssuerHistory({ ...input, minimumEvidence: [minimum] });
  input.blocks.splice(0); minimum.entries.splice(0); input.profile.scope.issuer = 'mutated'; input.encryptionKey.fill(0);
  expect((await replay).state.entries[0].response).toEqual(completed.entries[0].response);
  expect(key.some(byte => byte !== 0)).toBe(true);
});
it('authenticates input snapshots before validation and accepts only immutable identity for retired states', async () => {
  const mutable = structuredClone(granted), pending = parseProtectedIssuerImage(mutable, { profile: base.profile, authority });
  mutable.entries.splice(0); expect((await pending).entries).toHaveLength(1);
  await expect(assertProtectedIssuerImageSuccessor(retired, structuredClone(retired))).resolves.toBeUndefined();
  await expect(assertProtectedIssuerImageSuccessor(retired, advanced)).rejects.toThrow('terminal');
});

function continuation(input: ReturnType<typeof selected>, phase: 'confirm' | 'prepare' = 'confirm') {
  const challenge = randomBytes(32).toString('base64url');
  const votes = input.memberKeys.slice(0, 4).map((key, i) => createHistoryAgreementVote(createHistoryAgreementRequest({
    action: phase, rootId: input.proposal.rootId, generation: 0, nextGeneration: 1, replica: input.context.members[i], view: 1,
    challenge, issuedAt: 100, expiresAt: 200, proposalId: historySuccessorProposalId(input.proposal), evidenceId: `sha256:${'a'.repeat(64)}`,
  }, input.context, input.owner), input.context, key));
  return createHistoryContinuationRoot(input.proposal, { version: 2, kind: 'history-agreement-certificate', phase: phase === 'confirm' ? 'confirmed' : 'prepared', votes }, input.context);
}
it('binds opaque reviewed restoration to both destinations, profile, context, authority and exact selected baseline', async () => {
  const input = selected([base, granted, bound, prepared, completed]), root = continuation(input);
  const directory = mkdtempSync(join(tmpdir(), 'issuer-review-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const destination = { path: join(directory, 'issuer.json'), writerDirectory: join(directory, 'writer') };
  const capability = await prepareProtectedIssuerRestore({ ...input, destination, continuation: root });
  const pins = { ...destination, context: input.context, profile: base.profile, authority };
  expect(JSON.stringify(capability.review)).not.toContain(granted.entries[0].claim!.secret);
  expect(existsSync(destination.path)).toBe(false);
  for (const invalid of [{ ...capability }, { review: structuredClone(capability.review) }]) {
    expect(() => readPreparedProtectedIssuerRestore(invalid, capability.review.approvalDigest, pins)).toThrow('reviewed');
  }
  expect(() => readPreparedProtectedIssuerRestore(capability, 'wrong', pins)).toThrow('reviewed');
  expect(() => readPreparedProtectedIssuerRestore(capability, capability.review.approvalDigest, { ...pins, path: join(directory, 'wrong') })).toThrow('reviewed');
  expect(() => readPreparedProtectedIssuerRestore(capability, capability.review.approvalDigest, { ...pins, writerDirectory: join(directory, 'wrong-writer') })).toThrow('reviewed');
  expect(() => readPreparedProtectedIssuerRestore(capability, capability.review.approvalDigest, { ...pins, authority: randomBytes(32).toString('base64url') })).toThrow('reviewed');
  const restored = readPreparedProtectedIssuerRestore(capability, capability.review.approvalDigest, pins);
  expect(restored.baseline).toEqual(completed); restored.baseline.entries.splice(0);
  expect(readPreparedProtectedIssuerRestore(capability, capability.review.approvalDigest, pins).baseline).toEqual(completed);
  writeFileSync(destination.path, 'occupied');
  expect(() => readPreparedProtectedIssuerRestore(capability, capability.review.approvalDigest, pins)).toThrow('new owner');
});
it('requires confirmed agreement for a continuation and retains caller key on cancelled generator replay', async () => {
  const input = selected([base, granted]); expect(() => continuation(input, 'prepare')).toThrow();
  const controller = new AbortController(), keyBefore = Buffer.from(input.encryptionKey); let closed = false;
  function* blocks() { try { yield input.blocks[0]; controller.abort(); yield input.blocks[1]; } finally { closed = true; } }
  await expect(replayProtectedIssuerHistory({ ...input, blocks: blocks(), signal: controller.signal })).rejects.toThrow('cancelled');
  expect(closed).toBe(true); expect(input.encryptionKey).toEqual(keyBefore);
});
