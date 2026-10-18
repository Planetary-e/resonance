/**
 * Embedding engine wrapping @huggingface/transformers.
 * Runs Nomic-embed-text locally via ONNX Runtime (no network calls after model download).
 */

import { EMBEDDING_CONFIG } from './types.js';
import type { ItemType } from './types.js';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { configureModelFileCache } from './model-file-cache.js';

// Dynamic import to avoid top-level await issues
type FeatureExtractionFactory = (
  task: 'feature-extraction',
  model?: string,
  options?: { dtype?: 'fp32' },
) => Promise<FeatureExtractionPipeline>;

let transformersPipeline: FeatureExtractionFactory | null = null;

async function getTransformers() {
  if (!transformersPipeline) {
    const mod = await import('@huggingface/transformers');
    configureModelFileCache(mod.env);
    // The library factory covers every supported ML task in one very large
    // generic union. Resonance only constructs feature-extraction pipelines.
    transformersPipeline = mod.pipeline as unknown as FeatureExtractionFactory;
  }
  return transformersPipeline;
}

export type EmbeddingPrefix = 'search_document' | 'search_query';
export interface EmbeddingRequestOptions { signal?: AbortSignal }
export const MAX_EMBEDDING_TEXT_BYTES = 8192;
export const MAX_EMBEDDING_TOKENS = 512;
export const MAX_EMBEDDING_OPERATIONS = 8;
export const EMBEDDING_OPERATION_MS = 10000;
export class EmbeddingInputError extends Error {
  constructor(message: string) { super(message); this.name = 'EmbeddingInputError'; }
}
export function assertEmbeddingText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_EMBEDDING_TEXT_BYTES || !text.trim()) {
    throw new EmbeddingInputError('Enter a nonempty description of at most 8 KB.');
  }
}
interface EmbeddingJob {
  text: string; prefix: EmbeddingPrefix; signal?: AbortSignal; deadline: number;
  started: boolean; settled: boolean; resolve(value: Float32Array): void; reject(error: unknown): void;
  cancel(error: unknown): void; cleanup(): void;
}

/**
 * Rewrite a need into offer-like framing for better complementary matching.
 *
 * Embedding models measure semantic similarity — "I need a plumber" is closer to
 * "I also need a plumber" than to "I am a plumber." By rewriting needs into the
 * framing of what they'd match against, we boost the true cosine similarity
 * between complementary need/offer pairs.
 *
 * The rewriting is deterministic and rule-based (no LLM call).
 */
