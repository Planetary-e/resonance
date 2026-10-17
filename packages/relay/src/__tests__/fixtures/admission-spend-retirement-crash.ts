import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAdmissionSpendHistory } from '../../admission-spend-history.js';
const directory = process.argv[2], input = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const history = openAdmissionSpendHistory({ directory, policy: input.policy, encryptionKey: Buffer.from(input.encryptionKey, 'base64url'), now: () => input.time });
history.retire(input.issuerKey, history.planRetirement(input.issuerKey).approvalDigest);
process.send?.({ retired: true });
setInterval(() => {}, 1000); // Parent kills this process without releasing the ledger lock.
