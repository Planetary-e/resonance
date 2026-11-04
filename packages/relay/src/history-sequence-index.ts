/** Bounded retained entries, independent of the distance between absolute sequences.
 * A gap is only structural here: callers must authenticate its checkpoint proof. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { isHistoryDigest } from '@resonance/core/history-checkpoint';
import { HISTORY_RECOVERY_MAX_BLOCKS } from '@resonance/core/history-exchange';

export interface EncodedHistorySequenceIndex { version: 1; entries: Array<[number, string]> }
export type StoredHistorySequenceIndex = Array<string | null> | EncodedHistorySequenceIndex;
export function readHistorySequenceIndex(raw: unknown, maximum = HISTORY_RECOVERY_MAX_BLOCKS) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > HISTORY_RECOVERY_MAX_BLOCKS) throw new Error('Invalid history index capacity');
  let entries: Array<[number, string]>;
  if (Array.isArray(raw)) {
    // Old absolute-slot manifests remain bounded before traversal or conversion.
    if (raw.length > maximum || Array.from(raw).some(id => id !== null && !isHistoryDigest(id))) throw new Error('Invalid legacy history index');
    entries = raw.flatMap((id, sequence) => id === null ? [] : [[sequence, id] as [number, string]]);
    if (raw.length && (raw[0] === null || raw.at(-1) === null)) throw new Error('Legacy history index has a missing root or head');
  } else {
    if (!exactWitnessFields(raw, ['version', 'entries']) || raw.version !== 1 || !Array.isArray(raw.entries)
      || raw.entries.length > maximum) throw new Error('Invalid retained history index');
    entries = Array.from(raw.entries).map(entry => {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] < 0
        || entry[0] >= Number.MAX_SAFE_INTEGER || !isHistoryDigest(entry[1])) throw new Error('Invalid retained history entry');
      return [entry[0], entry[1]];
    });
  }
  if (entries.length && entries[0][0] !== 0 || entries.some((entry, i) => i > 0 && entry[0] <= entries[i - 1][0])
    || new Set(entries.map(entry => entry[1])).size !== entries.length) throw new Error('Conflicting retained history entries');
  const headSequence = entries.at(-1)?.[0] ?? -1, headId = entries.at(-1)?.[1] ?? null;
  const records = Object.freeze(entries.map(entry => Object.freeze(entry)));
  const get = (sequence: number): string | null => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    let lo = 0, hi = records.length - 1;
    while (lo <= hi) {
      const middle = lo + Math.floor((hi - lo) / 2), entry = records[middle];
      if (entry[0] === sequence) return entry[1];
      if (entry[0] < sequence) lo = middle + 1; else hi = middle - 1;
    }
    return null;
  };
  return {
    records, count: records.length, headSequence, headId, get,
    hasGaps: records.length !== headSequence + 1,
    encode(): EncodedHistorySequenceIndex { return { version: 1, entries: records.map(([sequence, id]) => [sequence, id]) }; },
    /** Never allocate by sequence distance, even when a valid peer signs a far-ahead head. */
    extend(sequence: number, id: string): EncodedHistorySequenceIndex {
      if (sequence <= headSequence || records.length >= maximum) throw new Error('History index extension exceeds its position or capacity');
      return readHistorySequenceIndex({ version: 1, entries: [...records, [sequence, id]] }, maximum).encode();
    },
    retireBefore(sequence: number): EncodedHistorySequenceIndex {
      if (!get(sequence) || sequence < 1) throw new Error('History retirement boundary is unavailable');
      return { version: 1, entries: records.filter(([position]) => position === 0 || position >= sequence).map(([position, id]) => [position, id]) };
    },
    suffix(sequence: number): string[] {
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > headSequence
        || headSequence - sequence >= maximum) throw new Error('History suffix exceeds retained capacity');
      const selected = records.filter(([position]) => position >= sequence);
      if (selected.length !== headSequence - sequence + 1 || selected.some(([position], i) => position !== sequence + i)) {
        throw new Error('History suffix is incomplete');
      }
      return selected.map(([, id]) => id);
    },
  };
}
