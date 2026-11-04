import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { acquireRelayRuntime } from '../../../../../relay/src/relay-maintenance.js';
const [directory, authorityId, data] = process.argv.slice(2);
const authority = openStorageReservationAuthority({ directory, authorityId, mode: 'open-existing' });
try {
  const release = withStorageReservationAuthority(authority, () => acquireRelayRuntime(data));
  try { if (authority.status().availableBytes !== 0) throw new Error('Fixture must use its full budget'); process.stdout.write('owned\n'); }
  finally { release(); }
} finally { authority.close(); }
