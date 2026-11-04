import { existsSync } from 'node:fs';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { historyCheckpointContextId } from '@resonance/core/history-checkpoint';
/** Owner composition: durable intent, authenticated retained ciphertext, then quorum replication. */
import { join } from 'node:path';
import { createHistoryCheckpointWriter } from './history-checkpoint-quorum.js';
import { openHistoryWriterArchive } from './history-writer-archive.js';

export function retainedHistoryWriterStateBytes(archiveBytes?: number, explicit?: number) {
  const value=explicit??(archiveBytes===undefined?40*1024*1024:Math.min(40*1024*1024,Math.max(1024*1024,3*archiveBytes+65536)));
  if(!Number.isSafeInteger(value)||value<1024*1024||value>40*1024*1024)throw new Error('Invalid bounded writer snapshot ceiling');return value;
}
export function createRetainedHistoryCheckpointWriter(options: Omit<Parameters<typeof createHistoryCheckpointWriter>[0], 'retained'> & {
  /** Explicitly finish initial archive creation for an intact writer with no committed block. */
  initializeArchive?: boolean;
  resumePristineArchive?: boolean;
  maxArchiveBlocks?: number; maxArchiveBytes?: number;
  genesisId?: string;
}) {
  const { initializeArchive, resumePristineArchive, maxArchiveBlocks, maxArchiveBytes, genesisId, ...writerOptions } = options;
  let archive: ReturnType<typeof openHistoryWriterArchive>;
  // Existing v1 writers keep their original ceiling. New explicitly bounded
  // arenas persist a small authenticated control so reopening cannot increase
  // reservations simply to discover the snapshot's bound.
  const markerPath = join(options.directory,'history-writer-capacity.json');
  const proposed = retainedHistoryWriterStateBytes(maxArchiveBytes,writerOptions.stateMaxBytes);
  let stateMaxBytes = writerOptions.stateMaxBytes ?? 40*1024*1024;
  if (existsSync(markerPath) || options.initialize && proposed < 40*1024*1024) {
    const expected = { version:1,contextId:historyCheckpointContextId(options.context),rootId:options.rootId,generation:options.generation,stateMaxBytes:proposed };
    const marker = openEncryptedLocalState<typeof expected>({path:markerPath,key:options.localKey,domain:'resonance:history-writer-capacity:v1',maxBytes:4096,
      mode:existsSync(markerPath)?'open-existing':'create-new',initial:expected,
      validate:(value):value is typeof expected => exactWitnessFields(value,Object.keys(expected)) && Object.keys(expected).filter(k=>k!=='stateMaxBytes').every(k=>value[k]===expected[k as keyof typeof expected]) && Number.isSafeInteger(value.stateMaxBytes) && (value.stateMaxBytes as number)>=1024*1024 && (value.stateMaxBytes as number)<=40*1024*1024 && (writerOptions.stateMaxBytes===undefined || value.stateMaxBytes===writerOptions.stateMaxBytes)});
    try {stateMaxBytes=marker.read().stateMaxBytes;} finally {marker.close();}
  }
  const writer = createHistoryCheckpointWriter({ ...writerOptions, stateMaxBytes, preflightRetained(block) { archive.preflight(block); }, retained() {
    archive.retainPending(); return archive.prefix();
  } });
  try {
    archive = openHistoryWriterArchive({ directory: join(options.directory, 'payloads'), localKey: options.localKey,
      context: options.context, rootId: options.rootId, generation: options.generation, genesisId, readWriter: writer.read,
      fundedGrowth: options.fundedGrowth, initialize: options.initialize || initializeArchive, resumePristine: resumePristineArchive, maxBlocks: maxArchiveBlocks, maxBytes: maxArchiveBytes });
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
