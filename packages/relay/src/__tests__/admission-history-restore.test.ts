import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { replayAdmissionHistory } from '../admission-history-replay.js';
import { prepareAdmissionHistoryRestore } from '../admission-history-restore.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { openAdmissionSpendHistory } from '../admission-spend-history.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { encodeAdmissionHistoryRecord } from '../admission-history-records.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(...args: Parameters<typeof admissionRestoreFixture>) {
  const n = await admissionRestoreFixture(...args); cleanup.push(() => n.close()); return n;
}
function options(n: Awaited<ReturnType<typeof fixture>>, directory = n.restoreOptions().directory) {
  return { directory, authority: n.context.authority, policy: n.policy, encryptionKey: n.key, now: () => n.time + 10000,
    protection: { context: n.context, signingKey: n.owner, members: n.members, transport: n.transport, timeoutMs: 30000 } };
}
async function initialize(n: Awaited<ReturnType<typeof fixture>>, directory?: string) {
  const input = options(n, directory), preparation = await prepareAdmissionHistoryRestore(n.restoreOptions(input.directory));
  const history = await openProtectedAdmissionSpendHistory({ ...input, initialize: true, protection: { ...input.protection,
    initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  cleanup.push(() => history.close()); return { history, input, preparation };
}

it('reconstructs all authenticated policy, known/unknown spends and irreversible denials without network traffic', async () => {
  const n = await fixture(), before = n.calls(), result = await replayAdmissionHistory(n.replayOptions());
  expect(result.image).toEqual(n.image); expect(result.blocks).toBe(5); expect(result.generations).toBe(1);
  expect(result.head.envelopeId).toBe(n.continuation().proposal.envelopeId); expect(n.calls()).toBe(before);
  expect(result.image.state.spends).toEqual([n.legacy, n.currentRow]); expect(result.image.state.retiredIssuerKeys).toEqual([n.oldKey]);
});
it.each(['missing-genesis', 'missing-middle', 'duplicate', 'reordered', 'extra', 'wrong-key', 'wrong-pin', 'blocks', 'bytes', 'cancelled'])(
  'refuses %s replay without returning a partial recovery image', async damage => {
    const n = await fixture(), input = n.replayOptions();
    if (damage === 'missing-genesis') input.blocks.shift();
    if (damage === 'missing-middle') input.blocks.splice(1, 1);
    if (damage === 'duplicate') input.blocks.splice(1, 0, input.blocks[0]);
    if (damage === 'reordered') [input.blocks[1], input.blocks[2]] = [input.blocks[2], input.blocks[1]];
    if (damage === 'extra') input.blocks.push(input.blocks.at(-1)!);
    if (damage === 'wrong-key') input.encryptionKey = randomBytes(32);
    if (damage === 'wrong-pin') input.genesisId = `sha256:${'0'.repeat(64)}`;
    const controller = new AbortController(); if (damage === 'cancelled') controller.abort();
    await expect(replayAdmissionHistory({ ...input, signal: controller.signal,
      ...(damage === 'blocks' ? { maxBlocks: 4 } : {}), ...(damage === 'bytes' ? { maxBytes: 100 } : {}) })).rejects.toThrow();
  },
);
it.each(['unknown-record', 'erased-spends', 'erased-denials'])(
  'rejects %s even with valid owner signatures and a four-member selected head', async damage => {
    const n = await fixture(false, (image, at) => {
      if (damage === 'unknown-record') return { version: 1, kind: 'reset', at };
      if (damage === 'erased-spends') image.state.spends = [];
      else image.state.retiredIssuerKeys = [];
      return { version: 1, kind: 'admission-policy-checkpoint', at, image };
    });
    await expect(replayAdmissionHistory(n.replayOptions())).rejects.toThrow(/mutation|preserve/);
  },
);
it('binds review to exact destination/policy/context and rejects fabricated approval capabilities before creating history', async () => {
  const n = await fixture(), input = options(n), preparation = await prepareAdmissionHistoryRestore(n.restoreOptions());
  expect(JSON.stringify(preparation.review)).not.toContain(n.currentRow.spend);
  for (const restore of [
    { preparation, approvedDigest: 'unreviewed' },
    { preparation: structuredClone(preparation), approvedDigest: preparation.review.approvalDigest },
  ]) await expect(openProtectedAdmissionSpendHistory({ ...input, initialize: true, protection: { ...input.protection, initializeWriter: true, restore } })).rejects.toThrow('reviewed');
  await expect(openProtectedAdmissionSpendHistory({ ...input, directory: join(n.directory, 'different'), initialize: true,
    protection: { ...input.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } })).rejects.toThrow('reviewed');
  expect(existsSync(join(input.directory, 'admission-spends-v2.jsonl'))).toBe(false);
});
it('closes its source and retains the caller key on cancellation during semantic reconstruction', async () => {
  const n = await fixture(), controller = new AbortController(), before = Buffer.from(n.key); let returned = false;
  function* source() {
    try { yield n.root; controller.abort(); yield n.replayOptions().blocks[1]; }
    finally { returned = true; }
  }
  await expect(replayAdmissionHistory({ ...n.replayOptions(), blocks: source(), signal: controller.signal })).rejects.toThrow('cancelled');
  expect(returned).toBe(true); expect(n.key).toEqual(before);
});
it('requires four fresh root writes before serving a reviewed restored image and fences local-only readers', async () => {
  const n = await fixture(), { history, input } = await initialize(n); n.online(3);
  expect(history.read().version).toBe(4); expect(history.read().image).toEqual(n.image);
  expect(() => history.size()).toThrow('readiness'); await expect(history.ready()).rejects.toThrow('Four'); history.close();
  expect(() => openAdmissionSpendHistory(input)).toThrow('state is invalid');
  const reopened = await openProtectedAdmissionSpendHistory(input); cleanup.push(() => reopened.close());
  n.online(4); await reopened.ready(); expect(reopened.get(n.currentRow.spend)).toEqual(n.currentRow);
  expect(reopened.get(n.legacy.spend)).toEqual(n.legacy); expect(reopened.isRetired(n.oldKey)).toBe(true);
  expect(reopened.read().applied?.id).toBe(historyCheckpointEnvelopeId(n.continuation()));
});
it('rejects prefix acknowledgements when a competing writer advances after the readiness head check', async () => {
  const n = await fixture(), input = options(n), preparation = await prepareAdmissionHistoryRestore(n.restoreOptions());
  const root = n.continuation(), delta = sealHistoryCheckpoint({ context: n.context, header: { kind: 'delta', generation: 1, sequence: 1,
    previous: historyCheckpointEnvelopeId(root) }, plaintext: encodeAdmissionHistoryRecord({ version: 1, kind: 'spend', at: n.time + 10000,
      row: { ...n.currentRow, spend: randomBytes(32).toString('base64url') } }), encryptionKey: n.key, signingKey: n.owner });
  let raced = false;
  const history = await openProtectedAdmissionSpendHistory({ ...input, initialize: true, protection: { ...input.protection, initializeWriter: true,
    restore: { preparation, approvedDigest: preparation.review.approvalDigest }, transport: async (member, frame, signal) => {
      if (frame.request.action === 'append' && !raced) { raced = true; n.generations[1].forEach(store => store.append(delta)); }
      return n.transport(member, frame, signal);
    } } }); cleanup.push(() => history.close());
  await expect(history.ready()).rejects.toThrow('Four'); expect(raced).toBe(true); expect(history.read().applied).toBeNull();
  expect(() => history.get(n.currentRow.spend)).toThrow('readiness');
});
it('refuses a coherent older owner backup before even an exact replay can be served', async () => {
  const n = await fixture(), { history, input } = await initialize(n); await history.ready(); history.close();
  const backup = join(n.directory, 'backup'); cpSync(input.directory, backup, { recursive: true });
  let h = await openProtectedAdmissionSpendHistory(input); await h.ready();
  await h.write({ ...n.currentRow, spend: randomBytes(32).toString('base64url') }); h.close();
  rmSync(input.directory, { recursive: true }); cpSync(backup, input.directory, { recursive: true });
  h = await openProtectedAdmissionSpendHistory(input); cleanup.push(() => h.close());
  expect(() => h.get(n.currentRow.spend)).toThrow('readiness'); await expect(h.ready()).rejects.toThrow('Four');
  expect(h.read().applied?.sequence).toBe(0); expect(n.generations[1].filter(s => s.describe().sequence === 1).length).toBeGreaterThanOrEqual(4);
});
it.each(['before-image', 'after-image', 'after-writer', 'after-pending', 'before-certificate', 'after-certificate', 'before-apply', 'after-apply', 'durable'])(
  'preserves the complete recovered image and admission gate across SIGKILL at %s', async boundary => {
    const n = await fixture(true), input = options(n), child = fork(new URL('./fixtures/admission-restore-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Restore process exited before ready'); })]))[0]).toBe('ready');
    const { encryptionKey, now, ...review } = n.restoreOptions();
    child.send({ review, key: n.key.toString('hex'), time: n.time + 10000, members: n.members, boundary,
      owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') } });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    let history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
    if (boundary === 'before-image') {
      await expect(openProtectedAdmissionSpendHistory(input)).rejects.toThrow('missing');
      const leftovers = readdirSync(input.directory).sort();
      // No authoritative image was published. A separately reviewed destination preserves the interrupted files.
      history = (await initialize(n, join(n.directory, 'separately-reviewed'))).history;
      expect(readdirSync(input.directory).sort()).toEqual(leftovers);
    } else {
      history = await openProtectedAdmissionSpendHistory({ ...input, protection: { ...input.protection,
        initializeWriter: !existsSync(join(input.directory, 'admission-history-writer', 'history-writer.json')),
        initializeArchive: !existsSync(join(input.directory, 'admission-history-writer', 'payloads', 'history-writer-payloads.json')) } });
      cleanup.push(() => history.close());
    }
    expect(history.read().image).toEqual(n.image); expect(() => history.size()).toThrow('readiness');
    n.online(3); await expect(history.ready()).rejects.toThrow('Four'); expect(() => history.get(n.currentRow.spend)).toThrow();
    n.online(4); await history.ready(); expect(history.get(n.currentRow.spend)).toEqual(n.currentRow);
    expect(history.get(n.legacy.spend)).toEqual(n.legacy); expect(history.isRetired(n.oldKey)).toBe(true);
    await history.write({ ...n.currentRow, spend: randomBytes(32).toString('base64url') }); expect(history.read().applied?.sequence).toBe(1);
  }, 30000,
);
it('downloads and restores two certified generations over five sockets, preserves spent bindings and accepts genuinely new tokens', async () => {
  const n = await fixture(true); let latestRows = n.image.state.spends.length;
  for (const generation of [1, 2]) {
    const destination = join(n.directory, `restored-${generation}`), download = createHistoryAncestryDownload({ directory: join(n.directory, `download-${generation}`),
      localKey: n.localKey, context: n.context, signingKey: n.owner, proposal: n.continuation().proposal, members: n.members, initialize: true, transport: n.transport });
    cleanup.push(() => download.close()); while (!(await download.run({ maxBlocks: 2 })).complete) { /* Explicit bounded download steps. */ }
    const preparation = await prepareAdmissionHistoryRestore({ ...n.restoreOptions(destination), blocks: download.blocks() });
    expect(preparation.review.generations).toBe(generation); expect(preparation.review.spends).toBe(latestRows);
    const input = options(n, destination);
    const verifier = await createConfiguredAdmissionVerifier({ ...input, initialize: true,
      historyProtection: { ...input.protection, initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
    cleanup.push(() => verifier.close());
    const context = { action: 'search' as const, requestBinding: n.binding, now: n.time + 10000 };
    expect(await verifier.verifyAndSpend(n.capability, context)).toEqual({ status: 'replay' });
    const changedBinding = createAdmissionRequestBindingV2('search', { query: 'same token, other operation' });
    expect(await verifier.verifyAndSpend(presentBlindAdmissionTokenV2(n.token, n.issuer.scope, 'search', changedBinding),
      { ...context, requestBinding: changedBinding })).toEqual({ status: 'rejected', reason: 'double_spend' });
    const token = await n.issuer.token();
    expect(await verifier.verifyAndSpend(presentBlindAdmissionTokenV2(token, n.issuer.scope, 'search', n.binding), context)).toEqual({ status: 'accepted' });
    latestRows++; verifier.close();
    const restored = await openProtectedAdmissionSpendHistory(input); cleanup.push(() => restored.close()); await restored.ready();
    expect(restored.size()).toBe(latestRows); expect(restored.isRetired(n.oldKey)).toBe(true); expect(restored.get(n.legacy.spend)).toEqual(n.legacy); restored.close();
    if (generation === 1) { await n.certify(); rmSync(destination, { recursive: true }); }
  }
}, 60000);
