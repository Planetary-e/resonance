/** Independent destination DNS check before trusting an entry's IP observation. */

import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { observedNetworkDomainV1 } from '@resonance/core';

const MAX_ADDRESSES = 64;
const DNS_TIMEOUT_MS = 3_000;

export type PrivateDestinationLookup = (hostname: string, signal?: AbortSignal) => Promise<string[]>;

/**
 * Require the entry's claimed destination IP to occur in an independent DNS
 * answer. Every returned address must be outside the entry's observed domain,
 * since an entry could lie about which address in a multi-address answer it used.
 * This does not authenticate DNS itself or prove independent operators.
 */
export async function verifyPrivateDestinationAddressV1(
  endpoint: string,
  reportedAddress: string,
  entryAddress: string,
  lookup: PrivateDestinationLookup = lookupDestinationAddresses,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  const entryDomain = observedNetworkDomainV1(entryAddress);
  const reportedDomain = observedNetworkDomainV1(reportedAddress);
  if (!entryDomain || !reportedDomain) throw new Error('Invalid private route IP observation');

  // A signed literal-IP endpoint is already independently checkable without DNS.
  const addresses = isIP(hostname) ? [hostname] : await abortableLookup(hostname, lookup, signal);
  signal?.throwIfAborted();
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_ADDRESSES
    || addresses.some(address => typeof address !== 'string' || isIP(address) === 0)) {
    throw new Error('Destination DNS address set is unavailable or invalid');
  }
  const normalized = new Set(addresses.map(normalizeIp));
  if (!normalized.has(normalizeIp(reportedAddress))) {
    throw new Error('Entry destination IP is absent from independent DNS answers');
  }
  if ([...normalized].some(address => observedNetworkDomainV1(address) === entryDomain)) {
    throw new Error('Destination DNS answers overlap the entry network domain');
  }
}

async function abortableLookup(hostname: string, lookup: PrivateDestinationLookup, signal?: AbortSignal): Promise<string[]> {
  if (!signal) return lookup(hostname);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return lookup(hostname, signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function lookupDestinationAddresses(hostname: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const resolver = new Resolver();
  const onAbort = () => resolver.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queries = Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const results = await Promise.race([
      queries,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          resolver.cancel();
          reject(new Error('Destination DNS lookup timed out'));
        }, DNS_TIMEOUT_MS);
      }),
    ]);
    const addresses: string[] = [];
    signal?.throwIfAborted();
    for (const result of results) {
      if (result.status === 'fulfilled') addresses.push(...result.value);
      else if (!isNoAddressError(result.reason)) {
        throw new Error('Destination DNS lookup failed', { cause: result.reason });
      }
    }
    return addresses;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function isNoAddressError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error.code === 'ENODATA' || error.code === 'ENOTFOUND');
}

function normalizeIp(address: string): string {
  const unmapped = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(unmapped) === 4) return unmapped;
  return new URL(`http://[${unmapped}]/`).hostname;
}
