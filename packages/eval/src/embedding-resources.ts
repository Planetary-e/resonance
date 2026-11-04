/** Isolated, sequential FP32 runtime comparison. No downloads or live traffic. */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EMBEDDING_CONFIG, getSharedProjectionMatrix, hashEmbedding, rewriteForMatching } from '@resonance/core';
import { configureModelFileCache } from '../../core/src/model-file-cache.js';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

const profiles = {
  baseline: {},
  'two-threads': { intraOpNumThreads: 2 },
  'two-threads-no-arena': { intraOpNumThreads: 2, enableCpuMemArena: false },
  'bounded-cache': {},
} as const;
type Profile = keyof typeof profiles;
const targets = Object.freeze({ maximumVectorDifference: 1e-6, minimumIdenticalFingerprintFraction: 1,
  maximumPeakRssRatio: 0.8, maximumEmbeddingTimeRatio: 1.25, maximumCpuTimeRatio: 1.1,
  desiredPeakRssBytes: 1024 ** 3 });
const { values } = parseArgs({ options: { child: { type: 'string' }, out: { type: 'string' },
  'cache-comparison': { type: 'boolean', default: false }, enforce: { type: 'boolean', default: false } } });
const datasetBytes = readFileSync(new URL('../fixtures/dataset.json', import.meta.url));
type Pair = { need: string; offer: string };
const dataset = JSON.parse(datasetBytes.toString('utf8')) as { positive_pairs: Pair[]; negative_pairs: Pair[] };
const pairs = [...dataset.positive_pairs, ...dataset.negative_pairs];
const texts = ([['need', [...new Set(pairs.map(pair => pair.need))]], ['offer', [...new Set(pairs.map(pair => pair.offer))]]] as const)
  .flatMap(([type, strings]) => strings.map(text => rewriteForMatching(text, type)));
if (!texts.length || texts.length > 1000 || texts.some(text => !text || Buffer.byteLength(text) > 8192)) throw new Error('Invalid public fixture');
env.allowRemoteModels = false;
if (!env.cacheDir) throw new Error('A populated local model cache is required');
type Stage = { phase: string; elapsedMs: number; cpuSeconds: number; rssBytes: number; arrayBufferBytes: number };
type Measurement = { stages: Stage[]; embeddingMs: number; cpuSeconds: number; elapsedMs: number; peakRssBytes: number;
  eagerModelStreamBytes: number; vectors: string };
const rounded = (n: number) => Number(n.toFixed(6));

