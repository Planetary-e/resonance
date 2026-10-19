import { historyOriginalPoolFixture } from '../../../relay/src/__tests__/fixtures/history-original-pool-fixture.js';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation, type AdmissionIssuanceAllocationBody, type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createHistoryFreeze, sealHistoryCheckpoint, historyCheckpointEnvelopeId, historyDigest, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryAgreementRequest, createHistoryAgreementVote } from '@resonance/core/history-agreement';
import { createHistorySuccessorProposal, historySuccessorProposalId, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { allocationAuthorityHistoryAnchor, type AdmissionAllocationAuthorityState as State } from '../admission-allocation-authority-state.js';
import { replayProtectedAllocationAuthorityHistory } from '../admission-allocation-authority-history-replay.js';
import { prepareProtectedAllocationAuthorityRestore, readPreparedProtectedAllocationAuthorityRestore } from '../admission-allocation-authority-history-restore.js';

const authorityKey = generateSigningKeyPair(), authority = Buffer.from(authorityKey.publicKey).toString('base64url');
const base: State = { version: 2, authority, manifests: [], assignments: [] };
let template: AdmissionIssuanceAllocationBody, installed: State, assigned: State;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
beforeAll(async () => {
  template = { version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1', community: 'public', epoch: 'expired', notBefore: 100, issueUntil: 200,
    totalTokenBudget: 2, allocations: [0, 1].map(index => ({ batchSize: 1, maxPermits: 1, profile: { version: 1,
      scope: { issuer: `authority-replay-${index}`, community: 'public', epoch: 'expired' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:44010/'] } })) };
  const manifest = await signAdmissionIssuanceAllocation(template, authority, authorityKey.secretKey);
  installed = { ...base, manifests: [manifest] }; assigned = { ...installed, assignments: [await assignment(manifest)] };
});
async function assignment(manifest: SignedAdmissionIssuanceAllocation, issuer = 0, handle = Buffer.alloc(32, 1).toString('base64url')) {
  return signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority, allocationDigest: admissionIssuanceAllocationDigest(manifest),
    community: 'public', epoch: manifest.epoch, claimHandle: handle, issuerKeyFingerprint: admissionKeyFingerprint(manifest.allocations[issuer].profile.issuerPublicKey) }, manifest, authority, authorityKey.secretKey);
}
function selected(images: State[]) {
  const h = historyCheckpointFixture(), context = { ...h.context, role: 'admission-allocation-authority' as const, authority, policyDigest: allocationAuthorityHistoryAnchor(authority) };
  const blocks: HistoryCheckpointEnvelope[] = [];
  images.forEach((image, sequence) => blocks.push(sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence,
    previous: sequence ? historyCheckpointEnvelopeId(blocks[sequence - 1]) : null }, plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: h.key, signingKey: h.owner })));
  function proposal(generationBlocks: HistoryCheckpointEnvelope[]) {
    const first = generationBlocks[0], head = generationBlocks.at(-1)!, rootId = historyCheckpointEnvelopeId(first), generation = first.generation;
    const challenge = randomBytes(32).toString('base64url'), freeze = createHistoryFreeze(context, generation, generation + 1, challenge, h.owner);
    const receipts = h.memberKeys.slice(0, 4).map((key, i) => {
      const request = createHistoryExchangeRequest({ action: 'freeze', rootId, generation, replica: context.members[i], challenge, issuedAt: 100, expiresAt: 200, sequence: generation + 1, envelopeId: null }, context, h.owner);
      return createHistoryExchangeResponse(request, 'frozen', { generation, rootId, sequence: head.sequence, envelopeId: historyCheckpointEnvelopeId(head), freeze }, null, context, key);
    });
    return createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation, nextGeneration: generation + 1, receipts, envelopes: generationBlocks }, context, h.owner);
  }
  function continuation(p: HistorySuccessorProposal, phase: 'confirm' | 'prepare' = 'confirm') {
    const challenge = randomBytes(32).toString('base64url');
    const votes = h.memberKeys.slice(0, 4).map((key, i) => createHistoryAgreementVote(createHistoryAgreementRequest({ action: phase,
      rootId: p.rootId, generation: p.generation, nextGeneration: p.nextGeneration, replica: context.members[i], view: 1, challenge,
      issuedAt: 100, expiresAt: 200, proposalId: historySuccessorProposalId(p), evidenceId: `sha256:${'a'.repeat(64)}` }, context, h.owner), context, key));
    return createHistoryContinuationRoot(p, { version: 2, kind: 'history-agreement-certificate', phase: phase === 'confirm' ? 'confirmed' : 'prepared', votes }, context);
  }
  const p = proposal(blocks);
  return { context, genesisId: historyCheckpointEnvelopeId(blocks[0]), authority, encryptionKey: h.key, proposal: p, blocks, proposalFor: proposal, continuation, owner: h.owner, memberKeys: h.memberKeys,
    checkpoint(image: State, previous: HistoryCheckpointEnvelope) { return sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: previous.generation,
      sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous) }, plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: h.key, signingKey: h.owner }); } };
}
function destination() {
  const directory = mkdtempSync(join(tmpdir(), 'allocation-review-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return { path: join(directory, 'authority.json'), writerDirectory: join(directory, 'writer'), directory };
}
it('replays expired signed allocations and assignments through complete confirmed generation ancestry', async () => {
  const input = selected([base, installed]), root = input.continuation(input.proposal), next = input.checkpoint(assigned, root);
  const p = input.proposalFor([root, next]);
  const result = await replayProtectedAllocationAuthorityHistory({ ...input, proposal: p, blocks: [...input.blocks, root, next], minimumEvidence: [installed, assigned] });
  expect(result.state).toEqual(assigned); expect(result.generations).toBe(2); expect(result.blocks).toBe(4);
  expect(result.replayDigest).toBe(historyDigest(`resonance:admission-allocation-authority-replay:v1\n${JSON.stringify([result.contextId, result.genesisId, result.proposalId, assigned])}`));
  expect(result.head).toMatchObject({ rootId: historyCheckpointEnvelopeId(root), generation: 1, sequence: 1 });
  await expect(replayProtectedAllocationAuthorityHistory({ ...input, proposal: p, blocks: [root, next] })).rejects.toThrow('genesis');
  await expect(replayProtectedAllocationAuthorityHistory({ ...input, proposal: p, blocks: [input.blocks[0], root, next] })).rejects.toThrow('page boundary');
  const forged = structuredClone(root); forged.certificate.votes[0].signature = Buffer.alloc(64).toString('base64url');
  await expect(replayProtectedAllocationAuthorityHistory({ ...input, proposal: p, blocks: [...input.blocks, forged, next] })).rejects.toThrow();
  expect(() => input.continuation(input.proposal, 'prepare')).toThrow();
});
it.each(['delete', 'reassign', 'rewrite-plan', 'combined', 'quota', 'duplicate-claim', 'wrong-signature', 'wrong-allocation', 'v1-genesis', 'nonempty-genesis'])(
  'rejects owner-signed selected snapshots containing %s', async damage => {
    let images: State[] = [base, installed, assigned];
    const manifest = installed.manifests[0];
    if (damage === 'delete') images.push(installed);
    if (damage === 'reassign') images.push({ ...assigned, version: 2, assignments: [await assignment(manifest, 1)] });
    if (damage === 'rewrite-plan') {
      const altered = await signAdmissionIssuanceAllocation({ ...template, totalTokenBudget: 3 }, authority, authorityKey.secretKey);
      images = [base, installed, { ...base, manifests: [altered] }];
    }
    if (damage === 'combined') images = [base, assigned];
    if (damage === 'quota') images.push({ ...assigned, version: 2, assignments: [...(assigned.version === 2 ? assigned.assignments : []), await assignment(manifest, 0, Buffer.alloc(32, 2).toString('base64url'))] });
    if (damage === 'duplicate-claim') images.push({ ...assigned, version: 2, assignments: [...(assigned.version === 2 ? assigned.assignments : []), await assignment(manifest, 1)] });
    if (damage === 'wrong-signature' || damage === 'wrong-allocation') {
      const damaged = structuredClone(assigned); if (damaged.version !== 2) throw new Error('fixture');
      if (damage === 'wrong-signature') damaged.assignments[0].signature = Buffer.alloc(64).toString('base64url');
      else damaged.assignments[0].allocationDigest = `sha256:${'0'.repeat(64)}`;
      images[2] = damaged;
    }
    if (damage === 'v1-genesis') images = [{ version: 1, authority, manifests: [] }, installed];
    if (damage === 'nonempty-genesis') images = [installed, assigned];
    await expect(replayProtectedAllocationAuthorityHistory(selected(images))).rejects.toThrow();
  });
it.each(['gap', 'duplicate', 'wrong-key', 'wrong-genesis', 'wrong-anchor', 'blocks', 'bytes', 'cancelled', 'minimum'])(
  'rejects %s without returning partial recovery state', async damage => {
    const input = selected([base, installed, assigned]), controller = new AbortController();
    if (damage === 'gap') input.blocks.splice(1, 1);
    if (damage === 'duplicate') input.blocks.splice(1, 0, input.blocks[0]);
    if (damage === 'wrong-key') input.encryptionKey = randomBytes(32);
    if (damage === 'wrong-genesis') input.genesisId = `sha256:${'0'.repeat(64)}`;
    if (damage === 'cancelled') controller.abort();
    if (damage === 'wrong-anchor') input.context.policyDigest = `sha256:${'0'.repeat(64)}`;
    const absent = { ...assigned, version: 2 as const, assignments: [await assignment(installed.manifests[0], 1)] };
    await expect(replayProtectedAllocationAuthorityHistory({ ...input, signal: controller.signal, ...(damage === 'blocks' ? { maxBlocks: 2 } : {}),
      ...(damage === 'bytes' ? { maxBytes: 100 } : {}), ...(damage === 'minimum' ? { minimumEvidence: [absent] } : {}) })).rejects.toThrow();
  });
it('snapshots blocks, pins, key and exact minimum evidence before awaiting and closes a cancelled iterable', async () => {
  const input = selected([base, installed, assigned]), evidence = structuredClone(installed), context = structuredClone(input.context), originalKey = Buffer.from(input.encryptionKey);
  const replay = replayProtectedAllocationAuthorityHistory({ ...input, minimumEvidence: [evidence] });
  input.blocks.splice(0); evidence.manifests.splice(0); input.context.authority = Buffer.alloc(32).toString('base64url'); input.encryptionKey.fill(0);
  expect((await replay).state).toEqual(assigned);
  const second = selected([base, installed]), controller = new AbortController(); let closed = false;
  function* blocks() { try { yield second.blocks[0]; controller.abort(); yield second.blocks[1]; } finally { closed = true; } }
  await expect(replayProtectedAllocationAuthorityHistory({ ...second, blocks: blocks(), signal: controller.signal })).rejects.toThrow('cancelled');
  expect(closed).toBe(true); expect(second.encryptionKey.some(byte => byte !== 0)).toBe(true); expect(context.authority).toBe(authority); expect(originalKey.some(byte => byte !== 0)).toBe(true);
});
it('binds opaque restore review to selected history, authority and both empty canonical destinations', async () => {
  const input = selected([base, installed, assigned]), target = destination(), root = input.continuation(input.proposal);
  const capability = await prepareProtectedAllocationAuthorityRestore({ ...input, destination: target, continuation: root });
  const pins = { ...target, context: input.context, authority }, digest = capability.review.approvalDigest;
  expect(existsSync(target.path)).toBe(false); expect(capability.review).toMatchObject({ manifests: 1, assignments: 1, generation: 1 });
  for (const invalid of [structuredClone(capability), { review: capability.review }]) expect(() => readPreparedProtectedAllocationAuthorityRestore(invalid, digest, pins)).toThrow('reviewed');
  expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, 'wrong', pins)).toThrow('reviewed');
  expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, digest, { ...pins, path: join(target.directory, 'other') })).toThrow('reviewed');
  expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, digest, { ...pins, writerDirectory: join(target.directory, 'other') })).toThrow('reviewed');
  expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, digest, { ...pins, authority: Buffer.alloc(32).toString('base64url') })).toThrow('reviewed');
  expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, digest, { ...pins, context: selected([base]).context })).toThrow('reviewed');
  const restored = readPreparedProtectedAllocationAuthorityRestore(capability, digest, pins); restored.baseline.manifests.splice(0);
  expect(readPreparedProtectedAllocationAuthorityRestore(capability, digest, pins).baseline).toEqual(assigned);
  writeFileSync(target.path, 'occupied'); expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, digest, pins)).toThrow('new owner');
});
it('refuses occupied destinations and cancelled preparation without creating owner state', async () => {
  const input = selected([base, installed, assigned]), target = destination(), continuation = input.continuation(input.proposal);
  mkdirSync(target.writerDirectory); writeFileSync(join(target.writerDirectory, 'retained'), 'do not overwrite');
  await expect(prepareProtectedAllocationAuthorityRestore({ ...input, destination: target, continuation })).rejects.toThrow('empty writer');
  rmSync(target.writerDirectory, { recursive: true }); const controller = new AbortController(); controller.abort();
  await expect(prepareProtectedAllocationAuthorityRestore({ ...input, destination: target, continuation, signal: controller.signal })).rejects.toThrow('cancelled');
  expect(existsSync(target.path)).toBe(false); expect(existsSync(target.writerDirectory)).toBe(false);
});
it.skipIf(process.platform === 'win32')('rejects destination-parent retargeting after review', async () => {
  const input = selected([base, installed, assigned]), target = destination(), a = join(target.directory, 'a'), b = join(target.directory, 'b'), link = join(target.directory, 'link');
  mkdirSync(a); mkdirSync(b); symlinkSync(a, link, 'dir');
  const paths = { path: join(link, 'authority.json'), writerDirectory: join(link, 'writer') };
  const capability = await prepareProtectedAllocationAuthorityRestore({ ...input, destination: paths, continuation: input.continuation(input.proposal) });
  unlinkSync(link); symlinkSync(b, link, 'dir');
  expect(() => readPreparedProtectedAllocationAuthorityRestore(capability, capability.review.approvalDigest, { ...paths, context: input.context, authority })).toThrow('reviewed');
});

