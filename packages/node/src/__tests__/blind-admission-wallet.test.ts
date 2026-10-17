import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { publicVerif } from '@cloudflare/privacypass-ts';
import {
  createAdmissionRequestBindingV2, createBlindAdmissionRequestV2,
  issueBlindAdmissionRequestV2, verifyBlindAdmissionTokenV2,
} from '@resonance/core';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';

describe('blind admission wallet', () => {
  it('encrypts tokens and permanently binds each reservation to one destination and request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-admission-wallet-'));
    const path = join(directory, 'wallet.json');
    const encryptionKey = randomBytes(32);
    const scope = { issuer: 'test-issuer', community: 'public', epoch: '2026-09' };
    const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, {
      modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]),
    });
    const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
    const tokens: string[] = [];
    for (let index = 0; index < 2; index++) {
      const request = await createBlindAdmissionRequestV2(scope, keys.publicKey);
      tokens.push(await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request)));
    }
    const options = { path, encryptionKey, issuerPublicKey: keys.publicKey, scope };
    const first = { relayUrl: 'ws://127.0.0.1:46101/', action: 'search' as const,
      requestBinding: createAdmissionRequestBindingV2('search', { query: 'first' }) };
    const second = { ...first, requestBinding: createAdmissionRequestBindingV2('search', { query: 'second' }) };
    const otherRelay = { ...first, relayUrl: 'ws://127.0.0.1:46102/' };
    try {
      const wallet = openBlindAdmissionWalletV2(options);
      const importPromise = wallet.importTokens(tokens);
      expect(() => wallet.capabilityFor(first)).toThrow('import is in progress');
      await expect(wallet.importTokens(tokens)).rejects.toThrow('import is in progress');
      expect(await importPromise).toBe(2);
      expect(await wallet.importTokens([tokens[0]])).toBe(0);
      const otherScope = { ...scope, epoch: '2026-10' };
      const differentEpoch = await createBlindAdmissionRequestV2(otherScope, keys.publicKey);
      const otherToken = await differentEpoch.finalize(
        await issueBlindAdmissionRequestV2(issuer, differentEpoch.request));
      await expect(wallet.importTokens([otherToken])).rejects.toThrow('invalid issuer signature or scope');
      expect(wallet.available()).toBe(2);
      const firstCapability = wallet.capabilityFor(first);
      expect(wallet.capabilityFor(first)).toEqual(firstCapability);
      expect(wallet.available()).toBe(1);
      expect(readFileSync(path, 'utf8')).not.toContain(tokens[0]);
      expect(readFileSync(path, 'utf8')).not.toContain(first.requestBinding);
      expect(() => openBlindAdmissionWalletV2(options)).toThrow('already open');
      wallet.close();

      const reopened = openBlindAdmissionWalletV2(options);
      expect(reopened.capabilityFor(first)).toEqual(firstCapability);
      const secondCapability = reopened.capabilityFor(second);
      expect(secondCapability.token).not.toBe(firstCapability.token);
      expect(reopened.available()).toBe(0);
      expect(() => reopened.capabilityFor(otherRelay)).toThrow('no unreserved tokens');
      expect(await verifyBlindAdmissionTokenV2(firstCapability, scope, first.action,
        first.requestBinding, keys.publicKey)).toBeTruthy();
      expect(await verifyBlindAdmissionTokenV2(firstCapability, scope, second.action,
        second.requestBinding, keys.publicKey)).toBeNull();
      reopened.close();

      expect(() => openBlindAdmissionWalletV2({ ...options, encryptionKey: randomBytes(32) }))
        .toThrow();
      const tampered = JSON.parse(readFileSync(path, 'utf8'));
      const middle = Math.floor(tampered.ciphertext.length / 2);
      tampered.ciphertext = `${tampered.ciphertext.slice(0, middle)}${tampered.ciphertext[middle] === 'A' ? 'B' : 'A'}${tampered.ciphertext.slice(middle + 1)}`;
      writeFileSync(path, JSON.stringify(tampered));
      expect(() => openBlindAdmissionWalletV2(options)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
