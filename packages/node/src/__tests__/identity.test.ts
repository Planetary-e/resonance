import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIdentityManager } from '../identity.js';

describe('IdentityManager', () => {
  let tempDir: string;
  let identityPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resonance-test-'));
    identityPath = join(tempDir, 'identity.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports no identity before creation', () => {
    const mgr = createIdentityManager(identityPath);
    expect(mgr.exists()).toBe(false);
  });

  it('creates and persists an identity', () => {
    const mgr = createIdentityManager(identityPath);
    const identity = mgr.create('test-password');

    expect(identity.did).toMatch(/^did:key:z/);
    expect(identity.publicKey).toHaveLength(32);
    expect(identity.secretKey).toHaveLength(64);
    expect(mgr.exists()).toBe(true);
  });

  it('loads the same identity with correct password', () => {
    const mgr = createIdentityManager(identityPath);
    const original = mgr.create('my-password');
    const loaded = mgr.load('my-password');

    expect(loaded.did).toBe(original.did);
    expect(Buffer.from(loaded.publicKey)).toEqual(Buffer.from(original.publicKey));
    expect(Buffer.from(loaded.secretKey)).toEqual(Buffer.from(original.secretKey));
  });

  it('throws with wrong password', () => {
    const mgr = createIdentityManager(identityPath);
    mgr.create('correct-password');

    expect(() => mgr.load('wrong-password')).toThrow();
  });
});
