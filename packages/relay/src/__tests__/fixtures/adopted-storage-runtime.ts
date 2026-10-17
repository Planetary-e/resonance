/** Inject the internal authority into the real entry point without exposing an
 * incomplete product quota option or using the operator's live service. */
import { openRelayStorageOwner } from '../../relay-storage-owner.js';
const [authorityDirectory, authorityId] = process.argv.slice(2);
const owner = openRelayStorageOwner({ authorityDirectory, authorityId, runtimeDirectory: process.env.RELAY_DATA_DIR! }, 'runtime');
process.once('exit', () => owner.close());
await owner.run(() => import('../../main.js'));
