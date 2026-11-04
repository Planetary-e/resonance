/** Read a bounded operator secret without copying it into a service definition. */
import { readOperatorFile } from './admission-operator-files.js';

export function readRelayIdentityPassphrase(passphrase?: string, path?: string): string | undefined {
  if (passphrase && path) throw new Error('Choose one relay identity passphrase source');
  if (!path) return passphrase || undefined;
  let bytes: Buffer | undefined;
  try {
    bytes = readOperatorFile(path, 4096);
    // Permit the single line ending produced by a text editor; other whitespace
    // is part of the secret and must not silently change an existing keystore key.
    const value = new TextDecoder('utf8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
    if (value.length < 16 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid passphrase');
    return value;
  } catch { throw new Error('Relay identity passphrase file must contain one valid line of 16 or more characters within 4096 bytes'); }
  finally { bytes?.fill(0); }
}
