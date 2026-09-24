// Exercise the bundled backend outside the repository, where missing modules
// cannot be resolved from an ancestor node_modules directory.
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [resourceArgument, sidecarArgument] = process.argv.slice(2);
if (!resourceArgument || !sidecarArgument) {
  throw new Error('Usage: node smoke-runtime.mjs <server-resources> <node-sidecar>');
}
const resourceDir = resolve(resourceArgument);
const sidecar = resolve(sidecarArgument);
const testDir = await mkdtemp(join(tmpdir(), 'resonance-runtime-smoke-'));
const isolatedServer = join(testDir, 'server');
let backend;

async function freePort() {
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', accept);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

try {
  await cp(resourceDir, isolatedServer, { recursive: true });
  const nativeCheck = spawnSync(sidecar, [
    '--input-type=module', '-e',
    'const sharp = (await import("sharp")).default; ' +
    'await sharp({create:{width:1,height:1,channels:3,background:"red"}}).png().toBuffer(); ' +
    'await import("onnxruntime-node"); await import("@huggingface/transformers");',
  ], { cwd: isolatedServer, encoding: 'utf8', timeout: 30000 });
  if (nativeCheck.status !== 0) {
    throw new Error(`Bundled native modules failed: ${nativeCheck.error || nativeCheck.stderr}`);
  }

  const port = await freePort();
  backend = spawn(sidecar, [join(isolatedServer, 'server.mjs')], {
    cwd: isolatedServer,
    env: { ...process.env, RESONANCE_DATA_DIR: join(testDir, 'data'), RESONANCE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  backend.stdout.on('data', chunk => { output += chunk; });
  backend.stderr.on('data', chunk => { output += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (backend.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok && (await response.json()).initialized === false) {
        healthy = true;
        break;
      }
    } catch { /* Still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  if (!healthy) throw new Error(`Bundled backend did not start: ${output}`);
  console.log('isolated-runtime-smoke-ok');
} finally {
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise(resolve => backend.once('exit', resolve));
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
