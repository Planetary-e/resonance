import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { loadOrCreateRelayIdentity, RELAY_IDENTITY_FILENAME, RELAY_IDENTITY_MAX_BYTES } from '../relay-identity-store.js';
import { createLocalBlindAdmissionVerifierV2 } from '../blind-admission-verifier.js';
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(extra: number) {
  const directory = mkdtempSync(join(tmpdir(), 'control-reservations-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  return { directory, ledger, authority };
}
it('reserves identity migration peak before creation and preserves the key at a full budget', () => {
  const n = fixture(2 * RELAY_IDENTITY_MAX_BYTES + 8192), path = join(n.directory, 'runtime');
  const identity = withStorageReservationAuthority(n.authority, () => loadOrCreateRelayIdentity(path));
  expect(n.authority.status()).toMatchObject({ components: 1, availableBytes: 0 });
  const passphrase = 'managed-test-identity-long-passphrase';
  expect(withStorageReservationAuthority(n.authority, () => loadOrCreateRelayIdentity(path, passphrase))).toEqual(identity);
  expect(readFileSync(join(path, RELAY_IDENTITY_FILENAME), 'utf8')).toContain('relay-infrastructure-identity-encrypted');
  const other = join(n.directory, 'another');
  expect(() => withStorageReservationAuthority(n.authority, () => loadOrCreateRelayIdentity(other, passphrase))).toThrow(/exhausted/);
  expect(existsSync(other)).toBe(false);
  const id = n.authority.status().authorityId; n.authority.close();
  const reopened = openStorageReservationAuthority({ directory: n.ledger, mode: 'open-existing', authorityId: id }); cleanup.push(reopened.close);
  expect(withStorageReservationAuthority(reopened, () => loadOrCreateRelayIdentity(path, passphrase))).toEqual(identity);
});
it('keeps exact legacy token retries at full capacity and refuses use after the captured authority closes', async () => {
  const n = fixture(512), keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, {
    modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]),
  });
  const scope = { issuer: 'reservation-test', community: 'local', epoch: '2026-10' };
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  const request = await createBlindAdmissionRequestV2(scope, keys.publicKey), token = await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request));
  const binding = createAdmissionRequestBindingV2('search', { query: 1 });
  const capability = await presentBlindAdmissionTokenV2(token, scope, 'search', binding), context = { action: 'search' as const, requestBinding: binding, now: Date.now() };
  const options = { directory: join(n.directory, 'runtime'), scope, issuerPublicKey: keys.publicKey, maxSpends: 1 };
  let verifier = withStorageReservationAuthority(n.authority, () => createLocalBlindAdmissionVerifierV2(options)); cleanup.push(() => verifier.close());
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
  expect(await verifier.verifyAndSpend(capability, context)).toEqual({ status: 'accepted' }); verifier.close();
  verifier = withStorageReservationAuthority(n.authority, () => createLocalBlindAdmissionVerifierV2(options));
  expect(await verifier.verifyAndSpend(capability, context)).toEqual({ status: 'replay' });
  const other = join(n.directory, 'another');
  expect(() => withStorageReservationAuthority(n.authority, () => createLocalBlindAdmissionVerifierV2({ ...options, directory: other }))).toThrow(/exhausted/);
  expect(existsSync(other)).toBe(false);
  const path = join(options.directory, 'admission-spends-v2.jsonl'), bytes = readFileSync(path); n.authority.close();
  await expect(verifier.verifyAndSpend(capability, context)).rejects.toThrow(/closed/); expect(readFileSync(path)).toEqual(bytes);
});
it('refuses overflow in a manual ledger reservation before creating output', () => {
  const n = fixture(512), path = join(n.directory, 'runtime');
  expect(() => withStorageReservationAuthority(n.authority, () => createLocalBlindAdmissionVerifierV2({ directory: path, maxSpends: Number.MAX_SAFE_INTEGER, keyPolicies: () => [] }))).toThrow(/byte capacity/);
  expect(existsSync(path)).toBe(false); expect(n.authority.status().components).toBe(0);
});
