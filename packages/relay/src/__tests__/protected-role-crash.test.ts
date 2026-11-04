import { afterEach, beforeAll, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createAdmissionWitness } from '../admission-witness.js';
import { createProtectedAdmissionRoles } from '../protected-admission-roles.js';
import { protectedRoleFixture } from './fixtures/protected-role-fixture.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });

it.each(['after-coordinator-fence', 'after-witness-fence', 'before-history-intent', 'after-history-intent',
  'before-history-apply', 'after-history-apply', 'after-completion'] as const)('resumes local role promotion after actual process death at %s', async boundary => {
  const n = await protectedRoleFixture(f); cleanup.push(n.close); n.history.close();
  const input = join(n.directory, 'crash-input.json'), marker = join(n.directory, 'boundary');
  writeFileSync(input, JSON.stringify({ directory: n.options.directory, context: n.context, members: n.members, policy: f.policy,
    key: n.key.toString('base64url'), time: f.time, owner: { publicKey: Buffer.from(n.owner.publicKey).toString('base64url'),
      secretKey: Buffer.from(n.owner.secretKey).toString('base64url') } }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/protected-role-crash.ts', import.meta.url), [input, boundary, marker], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); }); const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  cleanup.push(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await exited; clearTimeout(timer); expect(errors).toBe(''); expect(readFileSync(marker, 'utf8')).toBe(boundary);
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
  if (boundary !== 'after-coordinator-fence') expect(() => createAdmissionWitness({ ...n.localOptions, signingKey: f.witnesses[0] })).toThrow(/invalid/);
  await n.reopen(); await n.history.ready();
  const capture = await n.capture(), review = await capture.review(); await capture.apply(review.approvalDigest); capture.close();
  const role = createProtectedAdmissionRoles({ history: n.history, witnessKey: f.witnesses[0], coordinatorKey: f.coordinators[0], now: () => f.time }); cleanup.push(role.close);
  expect((await role.witness!.vote(createAdmissionWitnessRequest(n.initial, f.coordinators[0]))).spend).toBe(n.initial.spend);
  await role.quorum!.authorize(n.initial.issuerKey, n.initial.spend, n.initial);
  await expect(role.witness!.vote(createAdmissionWitnessRequest({ ...n.initial, requestBinding: `admreq_${'d'.repeat(86)}` }, f.coordinators[1]))).rejects.toThrow(/Conflicting/);
  expect(n.history.roleState().witness!.votes).toHaveLength(1); expect(n.history.roleState().coordinator!.certificates).toHaveLength(1);
}, 20000);
