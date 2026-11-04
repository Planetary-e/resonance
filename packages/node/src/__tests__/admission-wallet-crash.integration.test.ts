import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, createAdmissionRequestBindingV2 } from '@resonance/core';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';

it('recovers both wallet locks after SIGKILL and reuses only the exact reserved token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-crash-')); const encryptionKey = randomBytes(32);
  const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  const scope = { issuer: 'crash-test', community: 'public', epoch: '2026-09' };
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  const request = await createBlindAdmissionRequestV2(scope, keys.publicKey);
  const token = await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request));
  const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
  const initial = await openManagedAdmissionWallet({ directory, encryptionKey });
  await initial.configure({ version: 1, scope, issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45997/'] });
  await initial.importTokens([token]); initial.close();
  const child = fork(new URL('./fixtures/admission-wallet-crash.ts', import.meta.url), [directory, encryptionKey.toString('hex')],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [capability] = await once(child, 'message'); child.kill('SIGKILL'); await exited;
    const recovered = await openManagedAdmissionWallet({ directory, encryptionKey });
    try {
      expect(recovered.status()).toMatchObject({ available: 0, reserved: 1 });
      const context = { relayUrl: 'ws://127.0.0.1:45997/', action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { crash: true }) };
      expect(recovered.capabilityFor(context)).toEqual(capability);
      expect(() => recovered.capabilityFor({ ...context, requestBinding: createAdmissionRequestBindingV2('search', { crash: false }) })).toThrow('no unreserved');
    } finally { recovered.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
