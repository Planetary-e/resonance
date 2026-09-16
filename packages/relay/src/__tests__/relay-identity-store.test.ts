import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeBase64,
  generateIdentity,
  sign,
  verify,
} from '@resonance/core';
import {
  loadOrCreateRelayIdentity,
  RELAY_IDENTITY_FILENAME,
} from '../relay-identity-store.js';

const temporaryDirectories: string[] = [];

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'resonance-relay-identity-'));
  temporaryDirectories.push(result);
  return result;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('relay infrastructure identity store', () => {
  it('creates a private, versioned identity and reloads the same key', () => {
    const dir = directory();
    const created = loadOrCreateRelayIdentity(dir);
    const path = join(dir, RELAY_IDENTITY_FILENAME);
    const stored = JSON.parse(readFileSync(path, 'utf8'));

    expect(stored).toEqual({
      version: 1,
      kind: 'relay-infrastructure-identity',
      algorithm: 'Ed25519',
      did: created.did,
      publicKey: encodeBase64(created.publicKey),
      secretKey: encodeBase64(created.secretKey),
    });
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateRelayIdentity(dir)).toEqual(created);

    const message = new TextEncoder().encode('relay operation');
    expect(verify(message, sign(message, created.secretKey), created.publicKey)).toBe(true);
  });

  it('generates identities independently for separate relay installations', () => {
    const first = loadOrCreateRelayIdentity(directory());
    const second = loadOrCreateRelayIdentity(directory());

    expect(first.did).not.toBe(second.did);
    expect(first.publicKey).not.toEqual(second.publicKey);
  });

  it('migrates a valid development-format identity without rotating it', () => {
    const dir = directory();
    const path = join(dir, RELAY_IDENTITY_FILENAME);
    const identity = generateIdentity();
    writeFileSync(path, JSON.stringify({
      publicKey: Array.from(identity.publicKey),
      secretKey: Array.from(identity.secretKey),
      did: identity.did,
    }));

    expect(loadOrCreateRelayIdentity(dir)).toEqual(identity);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      kind: 'relay-infrastructure-identity',
      did: identity.did,
    });
  });

  it('repairs permissive file permissions when loading', () => {
    if (process.platform === 'win32') return;
    const dir = directory();
    const identity = loadOrCreateRelayIdentity(dir);
    const path = join(dir, RELAY_IDENTITY_FILENAME);
    chmodSync(path, 0o644);

    expect(loadOrCreateRelayIdentity(dir)).toEqual(identity);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['truncated JSON', '{"version":1'],
    ['unknown fields', JSON.stringify({ version: 1, surprise: true })],
    ['mismatched keypair', undefined],
    ['mismatched DID', null],
  ])('fails closed for %s instead of silently rotating', (_label, fixture) => {
    const dir = directory();
    const path = join(dir, RELAY_IDENTITY_FILENAME);
    const first = generateIdentity();
    const second = generateIdentity();
    const source = fixture === undefined
      ? storedIdentity(first, { secretKey: encodeBase64(second.secretKey) })
      : fixture === null
        ? storedIdentity(first, { did: second.did })
        : fixture;
    writeFileSync(path, source);

    expect(() => loadOrCreateRelayIdentity(dir)).toThrow(/relay infrastructure identity/i);
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  it('rejects a symbolic-link identity file', () => {
    if (process.platform === 'win32') return;
    const dir = directory();
    const target = join(dir, 'target.json');
    const source = storedIdentity(generateIdentity());
    writeFileSync(target, source);
    symlinkSync(target, join(dir, RELAY_IDENTITY_FILENAME));

    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('regular file');
    expect(readFileSync(target, 'utf8')).toBe(source);
  });
});

function storedIdentity(identity: ReturnType<typeof generateIdentity>, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    version: 1,
    kind: 'relay-infrastructure-identity',
    algorithm: 'Ed25519',
    did: identity.did,
    publicKey: encodeBase64(identity.publicKey),
    secretKey: encodeBase64(identity.secretKey),
    ...overrides,
  })}\n`;
}
