/** Owner composition: durable intent, authenticated retained ciphertext, then quorum replication. */
import { join } from 'node:path';
import { createHistoryCheckpointWriter } from './history-checkpoint-quorum.js';
import { openHistoryWriterArchive } from './history-writer-archive.js';

export function createRetainedHistoryCheckpointWriter(options: Omit<Parameters<typeof createHistoryCheckpointWriter>[0], 'retained'> & {
  /** Explicitly finish initial archive creation for an intact writer with no committed block. */
  initializeArchive?: boolean;
  resumePristineArchive?: boolean;
  maxArchiveBlocks?: number; maxArchiveBytes?: number;
  genesisId?: string;
}) {
  const { initializeArchive, resumePristineArchive, maxArchiveBlocks, maxArchiveBytes, genesisId, ...writerOptions } = options;
  let archive: ReturnType<typeof openHistoryWriterArchive>;
  const writer = createHistoryCheckpointWriter({ ...writerOptions, retained() {
    archive.retainPending(); return archive.prefix();
  } });
  try {
    archive = openHistoryWriterArchive({ directory: join(options.directory, 'payloads'), localKey: options.localKey,
      context: options.context, rootId: options.rootId, generation: options.generation, genesisId, readWriter: writer.read,
      initialize: options.initialize || initializeArchive, resumePristine: resumePristineArchive, maxBlocks: maxArchiveBlocks, maxBytes: maxArchiveBytes });
  } catch (error) { writer.close(); throw error; }
  return { ...writer,
    /** Retained payloads only. After retirement, compactionAnchor() authenticates the omitted prefix. */
    history: () => archive.blocks(), historyStatus: () => archive.read(),
    historyBlock: (sequence: number) => archive.prefix().blockAt(sequence),
    historyUsage: () => archive.usage(),
    historyReviewDigest: () => archive.reviewDigest(),
    retainCompactionAnchor: archive.retainCompactionAnchor,
    compactionAnchor: archive.compactionAnchor,
    planPrefixRetirement: archive.planPrefixRetirement,
    retirePrefix: archive.retirePrefix,
    close() { writer.close(); archive.close(); } };
}
