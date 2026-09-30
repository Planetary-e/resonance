/** One explicitly approved offline batch. No server, account directory, or network. */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { issueAdmissionBatch } from '../packages/node/src/blind-admission-issuance.js';

const [approval, profilePath, privateKeyPath, requestPath, responsePath, ...extra] = process.argv.slice(2);
if (approval !== '--approve' || !profilePath || !privateKeyPath || !requestPath || !responsePath || extra.length) {
  console.error('Usage: node --import tsx scripts/issue-admission-tokens.ts --approve issuer-profile.json issuer-private.pem request.json response.json');
  console.error('Approve only after applying your community eligibility/allowance policy. Use a distinct key for every token period.');
  process.exitCode = 1;
} else {
  try {
    function read(path: string) {
      if (statSync(path).size > 32768) throw new Error('Issuer input exceeds 32 KiB');
      return readFileSync(path, 'utf8');
    }
    const pem = read(privateKeyPath).trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
    if (!pem) throw new Error('Expected one PKCS8 private key');
    const bytes = Buffer.from(pem[1].replace(/\s/g, ''), 'base64');
    let privateKey: CryptoKey;
    // The Blind RSA library exports RSA parameters internally to perform blind signing.
    try { privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']); }
    finally { bytes.fill(0); }
    const result = await issueAdmissionBatch({ request: JSON.parse(read(requestPath)), expectedProfile: JSON.parse(read(profilePath)), privateKey });
    // Refuse overwriting any input, key or prior response.
    writeFileSync(responsePath, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Approved ${result.responses.length} blinded tokens. Signed response saved.`);
  } catch (error) { console.error(error instanceof Error ? error.message : 'Issuance failed'); process.exitCode = 1; }
}
