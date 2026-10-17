import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAdmissionIssuerLedger } from '../../admission-issuer-ledger.js';
const directory = process.argv[2], input = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(input.privateKey, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
const ledger = await openAdmissionIssuerLedger({ path: join(directory, 'issuer.json'), expectedProfile: input.profile, privateKey, now: () => input.time });
ledger.retire(input.authority, ledger.planRetirement(input.authority).approvalDigest);
process.send?.({ retired: true });
setInterval(() => {}, 1000);
