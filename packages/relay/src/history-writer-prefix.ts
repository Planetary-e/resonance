/** Internal capability for a locally authenticated immutable ciphertext index. */
import type { HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';

export interface HistoryWriterPrefix {
  readonly contextId: string;
  readonly rootId: string;
  readonly generation: number;
  readonly count: number;
  readonly bytes: number;
  idAt(sequence: number): string | null;
  blockAt(sequence: number): HistoryCheckpointEnvelope;
}
const prefixes = new WeakSet<object>();
/** Internal storage boundary only: authenticate the index before constructing this handle. */
export function registerHistoryWriterPrefix(value: HistoryWriterPrefix): HistoryWriterPrefix {
  const prefix = Object.freeze({ ...value }); prefixes.add(prefix); return prefix;
}
export function isHistoryWriterPrefix(value: unknown): value is HistoryWriterPrefix {
  return !!value && typeof value === 'object' && prefixes.has(value);
}
export type HistoryWriterRepairSource = Iterable<HistoryCheckpointEnvelope> | HistoryWriterPrefix;
