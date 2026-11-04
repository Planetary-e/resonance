import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { parseHistoryAgreementCertificate } from '@resonance/core/history-agreement';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { historyAgreementFixture } from './fixtures/history-agreement-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function start(input: unknown) {
  const child = fork(new URL('./fixtures/history-agreement-process.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const reply = () => Promise.race([once(child, 'message'), exited.then(([code, signal]) => {
    throw new Error(`History process exited before its reply: ${code ?? signal}`);
  })]).then(([message]) => message);
  expect(await reply()).toBe('ready');
  const result = reply(); child.send(input as Parameters<ChildProcess['send']>[0]);
  return { child, exited, result: await result };
}

it('carries a hidden decision and repairs the fourth volunteer with an independent owner and four separate relay processes', async () => {
  const n = historyAgreementFixture('missing', 1); cleanup.push(() => n.close());
  // Four durable confirmations exist but the recovering owner has never seen their replies.
  const reports = n.promise(1), prepared = n.frames('prepare', 1, n.a, reports);
  const proof = n.certificate(prepared.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  n.frames('confirm', 1, n.a, proof).slice(0, 4).forEach((f, i) => n.roles[i].exchange(f));
  n.roles.forEach(r => r.close()); n.stores.forEach(s => s.close());
  const encode = (key: SigningKeyPair) => ({ publicKey: Buffer.from(key.publicKey).toString('hex'), secretKey: Buffer.from(key.secretKey).toString('hex') });
  const common = { context: n.context, rootId: n.options.rootId, localKey: n.localKey.toString('hex'), proposal: n.b, members: [] };
  const members = n.context.members.map(publicKey => ({ publicKey, endpoint: '' }));
  const replicas = [];
  for (const i of [0, 1, 2, 3, 4]) {
    const process = await start({ ...common, role: 'replica', directory: join(n.directory, `r${i}`), signingKey: encode(n.memberKeys[i]) });
    members[i].endpoint = process.result.endpoint; replicas.push(process);
  }
  replicas[3].child.kill('SIGKILL'); await replicas[3].exited;
  const owner = await start({ ...common, role: 'owner', directory: join(n.directory, 'owner'), signingKey: encode(n.owner), members });
  const certificate = parseHistoryAgreementCertificate(owner.result.certificate, n.context, 'confirmed');
  expect(owner.result.selected).toEqual(n.a);
  expect(certificate.votes.map(v => v.request.replica).sort()).toEqual([0, 1, 2, 4].map(i => n.context.members[i]).sort());
  expect(certificate.votes[0].request.proposalId).toBe(historySuccessorProposalId(n.a));
  expect((await owner.exited)[0]).toBe(0);
  // Kill the relay processes, reopen their durable state and verify the transferred ciphertext.
  for (const replica of replicas) { replica.child.kill('SIGKILL'); await replica.exited; }
  n.reopen(4);
  expect(n.stores[4].read().envelopes).toEqual(n.blocks);
  expect(n.stores[4].agreementState()!.confirmed!.frame.proposal).toEqual(n.a);
}, 60_000);
