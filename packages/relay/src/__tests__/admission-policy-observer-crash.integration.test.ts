import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionPolicyHeadRequest } from '@resonance/core/admission-policy-freshness';
import { openAdmissionPolicyObserver } from '../admission-policy-observer.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';
const cleanup: Array<() => void> = [], children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  }));
  for (const close of cleanup.splice(0).reverse()) close();
});
for (const conflict of [false, true]) it.each(['candidate-opened', 'candidate-partial', 'candidate-written', 'candidate-flushed', 'published',
  ...(process.platform === 'win32' ? [] : ['directory-flushed'])])(`preserves ${conflict ? 'equivocation evidence' : 'policy head'} across SIGKILL at %s`, async boundary => {
  const n = await policyObserverFixture(); cleanup.push(n.close);
  const initial = await openAdmissionPolicyObserver({ ...n.options, mode: 'create-new' });
  if (conflict) await initial.advance(n.advance); initial.close();
  const before = readFileSync(n.options.path), marker = join(n.directory, 'marker');
  const child = fork(new URL('./fixtures/policy-observer-crash.ts', import.meta.url), [], { serialization: 'advanced',
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(child); expect((await once(child, 'message'))[0]).toBe('ready');
  const exited = once(child, 'exit'), { now: _, ...options } = n.options;
  child.send({ options, now: n.now, advance: conflict ? n.conflict : n.advance, marker, boundary }); await exited;
  expect(readFileSync(marker, 'utf8')).toBe(boundary);
  const committed = boundary === 'published' || boundary === 'directory-flushed';
  if (!committed) expect(readFileSync(n.options.path)).toEqual(before);
  const reopened = await openAdmissionPolicyObserver({ ...n.options, mode: 'open-existing' }); cleanup.push(reopened.close);
  if (conflict) {
    expect(reopened.status().blocked).toBe(committed);
    if (!committed) await expect(reopened.advance(n.conflict)).rejects.toThrow('equivocated');
    expect(reopened.status().evidence).toHaveLength(2);
    expect(() => reopened.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).toThrow('equivocated');
  } else {
    expect(reopened.policy()).toEqual(committed ? n.second : n.first);
    await reopened.advance(n.advance); expect(reopened.observe(createAdmissionPolicyHeadRequest(n.context, n.now)).head.revision).toBe(2);
  }
}, 15000);
