import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openManagedAdmissionWallet } from '../../managed-admission-wallet.js';
const directory = process.argv[2];
const fixture = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const wallet = await openManagedAdmissionWallet({ directory, encryptionKey: Buffer.from(fixture.key, 'hex'), now: () => fixture.time });
wallet.retire(fixture.issuerKey, wallet.planRetirement(fixture.issuerKey).approvalDigest);
process.send?.({ retired: true });
setInterval(() => {}, 1000);
