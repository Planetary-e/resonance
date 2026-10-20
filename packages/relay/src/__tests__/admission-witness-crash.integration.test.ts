import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAdmissionRequestBindingV2 } from '@resonance/core';
import { admissionWitnessSetId, createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createAdmissionWitness } from '../admission-witness.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

it('keeps a signed vote after SIGKILL and refuses a conflicting binding after recovering its writer lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'witness-crash-')), f = await witnessFixture(), encryptionKey = randomBytes(32);
  const claim = { setId: admissionWitnessSetId(f.policy.keys[0].witnesses!), issuerKey: f.policy.activeKey, spend: randomBytes(32).toString('base64url'),
    action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { first: true }) };
  const request = createAdmissionWitnessRequest(claim, f.coordinators[0]);
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ policy: f.policy, request, encryptionKey: encryptionKey.toString('base64url'),
    publicKey: Buffer.from(f.witnesses[0].publicKey).toString('base64url'), secretKey: Buffer.from(f.witnesses[0].secretKey).toString('base64url') }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-witness-crash.ts', import.meta.url), [directory], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','inherit','ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toEqual({ persisted: true });
    child.kill('SIGKILL'); await exited;
    const witness = createAdmissionWitness({ directory, policy: f.policy, encryptionKey, signingKey: f.witnesses[0] });
    try {
      expect(witness.vote(request).spend).toBe(claim.spend);
      const other = createAdmissionWitnessRequest({ ...claim, requestBinding: createAdmissionRequestBindingV2('search', { second: true }) }, f.coordinators[1]);
      expect(() => witness.vote(other)).toThrow('Conflicting');
    } finally { witness.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
