/**
 * Identity management: create, save, and load DID identities.
 * Wraps @resonance/core crypto with file system I/O.
 */

import {
  generateIdentity,
  type Identity,
} from '@resonance/core';
import { getIdentityPath } from './config.js';
import { openIdentityFile, identityFileExists } from './identity-file.js';

export interface IdentityManager {
  /** Generate a new identity and save it encrypted with the password. */
  create(password: string): Promise<Identity>;
  /** Load an existing identity by decrypting with the password. */
  load(password: string): Promise<Identity>;
  /** Save an identity encrypted with the password. */
  save(identity: Identity, password: string): Promise<void>;
  /** Check if an identity file exists. */
  exists(): boolean;
}

export function createIdentityManager(identityPath?: string): IdentityManager {
  const filePath = identityPath ?? getIdentityPath();

  return {
    async create(password: string): Promise<Identity> {
      const file = openIdentityFile(filePath, true); let identity: Identity | undefined;
      try {
        if (file.exists()) throw new Error('Identity already exists or creation was interrupted; load it instead');
        identity = generateIdentity(); await file.save(identity, password, true); return identity;
      } catch (error) { identity?.secretKey.fill(0); throw error; }
      finally { file.close(); }
    },

    async load(password: string): Promise<Identity> {
      const file = openIdentityFile(filePath, false);
      try { return await file.load(password); } finally { file.close(); }
    },

    async save(identity: Identity, password: string): Promise<void> {
      const file = openIdentityFile(filePath, true);
      try { await file.save(identity, password); } finally { file.close(); }
    },

    exists(): boolean {
      return identityFileExists(filePath);
    },
  };
}
