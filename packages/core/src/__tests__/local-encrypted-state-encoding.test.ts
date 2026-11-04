import { afterEach, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEncryptedLocalState } from '../local-encrypted-state.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'encrypted-encoding-')); directories.push(directory);
  const path = join(directory, 'state'), key = randomBytes(32), domain = 'resonance:test-encoding:v1';
  const options = { path, key, domain, maxBytes: 4096, initial: { text: 'retained' },
    validate: (value: unknown): value is { text: string } => !!value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string', mode: 'open-existing' as const };
  const envelope = (plaintext: Buffer) => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(domain));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  };
  const publish = (plaintext: Buffer) => { const record = envelope(plaintext); writeFileSync(path, JSON.stringify(record)); return record; };
  return { path, options, envelope, publish };
}

it.each([
  [0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82],
])('refuses authenticated plaintext with malformed UTF-8 %j and retains the exact file', (...bytes) => {
  const n = fixture(); n.publish(Buffer.concat([Buffer.from('{"text":"private-'), Buffer.from(bytes), Buffer.from('"}')]));
  const retained = readFileSync(n.path);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(() => openEncryptedLocalState(n.options)).toThrow('Encrypted outbox state is invalid');
    expect(readFileSync(n.path)).toEqual(retained);
  }
});

it('redacts authenticated invalid JSON and accepts genuine Unicode including a literal replacement character', () => {
  const n = fixture(); n.publish(Buffer.from('{"text":"private-ciphertext-content",broken}'));
  let message = ''; try { openEncryptedLocalState(n.options); } catch (error) { message = String(error); }
  expect(message).toContain('state is invalid'); expect(message).not.toContain('private-ciphertext-content');
  const value = { text: 'Español 🌍 \uFFFD' }; n.publish(Buffer.from(JSON.stringify(value)));
  const state = openEncryptedLocalState(n.options); try { expect(state.read()).toEqual(value); } finally { state.close(); }
});

it('does not broaden the JSON contract by silently removing a byte-order mark', () => {
  const n = fixture(), prefix = Buffer.from([0xef, 0xbb, 0xbf]);
  n.publish(Buffer.concat([prefix, Buffer.from('{"text":"retained"}')]));
  expect(() => openEncryptedLocalState(n.options)).toThrow('state is invalid');
  const valid = n.envelope(Buffer.from('{"text":"retained"}'));
  writeFileSync(n.path, Buffer.concat([prefix, Buffer.from(JSON.stringify(valid))]));
  expect(() => openEncryptedLocalState(n.options)).toThrow('file is invalid');
});

it('rejects noncanonical base64 aliases even when they decode to authenticated ciphertext or tags', () => {
  const n = fixture(), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const record = n.publish(Buffer.from('{"text":"abc"}'));
  for (const field of ['tag', 'ciphertext'] as const) {
    const original = record[field]; expect(original.length % 4).not.toBe(0);
    const changed = original.slice(0, -1) + alphabet[alphabet.indexOf(original.at(-1)!) + 1];
    expect(Buffer.from(changed, 'base64url')).toEqual(Buffer.from(original, 'base64url'));
    const modified = { ...record, [field]: changed }; writeFileSync(n.path, JSON.stringify(modified));
    expect(() => openEncryptedLocalState(n.options)).toThrow('file is invalid');
    expect(JSON.parse(readFileSync(n.path, 'utf8'))).toEqual(modified);
  }
});
