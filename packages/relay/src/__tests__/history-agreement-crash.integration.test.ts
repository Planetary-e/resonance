import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { historyAgreementFixture, AGREEMENT_TEST_TIME as NOW } from './fixtures/history-agreement-fixture.js';

const cases = (['promise', 'prepare', 'confirm'] as const).flatMap(action =>
  ['before-rename', 'after-rename', 'durable'].map(boundary => ({ action, boundary })));
it.each(cases)('preserves $action across SIGKILL at $boundary without a delivered reply', async ({ action, boundary }) => {
  const n = historyAgreementFixture();
  let child: ReturnType<typeof fork> | undefined, exited: Promise<unknown> | undefined;
  try {
    let frame = n.frames('promise', 1)[0];
    if (action !== 'promise') {
      const view = n.promise(1), p = n.frames('prepare', 1, n.a, view); frame = p[0];
      if (action === 'confirm') {
        const qc = n.certificate(p.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
        frame = n.frames('confirm', 1, n.a, qc)[0];
      }
    }
    const before = n.stores[0].agreementState(); n.roles[0].close(); n.stores[0].close();
    child = fork(new URL('./fixtures/history-agreement-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const ready = once(child, 'message'); exited = once(child, 'exit');
    // Fail promptly if the fixture exits before requesting its input.
    expect((await Promise.race([ready, exited.then(() => { throw new Error('Agreement child exited before ready'); })]))[0]).toBe('ready');
    let responseBoundary = false;
    child.on('message', value => { if (value === 'durable') responseBoundary = true; });
    child.send({ options: { ...n.options, directory: join(n.directory, 'r0') }, localKey: n.localKey.toString('hex'),
      member: { publicKey: Buffer.from(n.memberKeys[0].publicKey).toString('hex'), secretKey: Buffer.from(n.memberKeys[0].secretKey).toString('hex') },
      frame, boundary, now: NOW });
    await exited;
    expect(child.signalCode).toBe('SIGKILL'); expect(responseBoundary).toBe(boundary === 'durable');
    n.reopen(0);
    const state = n.stores[0].agreementState();
    if (boundary === 'before-rename') expect(state).toEqual(before);
    else {
      expect(state!.report.request.view).toBe(1);
      if (action === 'prepare') expect(state!.prepared!.frame.proposal).toEqual(n.a);
      if (action === 'confirm') expect(state!.confirmed!.frame.preparedCertificate).toEqual(frame.preparedCertificate);
    }
    // Either old state or new state can retry the same exact operation safely.
    expect(n.roles[0].exchange(frame).request.action).toBe(action);
    const v2 = n.promise(2);
    expect(v2.reports[0].prepared?.proposal ?? null).toEqual(action === 'confirm' ? n.a : null);
    expect(() => n.roles[0].exchange(frame)).toThrow(action === 'promise' ? 'Stale' : 'current view');
    expect(n.stores[0].read().envelopes).toEqual([n.root]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    n.close();
  }
}, 30_000);