if (values.child) {
  if (!process.send || !Object.hasOwn(profiles, values.child)) throw new Error('Unknown child profile');
  const profile = values.child as Profile, started = performance.now(), cpuStarted = process.cpuUsage(), stages: Stage[] = [];
  let eagerModelStreamBytes = 0;
  const originalReadStream = fs.createReadStream;
  fs.createReadStream = ((path: Parameters<typeof originalReadStream>[0], options?: Parameters<typeof originalReadStream>[1]) => {
    const stream = originalReadStream(path, options);
    if (String(path).endsWith('/onnx/model.onnx') || String(path).endsWith('\\onnx\\model.onnx')) {
      stream.on('data', chunk => { eagerModelStreamBytes += Buffer.byteLength(chunk); });
    }
    return stream;
  }) as typeof originalReadStream;
  if (profile === 'bounded-cache') configureModelFileCache(env);
  let previousTime = started, previousCpu = cpuStarted;
  function mark(phase: string) {
    const currentTime = performance.now(), currentCpu = process.cpuUsage(), cpu = process.cpuUsage(previousCpu);
    const memory = process.memoryUsage();
    stages.push({ phase, elapsedMs: rounded(currentTime - previousTime), cpuSeconds: rounded((cpu.user + cpu.system) / 1e6), rssBytes: memory.rss,
      arrayBufferBytes: memory.arrayBuffers });
    previousTime = currentTime; previousCpu = currentCpu;
  }
  async function open() {
    // Baseline deliberately preserves the library's original cache even after
    // production switches cache. All profiles use identical inference options.
    const create = pipeline as unknown as (task: 'feature-extraction', model: string, options: {
      dtype: 'fp32'; session_options: typeof profiles[Profile];
    }) => Promise<FeatureExtractionPipeline>;
    const pipe = await create('feature-extraction', EMBEDDING_CONFIG.modelId, { dtype: 'fp32', session_options: profiles[profile] });
    return { embed: async (text: string) => {
      const result = await pipe(`search_document: ${text}`, { pooling: 'mean', normalize: true });
      return new Float32Array(result.data as ArrayLike<number>);
    }, dispose: () => pipe.dispose() };
  }
  // Match setup-probe / active session / lock and unlock lifetimes. No explicit
  // garbage collection: the application does not force collection either.
  let engine = await open(); mark('probe-open');
  if (values['cache-comparison']) { await delay(1000); mark('probe-io-settle'); }
  await engine.dispose(); mark('probe-dispose');
  engine = await open(); mark('session-open');
  const vectors = new Float32Array(texts.length * 768);
  try {
    for (let i = 0; i < texts.length; i++) {
      const vector = await engine.embed(texts[i]);
      if (vector.length !== 768 || vector.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding');
      vectors.set(vector, i * 768);
    }
  } finally {
    mark('session-inference');
    if (values['cache-comparison']) { await delay(1000); mark('session-io-settle'); }
    await engine.dispose();
  }
  const embeddingMs = stages.find(stage => stage.phase === 'session-inference')!.elapsedMs;
  mark('session-dispose'); engine = await open(); mark('unlock-open');
  try {
    await engine.embed(texts[0]); mark('unlock-inference');
    if (values['cache-comparison']) { await delay(1000); mark('unlock-io-settle'); }
  } finally { await engine.dispose(); }
  mark('unlock-dispose');
  const cpu = process.cpuUsage(cpuStarted);
  const measurement: Measurement = { stages, embeddingMs, cpuSeconds: rounded((cpu.user + cpu.system) / 1e6),
    elapsedMs: rounded(performance.now() - started), peakRssBytes: process.resourceUsage().maxRSS * 1024,
    eagerModelStreamBytes, vectors: Buffer.from(vectors.buffer).toString('base64') };
  fs.createReadStream = originalReadStream;
  // Only this public fixture's vectors leave the isolated worker; they are never
  // persisted in the result. Parent waits for actual exit before next profile.
  await new Promise<void>((accept, reject) => process.send!(measurement, error => error ? reject(error) : accept()));
  process.disconnect!();
} else {
  const modelArtifacts = [];
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']) {
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(join(env.cacheDir, EMBEDDING_CONFIG.modelId, file))) digest.update(bytes);
    modelArtifacts.push({ file, sha256: digest.digest('hex') });
  }
  async function run(profile: Profile): Promise<Measurement> {
    return new Promise((accept, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--child', profile, ...(values['cache-comparison'] ? ['--cache-comparison'] : [])], {
        execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let message: Measurement | undefined, diagnostics = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Timed out: ${profile}`)); }, 120_000);
      child.stderr?.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8192); });
      child.on('message', value => { message = value as Measurement; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code !== 0 || !message || typeof message.vectors !== 'string') reject(new Error(`${profile} failed (${code}): ${diagnostics}`));
        else accept(message);
      });
    });
  }
  // Counterbalanced positions, with a separate cache pair comparison. No
  // profile overlaps another process's model lifetime.
  const orders: Profile[][] = values['cache-comparison'] ? [['baseline', 'bounded-cache'], ['bounded-cache', 'baseline']]
    : [['baseline', 'two-threads', 'two-threads-no-arena'], ['two-threads', 'two-threads-no-arena', 'baseline'], ['two-threads-no-arena', 'baseline', 'two-threads']];
  const results: Array<Omit<Measurement, 'vectors'> & { profile: Profile; trial: number; position: number;
    maximumVectorDifference: number; identicalVectors: number; identicalFingerprints: number }> = [];
  let reference: Float32Array | undefined;
  const matrix = getSharedProjectionMatrix();
  for (let trial = 0; trial < orders.length; trial++) {
    for (let position = 0; position < orders[trial].length; position++) {
      const profile = orders[trial][position]; console.error(`Trial ${trial + 1}/${orders.length}: ${profile}`);
      const { vectors: encoded, ...measurement } = await run(profile), bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== texts.length * 768 * 4) throw new Error('Invalid worker vector size');
      const vectors = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      reference ??= vectors;
      let maximumVectorDifference = 0, identicalVectors = 0, identicalFingerprints = 0;
      for (let i = 0; i < texts.length; i++) {
        const actual = vectors.subarray(i * 768, (i + 1) * 768), expected = reference.subarray(i * 768, (i + 1) * 768);
        if (actual.some(value => !Number.isFinite(value))) throw new Error('Nonfinite worker vector');
        if (Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))) identicalVectors++;
        if (Buffer.from(hashEmbedding(actual, matrix)).equals(Buffer.from(hashEmbedding(expected, matrix)))) identicalFingerprints++;
        for (let d = 0; d < actual.length; d++) maximumVectorDifference = Math.max(maximumVectorDifference, Math.abs(actual[d] - expected[d]));
      }
      results.push({ profile, trial: trial + 1, position: position + 1, ...measurement, maximumVectorDifference, identicalVectors, identicalFingerprints });
    }
  }
  const median = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const summaries = [...new Set(orders.flat())].map(name => {
    const rows = results.filter(row => row.profile === name);
    return { profile: name, peakRssBytes: median(rows.map(row => row.peakRssBytes)), embeddingMs: median(rows.map(row => row.embeddingMs)),
      cpuSeconds: median(rows.map(row => row.cpuSeconds)), maximumVectorDifference: Math.max(...rows.map(row => row.maximumVectorDifference)),
      maximumEagerModelStreamBytes: Math.max(...rows.map(row => row.eagerModelStreamBytes)),
      minimumIdenticalVectors: Math.min(...rows.map(row => row.identicalVectors)), minimumIdenticalFingerprints: Math.min(...rows.map(row => row.identicalFingerprints)) };
  });
  const baseline = summaries[0];
  const candidates = summaries.slice(1).map(summary => {
    const ratios = { peakRss: summary.peakRssBytes / baseline.peakRssBytes, embeddingTime: summary.embeddingMs / baseline.embeddingMs, cpuTime: summary.cpuSeconds / baseline.cpuSeconds };
    const gates = { compatibility: summary.maximumVectorDifference <= targets.maximumVectorDifference && summary.minimumIdenticalFingerprints / texts.length >= targets.minimumIdenticalFingerprintFraction,
      memoryReduction: ratios.peakRss <= targets.maximumPeakRssRatio, latency: ratios.embeddingTime <= targets.maximumEmbeddingTimeRatio,
      cpu: ratios.cpuTime <= targets.maximumCpuTimeRatio, desiredPeakMemory: summary.peakRssBytes <= targets.desiredPeakRssBytes,
      ...(values['cache-comparison'] ? { noEagerModelReads: summary.maximumEagerModelStreamBytes === 0 } : {}) };
    return { ...summary, ratios, gates, eligible: Object.values(gates).every(Boolean) };
  });
  const report = { measuredAt: new Date().toISOString(), model: EMBEDDING_CONFIG.modelId, dtype: 'fp32', modelArtifacts,
    datasetSha256: createHash('sha256').update(datasetBytes).digest('hex'), texts: texts.length, profiles, targets, orders,
    cacheComparison: values['cache-comparison'], ioSettleMsPerSession: values['cache-comparison'] ? 1000 : 0,
    summaryStatistic: 'median; even sample counts use the midpoint of the two central values',
    environment: { node: process.version, platform: process.platform, architecture: process.arch }, results, baseline, candidates,
    limitations: ['One host and a small public English fixture; no universal numeric compatibility claim.',
      'Sequential counterbalanced trials with a warm filesystem cache; no concurrent application or long-input workload.',
      'Three session lifetimes per child approximate setup, use and unlock; no explicit garbage collection.',
      'Peak RSS includes model loading; lifecycle CPU excludes module imports and does not measure energy. This evaluator does not change production settings.',
      'Vector and pilot fingerprint agreement do not fix the separately measured fingerprint privacy or matching-quality failures.'] };
  const out = resolve(values.out ?? 'embedding-resources.json'); mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, baseline, candidates }, null, 2));
  if (values.enforce && !candidates.some(candidate => candidate.eligible)) process.exitCode = 1;
}
