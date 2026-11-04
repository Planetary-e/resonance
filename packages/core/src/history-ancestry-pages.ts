/** Original-evidence paging only. A page is never a semantic anchor or restore capability. */
import { historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from './history-checkpoint.js';
export const HISTORY_ANCESTRY_PAGING_VERSION = 2 as const;
export const HISTORY_ANCESTRY_GENERATIONS_PER_PAGE = 64;
export interface HistoryAncestryPagePosition { version: 2; index: number; generations: number }
export const firstHistoryAncestryPage = (): HistoryAncestryPagePosition => ({ version: 2, index: 0, generations: 1 });
export function nextHistoryAncestryGeneration(page: HistoryAncestryPagePosition): HistoryAncestryPagePosition {
  return page.generations === HISTORY_ANCESTRY_GENERATIONS_PER_PAGE
    ? { version: 2, index: page.index + 1, generations: 1 }
    : { ...page, generations: page.generations + 1 };
}
/** Pages partition traversal, retaining the preceding head across every boundary.
 * Callers retain aggregate counters, deadlines and semantic state outside this iterator. */
export function* historyAncestryPages<T extends HistoryCheckpointEnvelope>(source: Iterable<T>) {
  let position = firstHistoryAncestryPage(), blocks: T[] = [], previous: T | undefined;
  for (const block of source) {
    if (previous && block.kind === 'continuation') {
      if (block.proposal.generation !== previous.generation || block.proposal.envelopeId !== historyCheckpointEnvelopeId(previous)) {
        throw new Error('History page boundary has a gap, reordered or mismatched predecessor');
      }
      const next = nextHistoryAncestryGeneration(position);
      if (next.index !== position.index) { yield { ...position, blocks }; blocks = []; }
      position = next;
    }
    blocks.push(block); previous = block;
  }
  if (blocks.length) yield { ...position, blocks };
}
