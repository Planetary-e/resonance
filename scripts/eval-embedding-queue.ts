/** Exercise the production bounded engine at its maximum accepted token length. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { EmbeddingEngine, EMBEDDING_CONFIG, MAX_EMBEDDING_OPERATIONS, MAX_EMBEDDING_TOKENS } from '@resonance/core';
import { configureModelFileCache } from '../packages/core/src/model-file-cache.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
env.allowRemoteModels = false; configureModelFileCache(env);
const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_CONFIG.modelId);
let words = MAX_EMBEDDING_TOKENS, text = '', tokens = 0;
do {
  text = Array(words--).fill('garden').join(' ');
  tokens = tokenizer(`search_document: ${text}`, { padding: true, truncation: false }).input_ids.dims[1];
} while (tokens > MAX_EMBEDDING_TOKENS);
assert.equal(tokens, MAX_EMBEDDING_TOKENS);
const engine = new EmbeddingEngine();
try {
  await engine.initialize();
  const started = performance.now(), cpuStarted = process.cpuUsage();
  const requests = Array.from({ length: MAX_EMBEDDING_OPERATIONS + 1 }, () => engine.embed(text));
  const outcomes = await Promise.allSettled(requests), elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuStarted);
  const accepted = outcomes.slice(0, MAX_EMBEDDING_OPERATIONS);
  assert(accepted.every(row => row.status === 'fulfilled')); assert.equal(outcomes.at(-1)!.status, 'rejected');
  const vectors = accepted.map(row => (row as PromiseFulfilledResult<Float32Array>).value);
  assert(vectors.every(vector => Buffer.from(vector.buffer).equals(Buffer.from(vectors[0].buffer))));
  // Lock/dispose while native work is active: one finishes, seven never start.
  const closingRequests = Array.from({ length: MAX_EMBEDDING_OPERATIONS }, () => engine.embed(text));
  const closingOutcomes = Promise.allSettled(closingRequests); await engine.dispose();
  const closed = await closingOutcomes;
  assert.equal(closed.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(closed.filter(row => row.status === 'rejected').length, MAX_EMBEDDING_OPERATIONS - 1);
  const report = { measuredAt: new Date().toISOString(), model: EMBEDDING_CONFIG.modelId, dtype: 'fp32', tokens,
    submitted: requests.length, completed: accepted.length, refusedBeforeInference: 1, identicalVectors: vectors.length,
    elapsedMs, cpuSeconds: (cpu.user + cpu.system) / 1e6,
    disposal: { completedActive: 1, rejectedQueued: MAX_EMBEDDING_OPERATIONS - 1 },
    peakRssBytes: process.resourceUsage().maxRSS * 1024, finalRssBytes: process.memoryUsage().rss,
    node: process.version, platform: process.platform, architecture: process.arch,
    limitations: ['One host, one engine and repeated public words at the configured maximum length.',
      'No application, network or device-energy certification. Already-running native inference cannot be forcibly cancelled.'] };
  const out = values.out ?? '/tmp/resonance-embedding-queue.json'; writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await engine.dispose(); }
