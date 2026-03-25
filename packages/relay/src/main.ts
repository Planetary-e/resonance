#!/usr/bin/env node

/**
 * Relay server entry point. Configured via environment variables.
 */

import { createRelayServer } from './server.js';

const server = createRelayServer({
  port: parseInt(process.env.RELAY_PORT ?? '9090'),
  host: process.env.RELAY_HOST ?? '0.0.0.0',
  persistDir: process.env.RELAY_DATA_DIR ?? './data',
});

await server.start();

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
