#!/usr/bin/env node

/**
 * Resonance Desktop — Entry point.
 * Starts the HTTP server and opens the browser.
 */

import { createAppServer } from './server.js';
import { lockSession } from './session.js';

const PORT = parseInt(process.env.RESONANCE_PORT ?? '3000');
const RELAY_URL = process.env.RESONANCE_RELAY ?? 'ws://localhost:9091';

const server = createAppServer({ port: PORT, relayUrl: RELAY_URL });

async function main(): Promise<void> {
  console.log('Starting Resonance...');
  await server.start();
  console.log(`Resonance running on port ${PORT}`);
}

async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  lockSession();
  await server.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
