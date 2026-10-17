import {
  chmodSync,
  existsSync,
  linkSync,
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
  loadExistingRelayIdentity,
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

  it('encrypts a new identity and refuses missing, wrong, or tampered passphrases', () => {
    const dir = directory();
    const passphrase = 'correct-horse-battery-staple-local';
    const identity = loadOrCreateRelayIdentity(dir, passphrase);
    const path = join(dir, RELAY_IDENTITY_FILENAME);
    const stored = readFileSync(path, 'utf8');
    expect(stored).toContain('relay-infrastructure-identity-encrypted');
    expect(stored).not.toContain(encodeBase64(identity.secretKey));
    expect(loadOrCreateRelayIdentity(dir, passphrase)).toEqual(identity);
    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('passphrase required');
    expect(() => loadOrCreateRelayIdentity(dir, 'wrong-passphrase-with-16-chars'))
      .toThrow('wrong passphrase or corrupt');
    const tampered = JSON.parse(stored);
    tampered.tag = Buffer.alloc(16).toString('base64');
    writeFileSync(path, JSON.stringify(tampered));
    expect(() => loadOrCreateRelayIdentity(dir, passphrase)).toThrow('wrong passphrase or corrupt');
  });

  it('atomically migrates an existing plaintext identity when a passphrase is supplied', () => {
    const dir = directory();
    const original = loadOrCreateRelayIdentity(dir);
    const passphrase = 'another-long-relay-passphrase';
    expect(loadOrCreateRelayIdentity(dir, passphrase)).toEqual(original);
    const stored = readFileSync(join(dir, RELAY_IDENTITY_FILENAME), 'utf8');
    expect(stored).toContain('relay-infrastructure-identity-encrypted');
    expect(stored).not.toContain(encodeBase64(original.secretKey));
    expect(loadOrCreateRelayIdentity(dir, passphrase)).toEqual(original);
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

  it.each(['other-key', 'plaintext-downgrade', 'partial', 'oversized', 'invalid-utf8'])('preserves the original and refuses ambiguous pending %s', kind => {
    const dir = directory(), path = join(dir, RELAY_IDENTITY_FILENAME), pending = join(dir, `.${RELAY_IDENTITY_FILENAME}.pending`);
    const password = 'relay key fixture password long enough', identity = loadOrCreateRelayIdentity(dir, password), original = readFileSync(path);
    const other = directory(); loadOrCreateRelayIdentity(other, password).secretKey.fill(0);
    const candidate = kind === 'other-key' ? readFileSync(join(other, RELAY_IDENTITY_FILENAME))
      : kind === 'plaintext-downgrade' ? Buffer.from(storedIdentity(identity))
      : kind === 'oversized' ? Buffer.alloc(4097) : kind === 'invalid-utf8' ? Buffer.from([0xff]) : Buffer.from('{');
    writeFileSync(pending, candidate);
    expect(() => loadOrCreateRelayIdentity(dir, password)).toThrow();
    expect(readFileSync(path)).toEqual(original); expect(readFileSync(pending)).toEqual(candidate); identity.secretKey.fill(0);
  });

  it.each([false, true])('preserves old random temporary keys and refuses to guess (primary=%s)', primary => {
    const dir = directory(), path = join(dir, RELAY_IDENTITY_FILENAME);
    const original = primary ? loadOrCreateRelayIdentity(dir) : undefined;
    const orphan = join(dir, `.${RELAY_IDENTITY_FILENAME}.123.aabb.tmp`), bytes = storedIdentity(generateIdentity());
    writeFileSync(orphan, bytes);
    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('preserve temporary keys');
    expect(readFileSync(orphan, 'utf8')).toBe(bytes); expect(existsSync(path)).toBe(primary); original?.secretKey.fill(0);
  });

  it('refuses hard links and dangling symlinks before generating another identity', () => {
    const dir = directory(), path = join(dir, RELAY_IDENTITY_FILENAME);
    const identity = loadOrCreateRelayIdentity(dir), original = readFileSync(path);
    const other = join(dir, 'other'); linkSync(path, other);
    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('single link'); expect(readFileSync(path)).toEqual(original);
    rmSync(other); identity.secretKey.fill(0);
    if (process.platform === 'win32') return;
    rmSync(path); symlinkSync(other, path);
    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('regular file'); expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it('reads an operator identity without migration, cleanup or permission changes', () => {
    const dir = directory(), password = 'read only fixture long passphrase', path = join(dir, RELAY_IDENTITY_FILENAME);
    const identity = loadOrCreateRelayIdentity(dir, password), bytes = readFileSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o640);
    const pending = join(dir, `.${RELAY_IDENTITY_FILENAME}.pending`); writeFileSync(pending, '{');
    const read = loadExistingRelayIdentity(dir, password); expect(read).toEqual(identity);
    expect(readFileSync(path)).toEqual(bytes); expect(readFileSync(pending, 'utf8')).toBe('{');
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o640);
    read.secretKey.fill(0); identity.secretKey.fill(0);
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
