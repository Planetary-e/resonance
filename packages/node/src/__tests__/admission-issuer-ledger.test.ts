import { beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import type { AdmissionWalletProfileV1 } from '../admission-wallet-profile.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
let keys: CryptoKeyPair; let profile: AdmissionWalletProfileV1;
beforeAll(async () => {
  keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
  profile = { version: 1, scope: { issuer: 'permit-issuer', community: 'public', epoch: 'period-one' },
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45111/'] };
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-permits-'));
  return { directory, options: { path: join(directory, 'ledger.json'), privateKey: keys.privateKey, expectedProfile: profile } };
}

it('enforces fixed one-use permits and a total allowance, caching exact responses across restart without adding a redemption identifier', async () => {
  const { directory, options } = setup();
  let ledger = await openAdmissionIssuerLedger({ ...options, create: { batchSize: 2, maxPermits: 2 } });
  try {
    const permit = ledger.grant(); const other = ledger.grant();
    expect(() => ledger.grant()).toThrow('allowance exhausted');
    expect(ledger.status()).toMatchObject({ allocatedPermits: 2, remainingPermits: 0, tokenBudget: 4, allocatedTokens: 4, boundTokens: 0 });
    await expect(openAdmissionIssuerLedger(options)).rejects.toThrow('already open');
    const batch = await createAdmissionIssuanceBatch(profile, 2);
    const unknown = { ...permit, secret: randomBytes(32).toString('base64url') };
    await expect(ledger.approve(unknown, batch.request)).rejects.toThrow('Unknown');
    await expect(ledger.approve({ ...permit, count: 1 }, batch.request)).rejects.toThrow('Invalid permit');
    await expect(ledger.approve({ ...permit, scope: { ...permit.scope, epoch: 'period-two' } }, batch.request)).rejects.toThrow('Invalid permit');
    await expect(ledger.approve(permit, { ...batch.request, member: 'not-allowed' })).rejects.toThrow('Invalid blinded');
    const smaller = await createAdmissionIssuanceBatch(profile, 1);
    await expect(ledger.approve(permit, smaller.request)).rejects.toThrow('exactly 2');
    expect(ledger.status().boundTokens).toBe(0);
    const approving = ledger.approve(permit, batch.request);
    expect(() => ledger.grant()).toThrow('in progress');
    await expect(ledger.approve(other, batch.request)).rejects.toThrow('in progress');
    const response = await approving;
    expect(ledger.status()).toMatchObject({ boundPermits: 1, completedPermits: 1, boundTokens: 2 });
    expect(await ledger.approve(permit, batch.request)).toEqual(response);
    await expect(ledger.approve(other, batch.request)).rejects.toThrow('another permit');
    const different = await createAdmissionIssuanceBatch(profile, 2);
    await expect(ledger.approve(permit, different.request)).rejects.toThrow('already bound');
    expect(JSON.stringify(response)).not.toContain(permit.secret);
    const tokens = await batch.finalize(response);
    const binding = createAdmissionRequestBindingV2('search', { example: 'redemption' });
    for (const token of tokens) {
      const capability = presentBlindAdmissionTokenV2(token, profile.scope, 'search', binding);
      expect(await verifyBlindAdmissionTokenV2(capability, profile.scope, 'search', binding, keys.publicKey)).toBeTruthy();
      expect(JSON.stringify(capability)).not.toContain(permit.secret); expect(JSON.stringify(capability)).not.toContain(batch.request.batchId);
    }
    const encrypted = readFileSync(options.path, 'utf8');
    for (const secret of [permit.secret, batch.request.batchId, response.responses[0], profile.scope.issuer, ...tokens]) expect(encrypted).not.toContain(secret);
    expect(JSON.stringify(ledger.status())).not.toContain(batch.request.batchId);
    ledger.close(); ledger = await openAdmissionIssuerLedger(options);
    expect(await ledger.approve(permit, batch.request)).toEqual(response); expect(() => ledger.grant()).toThrow('exhausted');
    await ledger.approve(other, different.request);
    expect(ledger.status()).toMatchObject({ completedPermits: 2, boundTokens: 4 });
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('requires explicit first initialization and rejects missing, corrupted, or changed pinned state', async () => {
  const { directory, options } = setup();
  try {
    await expect(openAdmissionIssuerLedger(options)).rejects.toThrow('missing');
    await expect(openAdmissionIssuerLedger({ ...options, create: { batchSize: 33, maxPermits: 1 } })).rejects.toThrow('policy');
    const ledger = await openAdmissionIssuerLedger({ ...options, create: { batchSize: 1, maxPermits: 1 } });
    ledger.grant(); ledger.close();
    const raw = readFileSync(options.path, 'utf8');
    await expect(openAdmissionIssuerLedger({ ...options, create: { batchSize: 2, maxPermits: 200 } })).rejects.toThrow('already exists');
    expect(readFileSync(options.path, 'utf8')).toBe(raw);
    await expect(openAdmissionIssuerLedger({ ...options, expectedProfile: { ...profile, scope: { ...profile.scope, epoch: 'different' } } })).rejects.toThrow('state is invalid');
    const record = JSON.parse(raw); record.tag = Buffer.alloc(16).toString('base64url'); writeFileSync(options.path, JSON.stringify(record));
    await expect(openAdmissionIssuerLedger(options)).rejects.toThrow();
    rmSync(options.path); await expect(openAdmissionIssuerLedger(options)).rejects.toThrow('missing');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('never signs after a failed reservation write, and never returns a response whose persistence failed', async () => {
  const { directory, options } = setup();
  let ledger = await openAdmissionIssuerLedger({ ...options, create: { batchSize: 1, maxPermits: 1 } });
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  try {
    const permit = ledger.grant(); const batch = await createAdmissionIssuanceBatch(profile, 1);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('reservation disk failure'); });
    await expect(ledger.approve(permit, batch.request)).rejects.toThrow('reservation disk failure');
    expect(signing).not.toHaveBeenCalled(); expect(() => ledger.status()).toThrow('write failed');
    ledger.close(); ledger = await openAdmissionIssuerLedger(options);
    expect(ledger.status().boundTokens).toBe(0);
    // Allow the reservation snapshot, then fail the signed response snapshot.
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(renameSync).mockImplementationOnce(actualFs.renameSync).mockImplementationOnce(() => { throw new Error('response disk failure'); });
    await expect(ledger.approve(permit, batch.request)).rejects.toThrow('response disk failure');
    expect(signing).toHaveBeenCalledTimes(1); expect(() => ledger.status()).toThrow('write failed');
    ledger.close(); ledger = await openAdmissionIssuerLedger(options);
    expect(ledger.status()).toMatchObject({ boundTokens: 1, completedPermits: 0 });
    const other = await createAdmissionIssuanceBatch(profile, 1);
    await expect(ledger.approve(permit, other.request)).rejects.toThrow('already bound');
    const response = await ledger.approve(permit, batch.request); expect(await batch.finalize(response)).toHaveLength(1);
    const calls = signing.mock.calls.length;
    expect(await ledger.approve(permit, batch.request)).toEqual(response); expect(signing).toHaveBeenCalledTimes(calls);
    expect(ledger.status().boundTokens).toBe(1);
  } finally { signing.mockRestore(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('keeps an allowance bound if the operator closes while signing, and permits only an exact recovery', async () => {
  const { directory, options } = setup();
  let ledger = await openAdmissionIssuerLedger({ ...options, create: { batchSize: 1, maxPermits: 1 } });
  try {
    const permit = ledger.grant(); const batch = await createAdmissionIssuanceBatch(profile, 1);
    const pending = ledger.approve(permit, batch.request); ledger.close();
    await expect(pending).rejects.toThrow('closed');
    ledger = await openAdmissionIssuerLedger(options);
    expect(ledger.status()).toMatchObject({ boundTokens: 1, completedPermits: 0 });
    const response = await ledger.approve(permit, batch.request);
    expect(await batch.finalize(response)).toHaveLength(1); expect(() => ledger.grant()).toThrow('exhausted');
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
