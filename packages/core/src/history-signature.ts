/** Bounded cryptographic memoization for repeated, nested history certificates. */
import { createHash } from 'node:crypto';
import { verify } from './crypto.js';

const MAX_ENTRIES = 1024;

/**
 * Cache only successful signature checks, keyed by all authenticated bytes.
 * Keep no payloads, keys or object references. Callers must still validate every
 * message's shape, context, expiry and current durable state on every use.
 * A hit says nothing about authorization or freshness.
 */
export function createHistorySignatureVerifier(capacity = MAX_ENTRIES) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_ENTRIES) throw new Error('Invalid history signature cache capacity');
  const verified = new Set<string>();
  return (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean => {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    // Fixed-length key and signature make the concatenation unambiguous.
    const id = createHash('sha256').update(publicKey).update(signature).update(message).digest('hex');
    if (verified.has(id)) { verified.delete(id); verified.add(id); return true; }
    if (!verify(message, signature, publicKey)) return false;
    if (verified.size === capacity) verified.delete(verified.values().next().value!);
    verified.add(id); return true;
  };
}

// Process-local and disposable: restart/eviction only causes re-verification.
export const verifyHistorySignature = createHistorySignatureVerifier();
