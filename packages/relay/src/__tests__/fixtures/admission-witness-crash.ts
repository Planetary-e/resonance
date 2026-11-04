import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionWitness } from '../../admission-witness.js';
const directory = process.argv[2], input = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const witness = createAdmissionWitness({ directory, policy: input.policy, encryptionKey: Buffer.from(input.encryptionKey, 'base64url'),
  signingKey: { publicKey: Buffer.from(input.publicKey, 'base64url'), secretKey: Buffer.from(input.secretKey, 'base64url') }, initialize: true });
witness.vote(input.request);
process.send?.({ persisted: true });
setInterval(() => {}, 1000);
