/** Privacy level presets mapping to epsilon values */
export type PrivacyLevel = 'low' | 'medium' | 'high';

/** Epsilon values for each privacy level */
export const EPSILON_MAP: Record<PrivacyLevel, number> = {
  low: 5.0,    // More accuracy, less privacy
  medium: 1.0, // Balanced
  high: 0.1,   // More privacy, less accuracy
} as const;

/** Item type: need or offer */
export type ItemType = 'need' | 'offer';

/** Result from perturbation */
export interface PerturbationResult {
  perturbed: Float32Array;
  epsilon: number;
}

/** Result from HNSW search */
export interface MatchResult {
  label: number;
  distance: number;
  similarity: number;
}

/** Eval benchmark result for a single metric */
export interface BenchmarkResult {
  name: string;
  target: string;
  actual: string;
  value: number;
  passed: boolean;
  details?: Record<string, unknown>;
}

/** Full eval run output */
export interface EvalReport {
  timestamp: string;
  platform: {
    os: string;
    arch: string;
    nodeVersion: string;
  };
  results: BenchmarkResult[];
}

/** Embedding model configuration */
export const EMBEDDING_CONFIG = {
  modelId: 'nomic-ai/nomic-embed-text-v1',
  dimensions: 768,
} as const;

/** Perturbation mode for the relay protocol */
export type PerturbMode = 'index-only' | 'both';

/** HNSW index defaults */
export const HNSW_DEFAULTS = {
  dimensions: 768,
  maxElements: 500_000,
  m: 16,
  efConstruction: 200,
  efSearch: 100,
  /** Relay matching threshold (lowered from 0.72 — see eval results) */
  similarityThreshold: 0.50,
} as const;

/** Protocol defaults */
export const PROTOCOL_DEFAULTS = {
  /** Only perturb indexed (published) embeddings; queries use true embeddings */
  perturbMode: 'index-only' as PerturbMode,
  /** Relay threshold — perturbed similarity needed to trigger match notification */
  relayThreshold: 0.50,
  /** Confirmation threshold — true similarity needed in direct channel.
   *  Lowered from 0.70: empirical avg true need/offer similarity is 0.634,
   *  so 0.70 would reject ~50% of genuine matches. 0.55 filters noise
   *  (unrelated pairs are typically < 0.30) while accepting real matches. */
  confirmThreshold: 0.55,
} as const;
