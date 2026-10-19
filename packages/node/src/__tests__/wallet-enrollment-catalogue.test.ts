import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES } from '@resonance/core/admission-policy-advance';
import { appendWalletEnrollmentCatalogue, readWalletEnrollmentCatalogue } from '../wallet-enrollment-catalogue.js';

it('packs catalogue pages beneath the existing proof-record byte ceiling and refuses incomplete prefixes', () => {
  // Byte-packing mechanics only: these synthetic PEM strings claim no authority.
  const profiles = Array.from({ length: 72 }, (_, i) => ({ version: 1 as const, scope: { issuer: 'i'.repeat(128), community: 'public', epoch: String(i) },
    issuerPublicKey: 'k'.repeat(4096), relayUrls: Array(8).fill('wss://relay.example/' + 'p'.repeat(490)) }));
  const records = new Map<string, unknown>();
  const store = { cataloguePublish(value: unknown) {
    const json = JSON.stringify(value); expect(Buffer.byteLength(json) + 28).toBeLessThanOrEqual(ADMISSION_POLICY_ADVANCE_MAX_BYTES + 8192);
    const root = 'sha256:' + createHash('sha256').update(json).digest('hex'); records.set(root, structuredClone(value)); return root;
  }, catalogueRead(root: string) { if (!records.has(root)) throw new Error('Missing catalogue page'); return records.get(root); } };
  const ref = appendWalletEnrollmentCatalogue(store, undefined, profiles, () => {});
  expect(ref.count).toBe(72); expect(records.size).toBeGreaterThan(1);
  expect(readWalletEnrollmentCatalogue(store, ref, 72, () => {})).toEqual(profiles);
  expect(() => readWalletEnrollmentCatalogue(store, ref, 71, () => {})).toThrow('funded');
  records.delete(records.keys().next().value!); expect(() => readWalletEnrollmentCatalogue(store, ref, 72, () => {})).toThrow('Missing');
});
