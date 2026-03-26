/**
 * Data directory paths and configuration for the personal node.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import nacl from 'tweetnacl';
import type { Identity } from '@resonance/core';

export const DATA_DIR_NAME = '.resonance';
export const DB_FILENAME = 'resonance.db';
export const IDENTITY_FILENAME = 'identity.json';

/** Returns the path to ~/.resonance/ */
export function getDataDir(): string {
  return join(homedir(), DATA_DIR_NAME);
}

/** Returns the path to ~/.resonance/resonance.db */
export function getDbPath(): string {
  return join(getDataDir(), DB_FILENAME);
}

/** Returns the path to ~/.resonance/identity.json */
export function getIdentityPath(): string {
  return join(getDataDir(), IDENTITY_FILENAME);
}

/** Creates ~/.resonance/ if it doesn't exist. */
export function ensureDataDir(): void {
  mkdirSync(getDataDir(), { recursive: true });
}

/**
 * Derive a 32-byte symmetric encryption key from an identity's secret key.
 * Uses domain separation to prevent key reuse across different purposes.
 */
export function deriveStoreKey(identity: Identity): Uint8Array {
  // Domain-separated: hash(secretKey || domain) to produce a unique key for the store
  const domain = new TextEncoder().encode('resonance-store-key-v1');
  const input = new Uint8Array(identity.secretKey.length + domain.length);
  input.set(identity.secretKey);
  input.set(domain, identity.secretKey.length);
  return nacl.hash(input).slice(0, nacl.secretbox.keyLength);
}
