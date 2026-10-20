import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionPolicyHeadRequest } from '@resonance/core/admission-policy-freshness';
import { openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { preparePolicyObserverRestore } from '../policy-observer-history-restore.js';
import { replayPolicyObserverHistory } from '../policy-observer-history-replay.js';
import { openPolicyObserverRestoreResumption } from '../policy-observer-restore-resumption.js';
import { policyObserverRestoreFixture } from './fixtures/policy-observer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [], children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }));
  for (const close of cleanup.splice(0).reverse()) await close();
});
for (const blocked of [false, true]) it.each(['before-baseline', 'after-baseline', 'after-writer', 'after-archive',
  'after-root-intent', 'after-root-index', 'after-root-certificate', 'durable'])(`preserves ${blocked ? 'the conflict fence' : 'the recovered policy'} through restore SIGKILL at %s`, async boundary => {
  const n = await policyObserverRestoreFixture(close => cleanup.push(close)); await n.observer.advance(n.advance);
  if (blocked) await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated'); n.observer.close();
  const selected = await n.recover(), child = fork(new URL('./fixtures/policy-observer-restore-crash.ts', import.meta.url), [], {
    serialization: 'advanced', execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(child); expect((await once(child, 'message'))[0]).toBe('ready');
  const messages: unknown[] = []; child.on('message', value => messages.push(value));
  const marker = join(n.directory, 'restore-crash-marker'), exited = once(child, 'exit');
  const { now: _, transport: _t, ...openOptions } = selected.openOptions;
  child.send({ openOptions, restoreOptions: selected.restoreOptions, now: n.now, blocked, marker, boundary }); await exited;
  expect(messages).toEqual([]); expect(readFileSync(marker, 'utf8')).toBe(boundary);
  let observer: Awaited<ReturnType<typeof openProtectedPolicyObserver>>;
  if (boundary === 'before-baseline') {
    await expect(openProtectedPolicyObserver({ ...selected.openOptions, mode: 'open-existing' })).rejects.toThrow('missing');
    const unchanged = readdirSync(selected.openOptions.directory).sort(), directory = `${selected.openOptions.directory}-separately-reviewed`;
    const preparation = await preparePolicyObserverRestore({ ...selected.restoreOptions, directory });
    observer = await openProtectedPolicyObserver({ ...selected.openOptions, directory, mode: 'create-new', restore: { preparation, approvedDigest: preparation.review.approvalDigest } });
    expect(readdirSync(selected.openOptions.directory).sort()).toEqual(unchanged);
  } else {
    const replay = await replayPolicyObserverHistory(selected.replayOptions);
    const resume = await openPolicyObserverRestoreResumption({ ...selected.openOptions, expectedRestorationDigest: replay.replayDigest }); cleanup.push(resume.close);
    const reviewed = resume.review(); expect(reviewed.readiness).toBe('unverified');
    await expect(resume.apply('wrong')).rejects.toThrow('reviewed');
    expect((await resume.apply(reviewed.approvalDigest)).readiness).toBe('unverified'); resume.close();
    observer = await openProtectedPolicyObserver({ ...selected.openOptions, mode: 'open-existing' });
  }
  cleanup.push(observer.close); expect(observer.policy()).toEqual(n.second); expect(observer.status().blocked).toBe(blocked);
  if (blocked) {
    expect(observer.status().evidence).toHaveLength(2); await expect(observer.ready()).rejects.toThrow('equivocated');
    await expect(observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('equivocated');
  } else {
    await observer.ready(); expect((await observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.advance.commitment.next);
  }
  expect(observer.status().pending).toBe(false);
}, 30000);
