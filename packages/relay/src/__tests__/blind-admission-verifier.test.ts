import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicVerif } from '@cloudflare/privacypass-ts';
import {
  createAdmissionRequestBindingV2,
  createBlindAdmissionRequestV2,
  issueBlindAdmissionRequestV2,
  presentBlindAdmissionTokenV2,
} from '@resonance/core';
import { createLocalBlindAdmissionVerifierV2 } from '../blind-admission-verifier.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), closeSync: vi.fn(fs.closeSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const directories: string[] = [];
afterEach(() => { vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync); vi.clearAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('local blind-token spent log', () => {
  it('opens on Windows without requesting an unsupported directory flush', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-admission-windows-')); directories.push(directory);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    vi.mocked(fsyncSync).mockImplementation(fd => { if (actualFs.fstatSync(fd).isDirectory()) throw new Error('EPERM directory fsync'); actualFs.fsyncSync(fd); });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const verifier = createLocalBlindAdmissionVerifierV2({ directory, keyPolicies: () => [] });
      try { expect(actualFs.existsSync(join(directory, 'admission-spends-v2.jsonl'))).toBe(true); } finally { verifier.close(); }
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
  it.skipIf(process.platform === 'win32')('closes the spend descriptor when initialization cannot flush the directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-admission-flush-')); directories.push(directory);
    vi.mocked(fsyncSync).mockImplementation(() => { throw new Error('Injected storage failure'); });
    expect(() => createLocalBlindAdmissionVerifierV2({ directory, keyPolicies: () => [] })).toThrow('Injected storage failure');
    const descriptors = vi.mocked(openSync).mock.results.filter(result => result.type === 'return').map(result => result.value);
    expect(descriptors.length).toBeGreaterThanOrEqual(2);
    for (const fd of descriptors) { expect(closeSync).toHaveBeenCalledWith(fd); expect(() => actualFs.fstatSync(fd)).toThrow(); }
  });
  it('survives restart, permits the exact retry, and rejects another request', async () => {
    const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, {
      modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]),
    });
    const scope = { issuer: 'community-barcelona', community: 'barcelona', epoch: '2026-09' };
    const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
    const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey);
    const token = await blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request));
    const first = createAdmissionRequestBindingV2('search', { query: 1 });
    const second = createAdmissionRequestBindingV2('search', { query: 2 });
    const directory = mkdtempSync(join(tmpdir(), 'resonance-admission-'));
    directories.push(directory);
    const options = { directory, scope, issuerPublicKey: keys.publicKey, maxSpends: 1 };
    let verifier = createLocalBlindAdmissionVerifierV2(options);
    const capability = await presentBlindAdmissionTokenV2(token, scope, 'search', first);
    expect(await verifier.verifyAndSpend(capability, { action: 'search', requestBinding: first, now: Date.now() })).toEqual({ status: 'accepted' });
    verifier.close();
    verifier = createLocalBlindAdmissionVerifierV2(options);
    expect(await verifier.verifyAndSpend(capability, { action: 'search', requestBinding: first, now: Date.now() })).toEqual({ status: 'replay' });
    const changed = await presentBlindAdmissionTokenV2(token, scope, 'search', second);
    expect(await verifier.verifyAndSpend(changed, { action: 'search', requestBinding: second, now: Date.now() })).toEqual({ status: 'rejected', reason: 'double_spend' });
    verifier.close();

    const path = join(directory, 'admission-spends-v2.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}incomplete`);
    expect(() => createLocalBlindAdmissionVerifierV2(options)).toThrow('incomplete');
  });
});
