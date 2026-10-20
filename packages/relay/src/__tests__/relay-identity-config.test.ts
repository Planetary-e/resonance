import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRelayIdentityPassphrase } from '../relay-identity-config.js';

it('reads an explicit private passphrase file without trimming meaningful spaces or accepting conflicting sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-passphrase-')), path = join(directory, 'secret.txt');
  try {
    const secret = '  preserve spaces in this test secret  ';
    for (const ending of ['', '\n', '\r\n']) {
      writeFileSync(path, secret + ending, { mode: 0o600 });
      expect(readRelayIdentityPassphrase(undefined, path)).toBe(secret);
    }
    expect(readRelayIdentityPassphrase(secret)).toBe(secret);
    expect(readRelayIdentityPassphrase('', '')).toBeUndefined();
    expect(() => readRelayIdentityPassphrase(secret, path)).toThrow(/one .* source/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('refuses missing, nonregular, oversized and malformed private input without echoing its contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-passphrase-')), path = join(directory, 'secret.txt');
  try {
    for (const absent of [directory, path]) expect(() => readRelayIdentityPassphrase(undefined, absent)).toThrow(/passphrase file/);
    for (const value of ['short-secret', 's'.repeat(4097), 'private-line-one\nprivate-line-two', 'secret-long-enough\0', Buffer.from([0xff, 0xfe])]) {
      writeFileSync(path, value);
      try { readRelayIdentityPassphrase(undefined, path); expect.fail('Invalid secret was accepted'); }
      catch (error) { expect(String(error)).toContain('passphrase file'); expect(String(error)).not.toContain(value.toString()); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
