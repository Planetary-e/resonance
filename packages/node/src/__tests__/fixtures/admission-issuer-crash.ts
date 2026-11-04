import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { openAdmissionIssuerLedger } from '../../admission-issuer-ledger.js';
const [directory] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(fixture.privateKey, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
const ledger = await openAdmissionIssuerLedger({ path: join(directory, 'ledger.json'), expectedProfile: fixture.profile, privateKey });
const original = publicVerif.Issuer.prototype.issue;
let signatures = 0;
publicVerif.Issuer.prototype.issue = async function (...args) {
  if (++signatures === 2) {
    process.send?.({ reserved: true, signaturesCompleted: 1 });
    return new Promise(() => {}); // Kill after one signature, before completing/caching the batch.
  }
  return original.apply(this, args);
};
setInterval(() => {}, 1000);
await ledger.approve(fixture.permit, fixture.request);
throw new Error('Crash fixture unexpectedly finished approval');
