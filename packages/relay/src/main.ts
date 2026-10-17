#!/usr/bin/env node
/** Set up bounded service diagnostics before loading the relay and its dependencies. */
import { configureServiceDiagnostics, log } from './logger.js';
try {
  configureServiceDiagnostics(process.env.RELAY_DIAGNOSTICS_DIRECTORY);
  await import('./runtime.js');
} catch (error) {
  log('error', 'relay_startup_failed', { error: String(error) });
  process.exitCode = 1;
  // A failed dynamic startup may already own handles. Finish queued console
  // output, then exit so the service manager can restart; do not leave it hung.
  const deadline = setTimeout(() => process.exit(1), 1000); deadline.unref();
  process.stdout.write('', () => process.exit(1));
}
