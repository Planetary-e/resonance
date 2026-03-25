#!/usr/bin/env node

/**
 * Resonance Desktop — Entry point.
 * Starts the HTTP server and opens the browser.
 */

import { createAppServer } from './server.js';
import { lockSession } from './session.js';
import { platform } from 'node:os';
import { exec } from 'node:child_process';

const PORT = parseInt(process.env.RESONANCE_PORT ?? '3000');
const RELAY_URL = process.env.RESONANCE_RELAY ?? 'ws://localhost:9090';

const server = createAppServer({ port: PORT, relayUrl: RELAY_URL });

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${url}`, () => {});
}

async function main(): Promise<void> {
  console.log('Starting Resonance...');
  await server.start();
  const url = `http://localhost:${PORT}`;
  console.log(`Resonance running at ${url}`);
  console.log(`Relay: ${RELAY_URL}`);
  console.log('');
  openBrowser(url);
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
