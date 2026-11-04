/** Isolated native FP32 measurements before selecting an inference input limit. */
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBEDDING_CONFIG } from '@resonance/core';
import { configureModelFileCache } from '../packages/core/src/model-file-cache.js';
const { values } = parseArgs({ options: { child: { type: 'string' }, out: { type: 'string' } } });
env.allowRemoteModels = false; configureModelFileCache(env);
const targets = { maximumPeakRssBytes: 1.5 * 1024 ** 3, maximumInferenceMs: 1000, maximumInferenceCpuSeconds: 5,
  candidateTokens: [128, 256, 512], repetitions: 3 };
type Measurement = { elapsedMs: number; cpuSeconds: number; rssBytes: number; peakRssBytes: number };
if (values.child) {
  const requested = Number(values.child);
  if (!process.send || !targets.candidateTokens.includes(requested)) throw new Error('Invalid worker');
  const create = pipeline as unknown as (task: 'feature-extraction', model: string, options: { dtype: 'fp32' }) => Promise<FeatureExtractionPipeline>;
  const pipe = await create('feature-extraction', EMBEDDING_CONFIG.modelId, { dtype: 'fp32' });
  try {
    let words = requested, text = '', tokens = 0;
    do { text = `search_document: ${Array(words--).fill('garden').join(' ')}`;
      tokens = pipe.tokenizer(text, { padding: true, truncation: false }).input_ids.dims[1];
    } while (tokens > requested);
    if (tokens !== requested) throw new Error('Fixture did not reach the exact candidate token length');
    const measurements: Measurement[] = [];
    for (let i = 0; i < targets.repetitions; i++) {
      const started = performance.now(), cpuStart = process.cpuUsage();
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      if (output.data.length !== 768) throw new Error('Invalid model output');
      const cpu = process.cpuUsage(cpuStart);
      measurements.push({ elapsedMs: performance.now() - started, cpuSeconds: (cpu.user + cpu.system) / 1e6,
        rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
    }
    await new Promise<void>((accept, reject) => process.send!({ tokens, textBytes: Buffer.byteLength(text), measurements }, error => error ? reject(error) : accept()));
  } finally { await pipe.dispose(); process.disconnect!(); }
} else {
  const results: Array<{ tokens: number; textBytes: number; measurements: Measurement[] }> = [];
  for (const tokens of targets.candidateTokens) {
    console.error(`Measuring ${tokens} tokens in an isolated process`);
    results.push(await new Promise((accept, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--child', String(tokens)], { execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      let report: typeof results[number] | undefined;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Measurement deadline exceeded')); }, 60000);
      child.on('message', value => { report = value as typeof report; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code !== 0 || !report) reject(new Error(`Measurement failed: ${code}`)); else accept(report); });
    }));
  }
  const candidates = results.map(row => ({ tokens: row.tokens, maximumInferenceMs: Math.max(...row.measurements.map(m => m.elapsedMs)),
    maximumInferenceCpuSeconds: Math.max(...row.measurements.map(m => m.cpuSeconds)), peakRssBytes: Math.max(...row.measurements.map(m => m.peakRssBytes)) }));
  const eligible = candidates.filter(row => row.maximumInferenceMs <= targets.maximumInferenceMs
    && row.maximumInferenceCpuSeconds <= targets.maximumInferenceCpuSeconds && row.peakRssBytes <= targets.maximumPeakRssBytes);
  const report = { measuredAt: new Date().toISOString(), model: EMBEDDING_CONFIG.modelId, dtype: 'fp32', targets, results, candidates,
    selectedMaximumTokens: eligible.at(-1)?.tokens ?? null, node: process.version, platform: process.platform, architecture: process.arch,
    limitations: ['One CPU host and repeated public words; worst-case model dimensions, not a representative language benchmark.',
      'Three inferences per isolated length, including the cold first inference. No overlapping model processes.',
      'Process RSS includes cached model loading. CPU is not device energy. This evaluation does not impose production limits.'] };
  const out = values.out ?? '/tmp/resonance-embedding-input-budget.json'; writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, candidates, selectedMaximumTokens: report.selectedMaximumTokens }, null, 2));
  if (!eligible.length) process.exitCode = 1;
}
