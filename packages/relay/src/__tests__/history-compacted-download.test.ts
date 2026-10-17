import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { replayAdmissionHistory } from '../admission-history-replay.js';
import { prepareAdmissionHistoryRestore } from '../admission-history-restore.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { encodeAdmissionHistoryRecord } from '../admission-history-records.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(sockets = false, continuation = false) {
  const n = await admissionRestoreFixture(sockets, (image, at) => ({ version: 1, kind: 'admission-state-checkpoint', image, at }));
  cleanup.push(n.close);
  const full = n.generations[0][0].read().envelopes, checkpoint = full.at(-1)!, genesisId = historyCheckpointEnvelopeId(n.root), issuedAt = Date.now();
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const certificate = { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, genesisId, key, issuedAt)) };
  const expected = [n.root, checkpoint], laterRow = { ...n.currentRow, spend: randomBytes(32).toString('base64url') };
  if (continuation) {
    const root = n.continuation(), tail = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
      header: { kind: 'delta', generation: 1, sequence: 1, previous: historyCheckpointEnvelopeId(root) },
      plaintext: encodeAdmissionHistoryRecord({ version: 1, kind: 'spend', at: n.time + 10000, row: laterRow }) });
    n.generations[1].forEach(store => store.append(tail)); expected.push(root, tail); await n.certify();
  }
  const requests: Array<{ generation: number; sequence: number }> = [];
  const options = { directory: join(n.directory, 'compacted-download'), localKey: n.localKey, context: n.context, signingKey: n.owner,
    members: n.members, proposal: n.continuation().proposal, compaction: { genesis: n.root, certificate },
    transport: (async (member, frame, signal) => {
      const { generation, sequence } = frame.request; requests.push({ generation, sequence });
      if (generation === 0 && sequence < checkpoint.sequence) throw new Error('Omitted prefix is unavailable');
      return n.transport(member, frame, signal);
    }) as NonNullable<Parameters<typeof createHistoryAncestryDownload>[0]['transport']> };
  const open = (initialize = false, extra: Partial<Parameters<typeof createHistoryAncestryDownload>[0]> = {}) => {
    const download = createHistoryAncestryDownload({ ...options, ...extra, initialize }); cleanup.push(download.close); return download;
  };
  return { ...n, checkpoint, genesisId, full, certificate, expected, laterRow, requests, options, open };
}

