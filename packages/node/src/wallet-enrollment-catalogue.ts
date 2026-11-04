/** Immutable local enrollment, authenticated by the sole profile activation snapshot.
 * Records use the existing funded proof store, including its orphan inventory. */
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES } from '@resonance/core/admission-policy-advance';
import type { AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
export interface WalletEnrollmentCatalogue { root: string; count: number }
interface Page { version: 1; previous: WalletEnrollmentCatalogue | null; first: number; profiles: AdmissionWalletProfileV1[] }
interface Store { catalogueRead(root: string): unknown; cataloguePublish(value: unknown): string }
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function parseWalletEnrollmentCatalogue(value: unknown): WalletEnrollmentCatalogue {
  const ref = value as WalletEnrollmentCatalogue;
  if (!ref || Object.keys(ref).sort().join(',') !== 'count,root' || !digest(ref.root) || !Number.isSafeInteger(ref.count) || ref.count < 1) throw new Error('Invalid wallet enrollment catalogue');
  return { root: ref.root, count: ref.count };
}
export function readWalletEnrollmentCatalogue(store: Store, reference: WalletEnrollmentCatalogue, maxProfiles: number, check: () => void): AdmissionWalletProfileV1[] {
  let ref: WalletEnrollmentCatalogue | null = parseWalletEnrollmentCatalogue(reference);
  if (ref.count > maxProfiles) throw new Error('Wallet enrollment exceeds its funded catalogue');
  const profiles: AdmissionWalletProfileV1[] = Array(ref.count);
  while (ref) {
    check(); const page = store.catalogueRead(ref.root) as Page;
    if (!page || Object.keys(page).sort().join(',') !== 'first,previous,profiles,version' || page.version !== 1 || !Array.isArray(page.profiles)
      || page.profiles.length < 1 || page.profiles.length > 64 || !Number.isSafeInteger(page.first) || page.first < 0
      || page.first + page.profiles.length !== ref.count) throw new Error('Invalid wallet enrollment catalogue page');
    const previous = page.previous === null ? null : parseWalletEnrollmentCatalogue(page.previous);
    if ((previous?.count ?? 0) !== page.first) throw new Error('Wallet enrollment catalogue prefix differs');
    for (let i = 0; i < page.profiles.length; i++) profiles[page.first + i] = page.profiles[i];
    ref = previous;
  }
  check(); return profiles;
}
export function appendWalletEnrollmentCatalogue(store: Store, previous: WalletEnrollmentCatalogue | undefined, profiles: readonly AdmissionWalletProfileV1[], check: () => void): WalletEnrollmentCatalogue {
  let ref = previous ?? null;
  for (let offset = 0; offset < profiles.length;) {
    check(); const first = ref?.count ?? 0;
    let entries = profiles.slice(offset, offset + 64);
    const page = () => ({ version: 1 as const, previous: ref, first, profiles: entries });
    while (Buffer.byteLength(JSON.stringify(page())) + 28 > ADMISSION_POLICY_ADVANCE_MAX_BYTES + 8192 && entries.length > 1) entries = entries.slice(0, -1);
    const root = store.cataloguePublish(page() satisfies Page);
    ref = { root, count: first + entries.length }; offset += entries.length;
  }
  if (!ref) throw new Error('Cannot activate an empty wallet enrollment catalogue');
  check(); return ref;
}
