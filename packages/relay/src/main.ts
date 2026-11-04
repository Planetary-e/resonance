#!/usr/bin/env node
/** Set up bounded service diagnostics before loading the relay and its dependencies. */
import { configureServiceDiagnostics, log } from './logger.js';
import { openSelectedRelayStorageOwner } from './selected-relay-storage.js';
try {
  const start = async () => {
    configureServiceDiagnostics(process.env.RELAY_DIAGNOSTICS_DIRECTORY);
    await import('./runtime.js');
  };
  const selected = process.env.RELAY_STORAGE_SELECTION_FILE;
  if (selected) {
    const owner = await openSelectedRelayStorageOwner(selected, { purpose: 'runtime', runtimeDirectory: process.env.RELAY_DATA_DIR ?? './data',
      runtimePort: Number(process.env.RELAY_PORT ?? 9090), runtimeHost: process.env.RELAY_HOST ?? '127.0.0.1' });
    // Do not release at the end of import: timers, factories and listeners retain
    // this authority until the runtime has finished shutting down and exits.
    process.once('exit', () => owner.close());
    await owner.run(start);
  } else await start();
} catch (error) {
  log('error', 'relay_startup_failed', { error: String(error) });
  process.exitCode = 1;
  // A failed dynamic startup may already own handles. Finish queued console
  // output, then exit so the service manager can restart; do not leave it hung.
  const deadline = setTimeout(() => process.exit(1), 1000); deadline.unref();
  process.stdout.write('', () => process.exit(1));
}