export function rewriteForMatching(text: string, itemType: ItemType): string {
  if (itemType === 'offer') {
    // Offers are already in the right framing — they describe what's provided
    return text;
  }

  // For needs: strip demand framing and convert to supply framing
  let rewritten = text;

  // Remove leading "I need", "Looking for", "Seeking", etc.
  const needPrefixes = [
    /^I(?:'m| am) (?:looking|searching|seeking) (?:for )?/i,
    /^(?:I )?need(?:ed|ing|s)? (?:to find |to get |to hire )?/i,
    /^Looking (?:for |to find |to hire )?/i,
    /^Searching (?:for )?/i,
    /^Seeking /i,
    /^Want(?:ed|ing|s)? (?:to (?:find|get|hire|learn|join|practice|start|join) )?/i,
    /^We need (?:to find |to hire |to get )?/i,
  ];

  for (const prefix of needPrefixes) {
    const match = rewritten.match(prefix);
    if (match) {
      rewritten = rewritten.slice(match[0].length);
      // Capitalize first letter
      rewritten = rewritten.charAt(0).toUpperCase() + rewritten.slice(1);
      break;
    }
  }

  // Add supply-side framing
  // Check if the result already sounds like a description (starts with article/adjective)
  const startsDescriptive = /^(?:a |an |the |my |our |[A-Z][a-z]+ (?:who|that|with|for|in))/i.test(rewritten);

  if (startsDescriptive) {
    // "a plumber in Barcelona" → "Plumber in Barcelona available"
    // Strip leading article
    rewritten = rewritten.replace(/^(?:a |an |the )/i, '');
    rewritten = rewritten.charAt(0).toUpperCase() + rewritten.slice(1);
  }

  return rewritten;
}

export class EmbeddingEngine {
  private pipe: FeatureExtractionPipeline | null = null;
  private initialization: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private closed = false;
  private active = new Set<Promise<unknown>>();
  private running = false;
  private operations = new Set<EmbeddingJob>();
  private queue: EmbeddingJob[] = [];
  private modelId: string;

  constructor(modelId?: string) {
    this.modelId = modelId ?? EMBEDDING_CONFIG.modelId;
  }

  /** Initialize the model pipeline. Downloads model on first run. */
  async initialize(): Promise<void> {
    if (this.closed) throw new Error('EmbeddingEngine is disposed');
    if (this.pipe) return;
    if (!this.initialization) {
      this.initialization = (async () => {
        const pipelineFn = await getTransformers();
        this.pipe = await pipelineFn('feature-extraction', this.modelId, { dtype: 'fp32' });
      })();
    }
    try { await this.initialization; }
    finally { this.initialization = null; }
    if (this.closed) throw new Error('EmbeddingEngine is disposed');
  }

  /** Check if the engine is ready */
  isInitialized(): boolean {
    return !this.closed && this.pipe !== null;
  }

  /** Stop new inference immediately, then release native model sessions after
   * initialization and already-started inference have actually settled. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    for (const job of this.queue) job.cancel(new Error('EmbeddingEngine is disposed'));
    this.queue = [];
    this.disposal = (async () => {
      try { await this.initialization; } catch { /* Failed initialization has no installed pipeline. */ }
      const pipe = this.pipe; this.pipe = null;
      await Promise.allSettled([...this.active]);
      await pipe?.dispose();
    })();
    return this.disposal;
  }

  /**
   * Embed a single text string.
   * @param text - The text to embed
   * @param prefix - 'search_document' for indexed content, 'search_query' for queries
   * @returns Normalized 768-dim Float32Array
   */
  async embed(text: string, prefix: EmbeddingPrefix = 'search_document', options: EmbeddingRequestOptions = {}): Promise<Float32Array> {
    if (this.closed || !this.pipe) {
      throw new Error('EmbeddingEngine not initialized. Call initialize() first.');
    }

    assertEmbeddingText(text);
    if (prefix !== 'search_document' && prefix !== 'search_query') throw new EmbeddingInputError('Invalid matching prefix');
    const signal = options.signal; signal?.throwIfAborted();
    if (this.operations.size >= MAX_EMBEDDING_OPERATIONS) throw new Error('Matching is busy; retry when current requests finish.');
    return new Promise<Float32Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const aborted = () => job.cancel(signal!.reason);
      const job: EmbeddingJob = { text, prefix, signal, deadline: performance.now() + EMBEDDING_OPERATION_MS, started: false, settled: false,
        resolve: value => { if (!job.settled) { job.settled = true; job.cleanup(); resolve(value); } },
        reject: error => { if (!job.settled) { job.settled = true; job.cleanup(); reject(error); } },
        cancel: error => {
          job.reject(error);
          if (!job.started) { this.operations.delete(job); this.queue = this.queue.filter(candidate => candidate !== job); }
        },
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); },
      };
      timer = setTimeout(() => job.cancel(new Error('Matching timed out; retry when current requests finish.')), EMBEDDING_OPERATION_MS);
      signal?.addEventListener('abort', aborted, { once: true });
      this.operations.add(job); this.queue.push(job); this.pump();
    });
  }

  private pump(): void {
    if (this.closed || this.running) return;
    const job = this.queue.shift(); if (!job) return;
    job.started = true;
    this.running = true;
    // Charge the native slot before any asynchronous work. Cancellation rejects
    // its caller, but only actual native settlement allows another inference.
    const operation = (async () => {
      const current = () => {
        if (job.settled) throw new Error('Matching request ended');
        job.signal?.throwIfAborted();
        if (performance.now() >= job.deadline) throw new Error('Matching timed out; retry when current requests finish.');
      };
      try {
        current();
        const pipe = this.pipe;
        if (!pipe || this.closed) throw new Error('EmbeddingEngine is disposed');
        const prefixedText = `${job.prefix}: ${job.text}`;
        const tokenized = pipe.tokenizer(prefixedText, { padding: true, truncation: false });
        const tokens = tokenized.input_ids.dims[1], modelLimit = pipe.tokenizer.model_max_length;
        if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > MAX_EMBEDDING_TOKENS
          || Number.isFinite(modelLimit) && tokens > modelLimit) {
          throw new EmbeddingInputError('Description is too long for matching. Split it into shorter descriptions.');
        }
        current();
        const output = await pipe(prefixedText, { pooling: 'mean', normalize: true });
        current(); const data = output.data;
        job.resolve(data instanceof Float32Array ? data : new Float32Array(data as ArrayLike<number>));
      } catch (error) { job.reject(error); }
    })();
    this.active.add(operation);
    void operation.finally(() => { job.cleanup(); this.operations.delete(job); this.active.delete(operation); this.running = false; this.pump(); });
  }

  /**
   * Embed with complementary matching: rewrite needs before embedding
   * so they match better against offers.
   *
   * @param text - Original text
   * @param itemType - 'need' or 'offer'
   * @param prefix - Embedding prefix
   * @returns Normalized 768-dim Float32Array
   */
  async embedForMatching(
    text: string,
    itemType: ItemType,
    prefix: EmbeddingPrefix = 'search_document',
    options: EmbeddingRequestOptions = {},
  ): Promise<Float32Array> {
    assertEmbeddingText(text);
    const rewritten = rewriteForMatching(text, itemType);
    return this.embed(rewritten, prefix, options);
  }

  /**
   * Embed multiple texts in a batch.
   * @param texts - Array of texts to embed
   * @param prefix - 'search_document' for indexed content, 'search_query' for queries
   * @returns Array of normalized 768-dim Float32Arrays
   */
  async embedBatch(texts: string[], prefix: EmbeddingPrefix = 'search_document', options: EmbeddingRequestOptions = {}): Promise<Float32Array[]> {
    if (!this.pipe) {
      throw new Error('EmbeddingEngine not initialized. Call initialize() first.');
    }

    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text, prefix, options));
    }
    return results;
  }
}
