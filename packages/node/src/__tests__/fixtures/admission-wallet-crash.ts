import { openManagedAdmissionWallet } from '../../managed-admission-wallet.js';
import { createAdmissionRequestBindingV2 } from '@resonance/core';
const [directory, secret] = process.argv.slice(2);
const wallet = await openManagedAdmissionWallet({ directory, encryptionKey: Buffer.from(secret, 'hex') });
const capability = wallet.capabilityFor({ relayUrl: 'ws://127.0.0.1:45997/', action: 'search', requestBinding: createAdmissionRequestBindingV2('search', { crash: true }) });
process.send?.(capability);
setInterval(() => {}, 1000);
