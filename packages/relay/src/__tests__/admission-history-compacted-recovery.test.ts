import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { createHistoryFrontierResponse, parseHistoryFrontierRequest } from '@resonance/core/history-frontier';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { ADMISSION_RECOVERY_FILENAME, openAdmissionHistoryRecovery, prepareAdmissionHistoryRecovery } from '../admission-history-recovery.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { createHistoryGenerationReplica } from '../history-generation-provisioner.js';
import { listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { encodeAdmissionHistoryRecord, reduceAdmissionHistory } from '../admission-history-records.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(ancestor = false, checkpointSequence = 2) {
  const n = await admissionRestoreFixture(false, (image, at) => ({ version: 1, kind: 'admission-state-checkpoint', image, at }));
  cleanup.push(n.close);
  const current = n.continuation(), later = { ...n.currentRow, spend: randomBytes(32).toString('base64url') };
  const partial = { ...n.currentRow, spend: randomBytes(32).toString('base64url') }, at = n.time + 10000;
  const deltaRecord = { version: 1 as const, kind: 'spend' as const, at, row: later };
  const delta = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
    header: { kind: 'delta', generation: 1, sequence: 1, previous: historyCheckpointEnvelopeId(current) }, plaintext: encodeAdmissionHistoryRecord(deltaRecord) });
  const image = (await reduceAdmissionHistory(n.image, deltaRecord)).image;
  const checkpoint = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
    header: { kind: 'checkpoint', generation: 1, sequence: checkpointSequence,
      previous: checkpointSequence === 2 ? historyCheckpointEnvelopeId(delta) : historyDigest('omitted immediate predecessor') },
    plaintext: encodeAdmissionHistoryRecord({ version: 1, kind: 'admission-state-checkpoint', image, at }) });
  const tail = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
    header: { kind: 'delta', generation: 1, sequence: checkpointSequence + 1, previous: historyCheckpointEnvelopeId(checkpoint) },
    plaintext: encodeAdmissionHistoryRecord({ version: 1, kind: 'spend', row: partial, at }) });
  const anchor = ancestor ? n.generations[0][0].read().envelopes.at(-1)! : checkpoint;
  const genesisId = historyCheckpointEnvelopeId(n.root), issuedAt = Date.now();
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: ancestor ? genesisId : historyCheckpointEnvelopeId(current),
    checkpoint: anchor, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const certificate = { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, genesisId, key, issuedAt)) };
  for (const store of n.generations[1].slice(0, 4)) {
    store.append(delta);
    // A signed checkpoint seeds a distant history without manufacturing a billion payloads.
    // This tests bounded storage/transport/recovery, not the cost of those omitted writes.
    if (checkpointSequence === 2) store.append(checkpoint);
    else store.installCheckpoint(checkpoint, certificate, store.reviewDigest());
  }
  n.generations[1][0].append(tail);
  if (!ancestor) for (const store of n.generations[1].slice(0, 4)) {
    store.retainCompactionAnchor(certificate, store.reviewDigest());
    expect(store.retirePrefix(store.planPrefixRetirement().approvalDigest).filesRemoved).toBe(1);
    expect(store.envelopeAt(delta.sequence)).toBeNull();
  }
  const roles = n.context.members.map((_, i) => createHistoryGenerationReplica({ directory: join(n.directory, `new-slot-${i}`),
    localKey: n.localKey, context: n.context, signingKey: n.memberKeys[i], parent: n.generations[1][i],
    ancestors: [n.generations[0][i]], initialize: true })); cleanup.push(() => roles.forEach(r => r.close()));
  let online = new Set([0, 1, 2, 4]), calls = 0;
  const reads: Array<[number, number]> = [], continuationReads: number[] = [];
  const omitted = (generation: number, sequence: number) => generation < anchor.generation || (generation === anchor.generation && sequence < anchor.sequence);
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryAgreementReplica({ ...roles[i],
      compaction(raw) {
        calls++; if (!online.has(i)) throw new Error('Offline replica');
        const request = parseHistoryFrontierRequest(raw, n.context, genesisId, Date.now());
        return createHistoryFrontierResponse(request, n.generations[anchor.generation][i].compactionAnchor(), n.context, n.memberKeys[i]);
      },
      checkpoint(raw) {
        calls++; if (!online.has(i)) throw new Error('Offline replica');
        const request = (raw as { request: { action: string; generation: number; sequence: number } }).request;
        if (request.action === 'continuation') {
          continuationReads.push(request.generation);
          if (request.generation < anchor.generation) throw new Error('Retired generation routing unavailable');
        }
        if (request.action === 'read') {
          reads.push([request.generation, request.sequence]);
          if (omitted(request.generation, request.sequence)) throw new Error('Omitted history unavailable');
        }
        return roles[i].checkpoint(raw);
      },
      exchange(raw) { calls++; if (!online.has(i)) throw new Error('Offline replica'); return roles[i].exchange(raw); },
      transfer(raw) {
        calls++; if (!online.has(i)) throw new Error('Offline replica');
        const frame = raw as { action: string; sequence: number; authorization: { request: { generation: number } } };
        if (frame.action === 'read' && omitted(frame.authorization.request.generation, frame.sequence)) throw new Error('Omitted transfer history unavailable');
        return roles[i].transfer(raw);
      },
      provision(raw) { calls++; if (!online.has(i)) throw new Error('Offline replica'); return roles[i].provision(raw); },
    }); cleanup.push(listener.close); n.members[i].endpoint = listener.checkpointEndpoint;
  }
  const options = { directory: join(n.directory, 'compacted-workflow'), encryptionKey: n.key, genesis: n.root, compaction: certificate,
    protection: { context: n.context, signingKey: n.owner, members: n.members } };
  return { ...n, options, certificate, anchor, delta, checkpoint, tail, later, partial, reads, continuationReads, calls: () => calls,
    online: (members: number[]) => { online = new Set(members); } };
}

