/**
 * Embedding engine wrapping @huggingface/transformers.
 * Runs Nomic-embed-text locally via ONNX Runtime (no network calls after model download).
 */

import { EMBEDDING_CONFIG } from './types.js';
import type { ItemType } from './types.js';

// Dynamic import to avoid top-level await issues
let transformersPipeline: typeof import('@huggingface/transformers').pipeline | null = null;

async function getTransformers() {
  if (!transformersPipeline) {
    const mod = await import('@huggingface/transformers');
    transformersPipeline = mod.pipeline;
  }
  return transformersPipeline;
}

export type EmbeddingPrefix = 'search_document' | 'search_query';

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
  private pipe: Awaited<ReturnType<typeof import('@huggingface/transformers').pipeline>> | null = null;
  private modelId: string;

  constructor(modelId?: string) {
    this.modelId = modelId ?? EMBEDDING_CONFIG.modelId;
  }

  /** Initialize the model pipeline. Downloads model on first run. */
  async initialize(): Promise<void> {
    if (this.pipe) return;
    const pipelineFn = await getTransformers();
    this.pipe = await pipelineFn('feature-extraction', this.modelId, {
      dtype: 'fp32',
    });
  }

  /** Check if the engine is ready */
  isInitialized(): boolean {
    return this.pipe !== null;
  }

  /**
   * Embed a single text string.
   * @param text - The text to embed
   * @param prefix - 'search_document' for indexed content, 'search_query' for queries
   * @returns Normalized 768-dim Float32Array
   */
  async embed(text: string, prefix: EmbeddingPrefix = 'search_document'): Promise<Float32Array> {
    if (!this.pipe) {
      throw new Error('EmbeddingEngine not initialized. Call initialize() first.');
    }

    const prefixedText = `${prefix}: ${text}`;
    const output = await this.pipe(prefixedText, {
      pooling: 'mean',
      normalize: true,
    });

    // Output is a Tensor — extract the flat data as Float32Array
    const data = output.data;
    if (data instanceof Float32Array) {
      return data;
    }
    return new Float32Array(data as ArrayLike<number>);
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
  ): Promise<Float32Array> {
    const rewritten = rewriteForMatching(text, itemType);
    return this.embed(rewritten, prefix);
  }

  /**
   * Embed multiple texts in a batch.
   * @param texts - Array of texts to embed
   * @param prefix - 'search_document' for indexed content, 'search_query' for queries
   * @returns Array of normalized 768-dim Float32Arrays
   */
  async embedBatch(texts: string[], prefix: EmbeddingPrefix = 'search_document'): Promise<Float32Array[]> {
    if (!this.pipe) {
      throw new Error('EmbeddingEngine not initialized. Call initialize() first.');
    }

    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text, prefix));
    }
    return results;
  }
}
