import { expect, it } from 'vitest';
import { generateIdentity, exportIdentity, importIdentity, encodeBase64, decodeUTF8, sha512, secretboxEncrypt,
  MAX_ENCRYPTED_IDENTITY_BYTES } from '../crypto.js';

function legacy(data: unknown, version?: number) {
  const key = sha512(decodeUTF8('legacy password')).slice(0, 32);
  try {
    const encrypted = secretboxEncrypt(decodeUTF8(JSON.stringify(data)), key);
    return JSON.stringify({ ...(version === undefined ? {} : { version }), nonce: encodeBase64(encrypted.nonce), ciphertext: encodeBase64(encrypted.ciphertext) });
  } finally { key.fill(0); }
}
function plaintext() {
  const identity = generateIdentity();
  const data = { publicKey: encodeBase64(identity.publicKey), secretKey: encodeBase64(identity.secretKey), did: identity.did };
  identity.secretKey.fill(0); return data;
}

it.each([undefined, 1])('retains valid legacy format %s without treating other versions as legacy', async version => {
  const data = plaintext(), recovered = await importIdentity(legacy(data, version), 'legacy password');
  expect(recovered.did).toBe(data.did); expect(encodeBase64(recovered.secretKey)).toBe(data.secretKey); recovered.secretKey.fill(0);
});
it('checks the key relationship and identifier even when the encrypted plaintext has a valid MAC', async () => {
  const data = plaintext(), other = plaintext();
  for (const altered of [{ ...data, did: other.did }, { ...data, publicKey: other.publicKey }, { ...data, secretKey: other.secretKey },
    { ...data, secretKey: encodeBase64(new Uint8Array(63)) }, { ...data, extra: true }, [], null]) {
    await expect(importIdentity(legacy(altered), 'legacy password')).rejects.toThrow();
  }
});
it('rejects unknown envelopes, noncanonical base64, wrong salt/nonce lengths and oversized input', async () => {
  const encrypted = await exportIdentity(generateIdentity(), 'password'), parsed = JSON.parse(encrypted);
  for (const altered of [{ ...parsed, version: 3 }, { ...parsed, version: 1 }, { ...parsed, extra: true },
    { ...parsed, salt: encodeBase64(new Uint8Array(15)) }, { ...parsed, nonce: encodeBase64(new Uint8Array(23)) },
    { ...parsed, ciphertext: parsed.ciphertext + '\n' }, { ...parsed, ciphertext: '' }]) {
    await expect(importIdentity(JSON.stringify(altered), 'password')).rejects.toThrow();
  }
  await expect(importIdentity(' '.repeat(MAX_ENCRYPTED_IDENTITY_BYTES + 1), 'password')).rejects.toThrow('Invalid encrypted identity');
});
it('captures a valid identity before awaiting password derivation and rejects invalid exports', async () => {
  const identity = generateIdentity(), original = { did: identity.did, publicKey: identity.publicKey.slice(), secretKey: identity.secretKey.slice() };
  const pending = exportIdentity(identity, 'password'); identity.publicKey.fill(0); identity.secretKey.fill(0);
  const recovered = await importIdentity(await pending, 'password'); expect(recovered).toEqual(original);
  await expect(exportIdentity(identity, 'password')).rejects.toThrow();
  original.secretKey.fill(0); recovered.secretKey.fill(0);
});
