import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { acquireRelayRuntime } from '../../relay-maintenance.js';
const [directory, authorityId, data] = process.argv.slice(2);
const authority = openStorageReservationAuthority({ directory, authorityId, mode: 'open-existing' });
const release = withStorageReservationAuthority(authority, () => acquireRelayRuntime(data));
process.on('exit', () => { release(); authority.close(); });
setInterval(() => {}, 1000); process.send!('ready');
