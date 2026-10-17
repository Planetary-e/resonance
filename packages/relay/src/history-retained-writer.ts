/** Owner composition: exact durable intent, complete local ciphertext, then quorum replication. */
import { join } from 'node:path';
import { createHistoryCheckpointWriter } from './history-checkpoint-quorum.js';
import { openHistoryWriterArchive } from './history-writer-archive.js';

export function createRetainedHistoryCheckpointWriter(options: Omit<Parameters<typeof createHistoryCheckpointWriter>[0], 'retained'> & {
  /** Explicitly finish initial archive creation for an intact writer with no committed block. */
  initializeArchive?: boolean;
  resumePristineArchive?: boolean;
  maxArchiveBlocks?: number; maxArchiveBytes?: number;
}) {
  const { initializeArchive, resumePristineArchive, maxArchiveBlocks, maxArchiveBytes, ...writerOptions } = options;
  let archive: ReturnType<typeof openHistoryWriterArchive>;
  const writer = createHistoryCheckpointWriter({ ...writerOptions, retained() {
    archive.retainPending(); return archive.prefix();
  } });
  try {
    archive = openHistoryWriterArchive({ directory: join(options.directory, 'payloads'), localKey: options.localKey,
      context: options.context, rootId: options.rootId, generation: options.generation, readWriter: writer.read,
      initialize: options.initialize || initializeArchive, resumePristine: resumePristineArchive, maxBlocks: maxArchiveBlocks, maxBytes: maxArchiveBytes });
  } catch (error) { writer.close(); throw error; }
  return { ...writer, history: () => archive.blocks(), historyStatus: () => archive.read(),
    historyUsage: () => archive.usage(),
    close() { writer.close(); archive.close(); } };
}
