import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';

it('retains the whole permit after SIGKILL mid-signing and resumes only its original batch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-crash-'));
  const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
  const profile = { version: 1, scope: { issuer: 'crash-issuer', community: 'public', epoch: 'period-one' },
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45212/'] };
  const options = { path: join(directory, 'ledger.json'), expectedProfile: profile, privateKey: keys.privateKey };
  const ledger = await openAdmissionIssuerLedger({ ...options, create: { batchSize: 2, maxPermits: 1 } });
  const permit = ledger.grant(); ledger.close();
  const batch = await createAdmissionIssuanceBatch(profile, 2);
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ profile, privateKey, permit, request: batch.request }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-issuer-crash.ts', import.meta.url), [directory],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toMatchObject({ signaturesCompleted: 1 });
    child.kill('SIGKILL'); await exited;
    const recovered = await openAdmissionIssuerLedger(options);
    try {
      expect(recovered.status()).toMatchObject({ boundTokens: 2, completedPermits: 0, remainingPermits: 0 });
      const different = await createAdmissionIssuanceBatch(profile, 2);
      await expect(recovered.approve(permit, different.request)).rejects.toThrow('already bound');
      const response = await recovered.approve(permit, batch.request);
      expect(await batch.finalize(response)).toHaveLength(2); expect(await recovered.approve(permit, batch.request)).toEqual(response);
      expect(recovered.status()).toMatchObject({ boundTokens: 2, completedPermits: 1 });
    } finally { recovered.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
