/** Pages remain in funded immutable history checkpoints; this reader retains no page cache. */
import { admissionPolicyArchivePageDigest, type AdmissionPolicyArchiveLimits, type AdmissionPolicyArchiveReader } from '@resonance/core/admission-policy-archive';
import { openHistoryCheckpoint, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { ADMISSION_POLICY_OBSERVER_MAX_BYTES } from './admission-policy-observer-state.js';

export function policyObserverArchiveLimits(blocks: number, bytes: number, timeoutMs: number): AdmissionPolicyArchiveLimits {
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 10001 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) throw new Error('Invalid funded observer archive envelope');
  return { maxPages: blocks * 2, maxEntries: blocks * 64, maxArchiveBytes: bytes, maxHistoryBytes: bytes,
    maxTransitions: blocks, maxPageReads: blocks * 2, timeoutMs };
}
/** Source must reopen retained ancestry on every invocation, including after process death.
 * Scanned ciphertext bytes/blocks are cumulative across all page requests in this operation. */
export function createPolicyObserverPageReader(options: {
  source: () => Iterable<HistoryCheckpointEnvelope>; historyContext: HistoryCheckpointContext; key: Uint8Array;
  maxBlocks: number; maxBytes: number; timeoutMs: number; signal?: AbortSignal;
  account?: (bytes: number) => void;
}): AdmissionPolicyArchiveReader {
  let blocks = 0, total = 0; const started = performance.now();
  const live = (signal: AbortSignal) => { if (signal.aborted || options.signal?.aborted || performance.now() - started >= options.timeoutMs) throw new Error('Observer archive read cancelled or timed out'); };
  return async (digest, signal) => {
    live(signal);
    for (const block of options.source()) {
      live(signal);
      const size = Buffer.byteLength(JSON.stringify(block)); options.account?.(size);
      if (++blocks > options.maxBlocks || (total += size) > options.maxBytes) throw new Error('Observer archive scan exhausted cumulative history budget');
      if (block.kind !== 'checkpoint') continue;
      const bytes = openHistoryCheckpoint(block, options.historyContext, options.key);
      try {
        if (bytes.length > ADMISSION_POLICY_OBSERVER_MAX_BYTES) throw new Error('Observer archive snapshot exceeds its bound');
        const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (state.version !== 2) continue;
        if (!Array.isArray(state.archiveAppend) || state.archiveAppend.length > 2) throw new Error('Invalid archive append source');
        for (const page of state.archiveAppend) {
          if (page.digest !== digest) continue;
          if (typeof page.data !== 'string' || page.data.length > Math.ceil(512 * 1024 * 4 / 3)) throw new Error('Oversized retained archive page');
          const data = Buffer.from(page.data, 'base64url');
          if (data.toString('base64url') !== page.data || admissionPolicyArchivePageDigest(data) !== digest) throw new Error('Retained archive page digest differs');
          live(signal); return data;
        }
      } finally { bytes.fill(0); }
    }
    throw new Error('Required archive page is absent from retained original ancestry');
  };
}
