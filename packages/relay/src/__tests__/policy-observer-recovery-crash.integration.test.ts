import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openPolicyObserverRecovery, preparePolicyObserverRecovery, POLICY_OBSERVER_RECOVERY_FILENAME } from '../policy-observer-recovery.js';
import { openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { policyObserverRecoveryFixture } from './fixtures/policy-observer-recovery-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const boundaries = ['before-fence', 'after-fence', 'before-workspace', 'after-workspace', 'before-intent', 'after-intent',
  'before-register', 'after-register', 'before-phase', 'after-phase', 'after-select', 'after-confirm', 'after-provision'];
it.each(boundaries)('preserves the source floor and resumable policy recovery after SIGKILL at %s', async boundary => {
  const n = await policyObserverRecoveryFixture(close => cleanup.push(close)); await n.observer.advance(n.advance);
  const minimum = n.observer.recoveryState(), setup = boundary.includes('fence') || boundary.includes('workspace');
  if (!setup) {
    const review = await preparePolicyObserverRecovery({ ...n.recoveryOptions, source: n.observer.reviewRecoverySource() });
    const recovery = await openPolicyObserverRecovery({ ...n.recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } });
    const prefix = boundary === 'after-select' ? 1 : boundary === 'after-confirm' ? 3 : boundary === 'after-provision' ? 4 : 0;
    for (let step = 0; step < prefix; step++) await recovery.advance(); recovery.close();
  }
  n.observer.close();
  const child = fork(new URL('./fixtures/policy-observer-recovery-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' });
  const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
  const { now: _, transport: __, ...observerOptions } = n.options;
  const { transport: ___, agreementTransport: ____, dataTransport: _____, provisionTransport: ______, ...recoveryOptions } = n.recoveryOptions;
  const marker = join(n.directory, 'recovery-crash-marker');
  child.send({ boundary, marker, now: n.now, observerOptions, recoveryOptions }); await exited;
  expect(messages).toEqual(['ready']); expect(readFileSync(marker, 'utf8')).toBe(boundary);
  // Windows implements forced termination without a Unix signalCode.
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
  else expect(child.exitCode).not.toBe(0);
  const source = await openProtectedPolicyObserver({ ...n.options, mode: 'open-existing' }); cleanup.push(source.close);
  expect(source.recoveryState()).toEqual(minimum); expect(source.status().fenced).toBe(boundary !== 'before-fence');
  const published = existsSync(join(recoveryOptions.directory, POLICY_OBSERVER_RECOVERY_FILENAME));
  const leftovers = existsSync(recoveryOptions.directory) ? readdirSync(recoveryOptions.directory) : [];
  const options = !published && leftovers.length ? { ...n.recoveryOptions, directory: join(n.directory, 'separate-reviewed-workspace') } : n.recoveryOptions;
  const review = published ? undefined : await preparePolicyObserverRecovery({ ...options, source: source.reviewRecoverySource() });
  const resumed = await openPolicyObserverRecovery({ ...options, ...(review ? { initialize: { review, approvedDigest: review.approvalDigest } } : {}) }); cleanup.push(resumed.close);
  for (let step = 0; step < 12 && !resumed.status().complete; step++) await resumed.advance();
  expect(resumed.status().complete).toBe(true); expect(source.status().fenced).toBe(true);
  const restored = await resumed.reviewRestore(join(n.directory, 'restored')); expect(restored.preparation.review.policyRevision).toBe(2);
  if (!published && leftovers.length) expect(readdirSync(recoveryOptions.directory)).toEqual(leftovers);
}, 60000);
