/**
 * Identity management: create, save, and load DID identities.
 * Wraps @resonance/core crypto with file system I/O.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  generateIdentity,
  exportIdentity,
  importIdentity,
  type Identity,
} from '@resonance/core';
import { getIdentityPath, ensureDataDir } from './config.js';

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
      const identity = generateIdentity();
      await this.save(identity, password);
      return identity;
    },

    async load(password: string): Promise<Identity> {
      const encrypted = readFileSync(filePath, 'utf-8');
      return importIdentity(encrypted, password);
    },

    async save(identity: Identity, password: string): Promise<void> {
      ensureDataDir();
      const encrypted = await exportIdentity(identity, password);
      writeFileSync(filePath, encrypted, 'utf-8');
    },

    exists(): boolean {
      return existsSync(filePath);
    },
  };
}
