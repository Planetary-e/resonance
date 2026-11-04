import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeBase64, decodeUTF8, generateIdentity, exportIdentity, secretboxEncrypt, sha512 } from '@resonance/core';
import { createIdentityManager } from '../identity.js';
import { openIdentityFile } from '../identity-file.js';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES, withStorageReservationAuthority } from '@resonance/core/storage-reservations';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'identity-file-')); directories.push(directory);
  const path = join(directory, 'identity.json'); return { path, directory, manager: createIdentityManager(path) };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function intent(path: string, previous: string | null, encrypted: string) {
  writeFileSync(`${path}.pending`, JSON.stringify({ version: 1, kind: 'identity-write', previous, encrypted }), { mode: 0o600 });
}

it('reads existing v1 identities without rewriting them and changes the password atomically to v2', async () => {
  const { path, manager } = fixture(), identity = generateIdentity();
  const key = sha512(decodeUTF8('legacy password')).slice(0, 32);
  const encrypted = secretboxEncrypt(decodeUTF8(JSON.stringify({ did: identity.did, publicKey: encodeBase64(identity.publicKey), secretKey: encodeBase64(identity.secretKey) })), key);
  key.fill(0);
  const original = JSON.stringify({ version: 1, nonce: encodeBase64(encrypted.nonce), ciphertext: encodeBase64(encrypted.ciphertext) }); writeFileSync(path, original);
  const loaded = await manager.load('legacy password'); expect(loaded).toEqual(identity); expect(readFileSync(path, 'utf8')).toBe(original);
  await manager.save(loaded, 'new password'); loaded.secretKey.fill(0);
  expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  const updated = await manager.load('new password'); expect(updated).toEqual(identity); updated.secretKey.fill(0); identity.secretKey.fill(0);
  await expect(manager.load('legacy password')).rejects.toThrow();
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('never recreates an existing or corrupt primary', async () => {
  const { path, manager } = fixture(); writeFileSync(path, 'damaged original');
  expect(manager.exists()).toBe(true);
  await expect(manager.create('password')).rejects.toThrow('already exists');
  await expect(manager.load('password')).rejects.toThrow(); expect(readFileSync(path, 'utf8')).toBe('damaged original');
});

it('does not discard an orphan candidate or an incomplete publication intent', async () => {
  for (const suffix of ['next', 'pending']) {
    const { path, manager } = fixture(); writeFileSync(`${path}.${suffix}`, 'incomplete');
    expect(manager.exists()).toBe(true); await expect(manager.create('password')).rejects.toThrow();
    await expect(manager.load('password')).rejects.toThrow(); expect(readFileSync(`${path}.${suffix}`, 'utf8')).toBe('incomplete');
    expect(existsSync(path)).toBe(false);
  }
});

it('refuses an interrupted replacement when its original is missing or changed', async () => {
  for (const changed of [false, true]) {
    const { path, manager } = fixture(), identity = generateIdentity(), encrypted = await exportIdentity(identity, 'password'); identity.secretKey.fill(0);
    intent(path, hash('original'), encrypted); if (changed) writeFileSync(path, 'another primary');
    const retained = readFileSync(`${path}.pending`);
    await expect(manager.load('password')).rejects.toThrow('retained original');
    await expect(manager.save(generateIdentity(), 'password')).rejects.toThrow('retained original');
    expect(readFileSync(`${path}.pending`)).toEqual(retained);
    if (changed) expect(readFileSync(path, 'utf8')).toBe('another primary'); else expect(existsSync(path)).toBe(false);
  }
});

it('retains a pending replacement until the same key and intended password can resume it', async () => {
  const { path, manager } = fixture(), identity = await manager.create('old password'), previous = readFileSync(path);
  const replacement = await exportIdentity(identity, 'new password'); intent(path, hash(previous), replacement);
  const retainedIntent = readFileSync(`${path}.pending`), old = await manager.load('old password'); old.secretKey.fill(0);
  expect(readFileSync(`${path}.pending`)).toEqual(retainedIntent);
  const unrelated = generateIdentity(); await expect(manager.save(unrelated, 'new password')).rejects.toThrow('Another identity'); unrelated.secretKey.fill(0);
  await expect(manager.save(identity, 'old password')).rejects.toThrow(); expect(readFileSync(path)).toEqual(previous);
  await manager.save(identity, 'new password'); expect(readFileSync(path, 'utf8')).toBe(replacement);
  expect(existsSync(`${path}.pending`)).toBe(false); identity.secretKey.fill(0);
});

it('rejects candidate corruption without changing the retained ciphertext', async () => {
  const { path, manager } = fixture(), identity = await manager.create('old password'), previous = readFileSync(path);
  intent(path, hash(previous), await exportIdentity(identity, 'new password')); writeFileSync(`${path}.next`, 'different');
  await expect(manager.save(identity, 'new password')).rejects.toThrow('differs'); expect(readFileSync(path)).toEqual(previous);
  expect(readFileSync(`${path}.next`, 'utf8')).toBe('different'); identity.secretKey.fill(0);
});

it.each(['', '.pending', '.next'])('rejects oversized files and directories at identity%s', async suffix => {
  const { path, manager } = fixture(); writeFileSync(path + suffix, Buffer.alloc(8193));
  await expect(manager.load('password')).rejects.toThrow('oversized'); await expect(manager.create('password')).rejects.toThrow();
  expect(statSync(path + suffix).size).toBe(8193); rmSync(path + suffix); mkdirSync(path + suffix);
  await expect(manager.load('password')).rejects.toThrow('Unsafe'); expect(statSync(path + suffix).isDirectory()).toBe(true);
});

it.each(['', '.pending', '.next'])('refuses unexpected hard links at identity%s', async suffix => {
  const { path, directory, manager } = fixture(), target = join(directory, 'other'); writeFileSync(target, '{}'); linkSync(target, path + suffix);
  await expect(manager.load('password')).rejects.toThrow(/hard link|publication intent/);
  await expect(manager.create('password')).rejects.toThrow(); expect(readFileSync(target, 'utf8')).toBe('{}');
});

it.skipIf(process.platform === 'win32')('refuses symlinks, including dangling ones, and cannot bypass ownership with a parent alias', async () => {
  const { path, directory, manager } = fixture(), target = join(directory, 'missing'); symlinkSync(target, path);
  expect(manager.exists()).toBe(true); await expect(manager.create('password')).rejects.toThrow('Unsafe'); expect(existsSync(target)).toBe(false);
  rmSync(path); const alias = join(directory, 'alias'); symlinkSync(directory, alias);
  const owned = openIdentityFile(path, true);
  try { await expect(createIdentityManager(join(alias, 'identity.json')).create('password')).rejects.toThrow('already open'); }
  finally { owned.close(); }
});

it('releases ownership after failed decryption and refuses use of a closed handle', async () => {
  const { path, manager } = fixture(); (await manager.create('password')).secretKey.fill(0);
  await expect(manager.load('wrong')).rejects.toThrow(); const loaded = await manager.load('password'); loaded.secretKey.fill(0);
  const owned = openIdentityFile(path, false); owned.close(); await expect(owned.load('password')).rejects.toThrow('closed');
});

it('reserves the entire account write peak and recovers a managed first-publication hard link', async () => {
  const { path, directory, manager } = fixture();
  const authority = openStorageReservationAuthority({ directory: join(directory, 'budget'), mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES + 24576 });
  try {
    const identity = generateIdentity(), encrypted = await exportIdentity(identity, 'password');
    intent(path, null, encrypted); writeFileSync(`${path}.next`, encrypted); linkSync(`${path}.next`, path);
    const recovered = await withStorageReservationAuthority(authority, () => manager.load('password'));
    expect(recovered).toEqual(identity); recovered.secretKey.fill(0); identity.secretKey.fill(0);
    expect(existsSync(`${path}.pending`)).toBe(false); expect(statSync(path).nlink).toBe(1);
    const second = join(directory, 'second.json');
    await expect(withStorageReservationAuthority(authority, () => createIdentityManager(second).create('password'))).rejects.toThrow('exhausted');
    expect(existsSync(second)).toBe(false);
  } finally { authority.close(); }
});