it('downloads across a continuation with one authentic socket source, resumes offline and restores the complete protected state', async () => {
  const n = await fixture(true, true), original = await replayAdmissionHistory(n.replayOptions());
  let download = n.open(true); expect(n.requests).toEqual([]); await download.run({ maxBlocks: 1 }); download.close();
  n.requests.length = 0; download = n.open(); expect(n.requests).toEqual([]); n.online(1);
  expect((await download.run()).complete).toBe(true); expect([...download.blocks()]).toEqual(n.expected);
  expect(n.requests.every(r => r.generation !== 0 || r.sequence >= n.checkpoint.sequence)).toBe(true);
  expect(download.compaction()).toEqual({ genesisId: n.genesisId, certificate: n.certificate });
  const result = await replayAdmissionHistory({ ...n.replayOptions(), blocks: download.blocks(), compaction: download.compaction()!.certificate });
  expect(result.image).toEqual(original.image); expect(result.replayDigest).toBe(original.replayDigest);
  const destination = join(n.directory, 'from-downloaded-anchor'), preparation = await prepareAdmissionHistoryRestore({ ...n.restoreOptions(destination),
    blocks: download.blocks(), compaction: download.compaction()!.certificate });
  const history = await openProtectedAdmissionSpendHistory({ directory: destination, authority: n.context.authority, policy: n.policy,
    encryptionKey: n.key, now: () => n.time + 10000, initialize: true,
    protection: { context: n.context, signingKey: n.owner, members: n.members, transport: n.transport, timeoutMs: 1000,
      initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } }); cleanup.push(history.close);
  await expect(history.ready()).rejects.toThrow('Four'); n.online(4); await history.ready();
  expect(history.get(n.laterRow.spend)).toEqual(n.laterRow); expect(history.get(n.legacy.spend)).toEqual(n.legacy); expect(history.isRetired(n.oldKey)).toBe(true);
}, 30000);
it('requires the exact explicit proof on reopen and never implicitly opts a full download into skipping prefixes', async () => {
  const n = await fixture(), download = n.open(true); await download.run({ maxBlocks: 1 }); download.close();
  expect(() => n.open(false, { compaction: null as never })).toThrow('explicit');
  expect(() => n.open(false, { compaction: undefined })).toThrow();
  expect(() => n.open(false, { compaction: { genesis: n.root, certificate: { ...n.certificate, votes: n.certificate.votes.slice(0, 3) } } })).toThrow();
  const reopened = n.open(); expect(reopened.read().next).toMatchObject({ generation: 0, sequence: 0, envelopeId: n.genesisId });
  n.requests.length = 0; expect((await reopened.run()).complete).toBe(true); expect(n.requests).toEqual([]);
  const full = n.open(true, { directory: join(n.directory, 'full-download'), compaction: undefined });
  await expect(full.run()).rejects.toThrow('unavailable'); expect(full.read().complete).toBe(false);
});
it.each(['checkpoint', 'genesis'] as const)('refuses damaged cached %s instead of treating a compacted download as complete', async target => {
  const n = await fixture(), download = n.open(true); await download.run(); download.close();
  const id = historyCheckpointEnvelopeId(target === 'checkpoint' ? n.checkpoint : n.root), path = join(n.options.directory, `${id.slice(7)}.block`);
  if (target === 'checkpoint') writeFileSync(path, JSON.stringify(n.root)); else rmSync(path);
  expect(() => n.open()).toThrow();
});
it('counts the independent genesis against capacity and keeps the authenticated suffix after refusal', async () => {
  const n = await fixture(), download = n.open(true, { maxBlocks: 1 });
  await expect(download.run()).rejects.toThrow('capacity'); expect(download.read().blocks).toBe(1); expect(download.read().complete).toBe(false);
  expect(() => [...download.blocks()]).toThrow('incomplete'); download.close();
  const reopened = n.open(false, { maxBlocks: 1 }); expect(reopened.read().blocks).toBe(1); await expect(reopened.run()).rejects.toThrow('capacity');
});
it.each(['before-block', 'after-block', 'before-index', 'after-index', 'durable'] as const)(
  'resumes a compacted checkpoint download after SIGKILL at %s', async boundary => {
    const n = await fixture(), download = n.open(true); download.close();
    const child = fork(new URL('./fixtures/history-download-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'); cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Downloader exited before ready'); })]))[0]).toBe('ready');
    child.send({ directory: n.options.directory, context: n.context, proposal: n.options.proposal, members: n.members, blocks: n.full,
      compaction: n.options.compaction, boundary, localKey: n.localKey.toString('hex'),
      owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') },
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(child.signalCode).toBe('SIGKILL');
    n.requests.length = 0; const reopened = n.open(); expect(n.requests).toEqual([]); await reopened.run();
    expect([...reopened.blocks()]).toEqual(n.expected); expect(reopened.compaction()!.certificate).toEqual(n.certificate);
    expect(n.requests.length > 0).toBe(boundary === 'before-block');
  }, 30000,
);
it.each(['before-block', 'after-block', 'before-index', 'after-index', 'durable'] as const)(
  'resumes the separately pinned genesis after SIGKILL at %s without requesting an omitted prefix', async boundary => {
    const n = await fixture(), download = n.open(true); await download.run({ maxBlocks: 1 }); download.close();
    const checkpointPath = join(n.options.directory, `${historyCheckpointEnvelopeId(n.checkpoint).slice(7)}.block`), saved = readFileSync(checkpointPath);
    const child = fork(new URL('./fixtures/history-download-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'); cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await once(child, 'message'))[0]).toBe('ready');
    child.send({ directory: n.options.directory, context: n.context, proposal: n.options.proposal, members: n.members, blocks: n.full,
      compaction: n.options.compaction, boundary, localKey: n.localKey.toString('hex'),
      owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') },
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') } });
    await exited; expect(child.signalCode).toBe('SIGKILL'); n.requests.length = 0;
    const reopened = n.open(); await reopened.run(); expect(n.requests).toEqual([]); expect([...reopened.blocks()]).toEqual(n.expected);
    expect(readFileSync(checkpointPath)).toEqual(saved);
  }, 30000,
);
