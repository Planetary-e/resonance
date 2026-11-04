import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAdmissionSpendHistory } from '../../admission-spend-history.js';
const directory = process.argv[2], input = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const history = openAdmissionSpendHistory({ directory, policy: input.policy, encryptionKey: Buffer.from(input.encryptionKey, 'base64url'), now: () => input.time });
await history.recoverLegacy(input.proofs, (await history.planLegacyRecovery(input.proofs)).approvalDigest);
process.send?.({ recovered: true });
setInterval(() => {}, 1000); // Parent kills the process without releasing its ledger lock.
