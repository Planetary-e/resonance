import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createHistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { historyAgreementFixture, AGREEMENT_TEST_TIME as NOW } from './fixtures/history-agreement-fixture.js';

const cases = ['staging', 'installation'].flatMap(phase => ['before-rename', 'after-rename', 'durable'].map(boundary => ({ phase, boundary })));
it.each(cases)('recovers $phase after SIGKILL at $boundary without exposing a partial suffix', async ({ phase, boundary }) => {
  const n = historyAgreementFixture('sparse', 2);
  let child: ReturnType<typeof fork> | undefined, exited: Promise<unknown> | undefined;
  try {
    const view = n.promise(1), auth = n.frames('prepare', 1, n.a, view)[1];
    const frame = (sequence: number) => createHistoryAgreementDataFrame({ action: 'stage', authorization: auth,
      sequence, envelopeId: historyCheckpointEnvelopeId(n.blocks[sequence]), envelope: n.blocks[sequence] }, n.context, n.owner);
    if (phase === 'installation') n.roles[1].transfer(frame(2));
    n.roles[1].close(); n.stores[1].close();
    child = fork(new URL('./fixtures/history-agreement-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const ready = once(child, 'message'); exited = once(child, 'exit');
    expect((await Promise.race([ready, exited.then(() => { throw new Error('Transfer child exited before ready'); })]))[0]).toBe('ready');
    child.send({ options: { ...n.options, replica: n.context.members[1], directory: join(n.directory, 'r1') }, localKey: n.localKey.toString('hex'),
      member: { publicKey: Buffer.from(n.memberKeys[1].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[1].secretKey).toString('hex') },
      transfer: true, frame: frame(phase === 'installation' ? 1 : 2), boundary, now: NOW });
    await exited; expect(child.signalCode).toBe('SIGKILL'); n.reopen(1);
    expect(n.stores[1].describe().sequence).toBe(phase === 'installation' && boundary !== 'before-rename' ? 2 : 0);
    expect(n.stores[1].agreementState()!.prepared).toBeNull();
    n.roles[1].transfer(frame(2)); n.roles[1].transfer(frame(1));
    expect(n.stores[1].read().envelopes).toEqual(n.blocks);
    expect(n.roles[1].exchange(auth).request.action).toBe('prepare');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    n.close();
  }
}, 30_000);