it('retains signed allocations and assignment denials through100 real pooled recoveries and101-generation reopen', async () => {
  const input = selected([base]), started = performance.now();
  const n = historyOriginalPoolFixture({ context: input.context, root: input.blocks[0], encryptionKey: input.encryptionKey, owner: input.owner, memberKeys: input.memberKeys }); cleanup.push(n.close);
  let finalProposal = input.proposal;
  for (let generation = 0; generation <= 100; generation++) {
    if (generation === 1) n.append(installed);
    if (generation === 64) n.append(assigned);
    const proposal = n.select(); finalProposal = proposal;
    if (generation === 64 || generation === 100) {
      n.reopen(); writeFileSync(`/tmp/resonance-original-pool-authority-${generation+1}.json`, JSON.stringify(n.measurement(), null, 2)); const result = await replayProtectedAllocationAuthorityHistory({ ...input, proposal, blocks: n.blocks(), minimumEvidence: [installed, assigned] });
      expect(result.generations).toBe(generation + 1); expect(result.state).toEqual(assigned);
      expect(result.state.manifests).toEqual([installed.manifests[0]]);
      if (result.state.version !== 2) throw new Error('expected assignment state');
      expect(result.state.assignments).toEqual(assigned.version === 2 ? assigned.assignments : []);
    }
    if (generation < 100) n.rotate(proposal);
  }
  const blocks = n.blocks(), boundary = blocks.findIndex(b => b.generation === 64);
  for (const damage of ['gap', 'reorder', 'blocks', 'bytes']) {
    const altered = [...blocks]; if (damage === 'gap') altered.splice(boundary, 1);
    if (damage === 'reorder') [altered[boundary - 1], altered[boundary]] = [altered[boundary], altered[boundary - 1]];
    await expect(replayProtectedAllocationAuthorityHistory({ ...input, proposal: finalProposal, blocks: altered,
      ...(damage === 'blocks' ? { maxBlocks: boundary + 1 } : {}), ...(damage === 'bytes' ? { maxBytes: blocks.slice(0, boundary + 1).reduce((n, b) => n + Buffer.byteLength(JSON.stringify(b)), 0) } : {}) })).rejects.toThrow();
  }
  const measured = { role: 'admission-allocation-authority', durationMs: performance.now() - started, ...n.measurement() };
  writeFileSync('/tmp/resonance-original-pool-authority.json', JSON.stringify(measured, null, 2));
  expect(measured.pools.every(p => p!.pages === 2 && p!.peakBytes <= 256 * 1024 * 1024)).toBe(true);
}, 300000);
