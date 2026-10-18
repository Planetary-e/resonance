/** Exercise a cold model cache through the real library, without Internet access. */
import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { env } from '@huggingface/transformers';
import { EmbeddingEngine, EMBEDDING_CONFIG, getSharedProjectionMatrix, hashEmbedding } from '@resonance/core';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert(env.cacheDir);
const source = join(env.cacheDir, EMBEDDING_CONFIG.modelId), temporary = mkdtempSync(join(tmpdir(), 'resonance-model-download-'));
const files = ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model.onnx'];
for (const file of files) assert(existsSync(join(source, file)), 'The complete local FP32 model is required');
const previous = { cacheDir: env.cacheDir, allowRemoteModels: env.allowRemoteModels, fetch: env.fetch };
const requests: string[] = []; let servedBytes = 0, activeReads = 0;
env.cacheDir = temporary; env.allowRemoteModels = true;
env.fetch = (async input => {
  const url = String(input), prefix = `https://huggingface.co/${EMBEDDING_CONFIG.modelId}/resolve/main/`;
  assert(url.startsWith(prefix), 'Unexpected model request; no Internet fallback is allowed');
  const file = url.slice(prefix.length); requests.push(file);
  if (!files.includes(file)) return new Response(null, { status: 404 });
  const path = join(source, file), stream = createReadStream(path); activeReads++;
  stream.once('close', () => { activeReads--; }); stream.on('data', bytes => { servedBytes += Buffer.byteLength(bytes); });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array<ArrayBuffer>>, {
    headers: { 'content-length': String(statSync(path).size) },
  });
}) as typeof env.fetch;
let engine: EmbeddingEngine | undefined;
try {
  engine = new EmbeddingEngine(); await engine.initialize();
  const vector = await engine.embed('A public local download test');
  assert.equal(vector.length, 768); assert(vector.every(Number.isFinite));
  await engine.dispose(); const downloadRequestCount = requests.length;
  env.allowRemoteModels = false;
  engine = new EmbeddingEngine(); await engine.initialize(); const reopened = await engine.embed('A public local download test'); await engine.dispose();
  assert(Buffer.from(vector.buffer).equals(Buffer.from(reopened.buffer)), 'Cached reload changed the embedding');
  assert.equal(requests.length, downloadRequestCount, 'Reload attempted a download');
  assert.equal(activeReads, 0, 'A download stream was left open');
  assert.equal(servedBytes, files.reduce((sum, file) => sum + statSync(join(source, file)).size, 0));
  const report = { measuredAt: new Date().toISOString(), model: EMBEDDING_CONFIG.modelId, dtype: 'fp32', network: 'No external requests; fetch serves cached model files as streams.',
    checkpoints: ['Cold-cache pipeline downloaded and loaded all real model artifacts', 'All download streams closed',
      'Reopened cache works with downloads disabled', 'Reopened embedding is byte-identical'], files: files.map(file => ({ file, bytes: statSync(join(temporary, EMBEDDING_CONFIG.modelId, file)).size })),
    servedBytes, downloadRequests: requests, fingerprint: Buffer.from(hashEmbedding(vector, getSharedProjectionMatrix())).toString('hex'),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, platform: process.platform, architecture: process.arch };
  const out = resolve(values.out ?? '/tmp/resonance-model-cache-download.json'); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, checkpoints: report.checkpoints, servedBytes, peakRssBytes: report.peakRssBytes }, null, 2));
} finally { await engine?.dispose(); Object.assign(env, previous); rmSync(temporary, { recursive: true, force: true }); }
