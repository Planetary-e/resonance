import { HnswIndex } from '@resonance/relay';
import { createAppServer } from '../../server.js';

// Run with --no-addons: importing the ordinary application may not attempt to
// load the native legacy evaluation index, even when its package is installed.
const app = createAppServer({ port: 0, relayUrl: 'ws://127.0.0.1:9/' });
try {
  const port = await app.start(), response = await fetch(`http://127.0.0.1:${port}/api/status`);
  if (!response.ok) throw new Error('Desktop status unavailable without native addons');
  const status = await response.json() as { unlocked: boolean };
  if (status.unlocked) throw new Error('Fixture must remain locked');
  let refused = false;
  try { new HnswIndex({ dimensions: 4, maxElements: 10 }).initialize(); }
  catch (error) {
    if (!(error instanceof Error) || !/addon|bindings/i.test(error.message)) throw error;
    refused = true;
  }
  if (!refused) throw new Error('Native HNSW initialization must require its real native module');
  process.stdout.write('desktop-started-without-native-addons\n');
} finally { await app.stop(); }
