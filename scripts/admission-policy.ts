/** Offline authority keys and signed policy files. This never distributes trust automatically. */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '@resonance/core';
import { signAdmissionPolicy, admissionAuthorityFingerprint } from '@resonance/core/admission-policy';

try {
  const [command, first, second, third, ...extra] = process.argv.slice(2);
  if (extra.length || !first) throw new Error('Invalid policy command');
  const read = (path: string) => { if (statSync(path).size > 65536) throw new Error('Policy input exceeds 64 KiB'); return readFileSync(path, 'utf8'); };
  const write = (path: string, data: string) => writeFileSync(path, data + '\n', { flag: 'wx', mode: 0o600 });
  if (command === 'authority-keygen' && second && !third) {
    if (existsSync(first) || existsSync(second)) throw new Error('Authority output already exists');
    const key = generateSigningKeyPair();
    try {
      const publicKey = Buffer.from(key.publicKey).toString('base64url');
      write(first, JSON.stringify({ publicKey, secretKey: Buffer.from(key.secretKey).toString('base64url') }));
      write(second, publicKey); console.log(`Community authority: ${admissionAuthorityFingerprint(publicKey)}`);
    } finally { key.secretKey.fill(0); }
  } else if (command === 'storage-keygen' && !second && !third) {
    const key = randomBytes(32); try { write(first, key.toString('hex')); } finally { key.fill(0); }
    console.log('Local relay policy storage key created.');
  } else if (command === 'sign' && second && third) {
    if (existsSync(third)) throw new Error('Policy output already exists');
    const key = JSON.parse(read(first)); const secret = Buffer.from(key.secretKey, 'base64url');
    try { const signed = await signAdmissionPolicy(JSON.parse(read(second)), key.publicKey, secret); write(third, JSON.stringify(signed)); }
    finally { secret.fill(0); }
    console.log('Signed policy saved. Distribute it with the independently verified authority key.');
  } else throw new Error('Invalid policy command');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Policy operation failed');
  console.error('Usage: node --import tsx scripts/admission-policy.ts authority-keygen authority-private.json authority.pub');
  console.error('       node --import tsx scripts/admission-policy.ts storage-keygen local-policy-key.hex');
  console.error('       node --import tsx scripts/admission-policy.ts sign authority-private.json policy-body.json policy.json');
  process.exitCode = 1;
}