describe('composed compacted admission recovery', { timeout: 60000 }, () => {
  it('binds a persisted shortened discovery anchor while reopening older complete-chain workspaces offline', async () => {
    const n = await fixture(), review = await prepareAdmissionHistoryRecovery(n.options);
    const initial = await openAdmissionHistoryRecovery({ ...n.options, initialize: { review, approvedDigest: review.approvalDigest } });
    initial.close();
    const path = join(n.options.directory, ADMISSION_RECOVERY_FILENAME);
    const journal = () => openEncryptedLocalState<any>({ path, key: n.key, domain: 'resonance:admission-recovery:v1',
      maxBytes: 4 * 1024 * 1024, mode: 'open-existing', initial: null, validate: (_value): _value is any => true });
    let storage = journal(); const saved = storage.read(); storage.close();
    expect(saved.anchor).toEqual({ rootId: n.certificate.proposal.rootId, generation: 1 }); expect(saved.chain).toEqual([]);
    for (const anchor of [{ ...saved.anchor, rootId: historyDigest('foreign root') }, { ...saved.anchor, generation: 2 },
      { ...saved.anchor, permission: true }, null]) {
      storage = journal(); storage.write({ ...saved, anchor }); storage.close(); const before = readFileSync(path), calls = n.calls();
      await expect(openAdmissionHistoryRecovery(n.options)).rejects.toThrow('state is invalid');
      expect(readFileSync(path)).toEqual(before); expect(n.calls()).toBe(calls);
    }
    const { anchor: _anchor, ...legacy } = saved;
    storage = journal(); storage.write({ ...legacy, chain: [n.continuation()] }); storage.close();
    const before = readFileSync(path), calls = n.calls(), reopened = await openAdmissionHistoryRecovery(n.options); cleanup.push(reopened.close);
    expect(reopened.status()).toMatchObject({ generation: 1, phase: 'freeze' });
    expect(readFileSync(path)).toEqual(before); expect(n.calls()).toBe(calls);
  });

  it.each([[false, 2], [true, 2], [false, 1_000_000_000]] as const)('recovers, repairs, activates and restores through real sockets with ancestor anchor=%s and checkpoint=%i', async (ancestor, checkpointSequence) => {
    const n = await fixture(ancestor, checkpointSequence), review = await prepareAdmissionHistoryRecovery(n.options);
    expect(n.continuationReads.length).toBeGreaterThanOrEqual(4);
    expect(n.continuationReads.every(generation => generation >= n.anchor.generation)).toBe(true);
    expect(review.compactionId).toMatch(/^sha256:/);
    let recovery = await openAdmissionHistoryRecovery({ ...n.options, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
    for (let steps = 0; steps < 20 && !recovery.status().complete; steps++) {
      await recovery.advance({ maxBlocks: 1 }); const before = n.calls(), status = recovery.status(); recovery.close();
      recovery = await openAdmissionHistoryRecovery(n.options); cleanup.push(recovery.close);
      expect(recovery.status()).toEqual(status); expect(n.calls()).toBe(before);
    }
    expect(recovery.status().complete).toBe(true);
    expect(n.reads.every(([g, s]) => g > n.anchor.generation || (g === n.anchor.generation && s >= n.anchor.sequence))).toBe(true);
    expect(n.generations[1][4].describe().sequence).toBe(n.tail.sequence);
    expect(n.generations[1][4].activatedContinuation()?.generation).toBe(2);
    expect(n.generations[1][4].envelopeAt(1)).toEqual(ancestor ? n.delta : null);
    const destination = join(n.directory, 'compacted-owner'), before = n.calls();
    const preparation = await recovery.reviewRestore(destination, n.policy); expect(n.calls()).toBe(before);
    expect(preparation.review.spends).toBe(4); expect(preparation.review.permanentDenials).toBe(1);
    const history = await openProtectedAdmissionSpendHistory({ directory: destination, authority: n.context.authority,
      encryptionKey: n.key, policy: n.policy, initialize: true, now: () => n.time + 10000,
      protection: { ...n.options.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
    cleanup.push(history.close);
    n.online([0, 1, 2]); await expect(history.ready()).rejects.toThrow('Four');
    n.online([0, 1, 2, 4]); await history.ready();
    expect(history.get(n.later.spend)).toEqual(n.later); expect(history.get(n.partial.spend)).toEqual(n.partial);
    expect(history.get(n.legacy.spend)).toEqual(n.legacy); expect(history.isRetired(n.oldKey)).toBe(true); history.close();
    const beforeInspection = n.calls(), readiness = await recovery.reviewReadiness(destination, n.policy); cleanup.push(readiness.close);
    expect(n.calls()).toBe(beforeInspection);
  });

  it('binds freeze approval and every reopened phase to the exact independently provided proof', async () => {
    const n = await fixture(), review = await prepareAdmissionHistoryRecovery(n.options);
    const alternate = { ...n.certificate, votes: n.memberKeys.slice(1).map(key =>
      createHistoryCompactionVote(n.certificate.proposal, n.context, n.certificate.proposal.genesisId, key, n.certificate.proposal.issuedAt)) };
    const before = n.calls();
    await expect(openAdmissionHistoryRecovery({ ...n.options, compaction: alternate,
      initialize: { review, approvedDigest: review.approvalDigest } })).rejects.toThrow('reviewed approval');
    expect(existsSync(n.options.directory)).toBe(false); expect(n.calls()).toBe(before);
    const recovery = await openAdmissionHistoryRecovery({ ...n.options, initialize: { review, approvedDigest: review.approvalDigest } });
    cleanup.push(recovery.close); await recovery.advance(); recovery.close(); const calls = n.calls();
    await expect(openAdmissionHistoryRecovery({ ...n.options, compaction: undefined })).rejects.toThrow('state is invalid');
    await expect(openAdmissionHistoryRecovery({ ...n.options, compaction: alternate })).rejects.toThrow('state is invalid');
    expect(n.calls()).toBe(calls);
    const reopened = await openAdmissionHistoryRecovery(n.options); cleanup.push(reopened.close);
    expect(reopened.status().phase).toBe('select'); expect(n.calls()).toBe(calls);
  });

  it('runs explicit proof selection through the real CLI from review to restored readiness', async () => {
    const n = await fixture(), script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url));
    const certificateFile = join(n.directory, 'checkpoint-proof.json'), keyFile = join(n.directory, 'owner-storage.hex');
    const ownerFile = join(n.directory, 'owner-private.json'), configFile = join(n.directory, 'owner-config.json');
    const enrollmentFile = join(n.directory, 'enrollment.json'), policyFile = join(n.directory, 'policy.json');
    writeFileSync(keyFile, n.key.toString('hex'), { mode: 0o600 });
    writeFileSync(ownerFile, JSON.stringify({ publicKey: Buffer.from(n.owner.publicKey).toString('base64url'),
      secretKey: Buffer.from(n.owner.secretKey).toString('base64url') }), { mode: 0o600 });
    writeFileSync(configFile, JSON.stringify({ version: 1, context: n.context, ownerKeyFile: ownerFile, members: n.members }));
    writeFileSync(enrollmentFile, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.root }));
    writeFileSync(policyFile, JSON.stringify(n.policy));
    const args = [configFile, enrollmentFile, keyFile, n.options.directory], proofArgs = ['--checkpoint-proof', certificateFile, ...args];
    function command(...args: string[]) {
      return new Promise<{ code: number | string; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, ['--import', 'tsx', script, ...args], { timeout: 30000, maxBuffer: 65536 },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
      });
    }
    async function succeed(...args: string[]) {
      const result = await command(...args); expect(result.stderr).toBe(''); expect(result.code).toBe(0); return JSON.parse(result.stdout);
    }
    // The owner has only its original enrollment and keys. Locate the retained
    // checkpoint before pinning that exact file for every recovery phase.
    const found = await succeed('owner-checkpoint-discover', configFile, enrollmentFile, certificateFile);
    expect(found).toMatchObject({ result: 'checkpoint-proof-discovered', generation: 1, observations: 4, admissionReadiness: 'unverified' });
    expect(JSON.parse(readFileSync(certificateFile, 'utf8'))).toEqual(n.certificate);
    const saved = readFileSync(certificateFile), beforeDiscoveryRetry = n.calls();
    expect((await command('owner-checkpoint-discover', configFile, enrollmentFile, certificateFile)).code).not.toBe(0);
    expect(readFileSync(certificateFile)).toEqual(saved); expect(n.calls()).toBe(beforeDiscoveryRetry);
    const plan = await succeed('owner-recovery-plan', ...proofArgs, '1'); expect(plan.compactionId).toMatch(/^sha256:/);
    expect((await command('owner-recovery-start', '--approve', 'wrong', ...proofArgs, '1')).code).not.toBe(0);
    expect(existsSync(n.options.directory)).toBe(false);
    await succeed('owner-recovery-start', '--approve', plan.approvalDigest, ...proofArgs, '1');
    const calls = n.calls(); expect((await command('owner-recovery-status', ...args)).code).not.toBe(0); expect(n.calls()).toBe(calls);
    let status = await succeed('owner-recovery-status', ...proofArgs);
    for (let step = 0; step < 10 && !status.complete; step++) status = await succeed('owner-recovery-step', ...proofArgs);
    expect(status.complete).toBe(true);
    const destination = join(n.directory, 'cli-restored-owner'), review = await succeed('owner-recovery-review', ...proofArgs, policyFile, destination);
    expect(review.spends).toBe(4); expect(review.permanentDenials).toBe(1);
    expect(await succeed('owner-recovery-restore', '--approve', review.approvalDigest, ...proofArgs, policyFile, destination))
      .toMatchObject({ result: 'history-restored', generation: 2, readiness: 'confirmed' });
    const beforeReadiness = n.calls(); await succeed('owner-recovery-readiness-plan', ...proofArgs, policyFile, destination);
    expect(n.calls()).toBe(beforeReadiness);
  });
});
