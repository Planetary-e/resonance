/** Read-only access to a completed recovery download. No transport, repair,
 * initialization or temporary-file cleanup is available on this path. */
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest, HISTORY_ENVELOPE_MAX_BYTES,
  parseHistoryCheckpointEnvelope, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId, parseHistorySuccessorProposal } from '@resonance/core/history-successor';
import { parseAdmissionPolicyHead, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { readOperatorFile, readOperatorStorageKey } from './admission-operator-files.js';
import { HISTORY_DOWNLOAD_FILENAME } from './history-ancestry-download.js';
import { replayPolicyObserverHistory } from './policy-observer-history-replay.js';
import type { PolicyObserverConfiguration } from './policy-observer-config.js';

export function openRetainedPolicyObserverArchive(config: PolicyObserverConfiguration) {
  if (config.root.kind !== 'continuation' || !config.archiveDirectory) throw new Error('No retained policy archive is configured');
  const directory = config.archiveDirectory, contextId = historyCheckpointContextId(config.historyContext), proposal = config.root.proposal;
  if (!lstatSync(directory).isDirectory()) throw new Error('Policy archive needs an existing real directory');
  const key = readOperatorStorageKey(config.storageKeyFile);
  type State = { version: 1; contextId: string; proposal: unknown; blocks: string[] };
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined;
  try {
    // Same funded durable download, including its manifest replacement peak. No disposable cache.
    reserveHistoryStorage({ directory, component: 'history-download-ciphertext', ciphertextBytes: 256 * 1024 * 1024 - 4 * 1024 * 1024,
      manifestFilename: HISTORY_DOWNLOAD_FILENAME, manifestBytes: 2 * 1024 * 1024 });
    const expected = historySuccessorProposalId(proposal);
    storage = openEncryptedLocalState<State>({ path: join(directory, HISTORY_DOWNLOAD_FILENAME), key,
      domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing',
      initial: { version: 1, contextId, proposal, blocks: [] }, validate: (value): value is State => {
        if (!exactWitnessFields(value, ['version', 'contextId', 'proposal', 'blocks']) || value.version !== 1 || value.contextId !== contextId
          || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 10001
          || !value.blocks.every(isHistoryDigest) || new Set(value.blocks).size !== value.blocks.length) return false;
        try { return historySuccessorProposalId(parseHistorySuccessorProposal(value.proposal, config.historyContext)) === expected; } catch { return false; }
      } });
    const ids = storage.read().blocks; storage.close(); storage = undefined;
    let closed = false;
    return { *blocks(): Generator<HistoryCheckpointEnvelope> {
      if (closed) throw new Error('Retained policy ancestry is closed');
      let total = 0; const started = performance.now();
      for (let index = ids.length - 1; index >= 0; index--) {
        if (closed || performance.now() - started >= 30000) throw new Error('Retained policy ancestry closed or timed out');
        const bytes = readOperatorFile(join(directory, `${ids[index].slice(7)}.block`), HISTORY_ENVELOPE_MAX_BYTES);
        try {
          if ((total += bytes.length) > 256 * 1024 * 1024) throw new Error('Policy archive exceeds its byte limit');
          let value: unknown;
          try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { throw new Error('Invalid policy archive encoding'); }
          const block = parseHistoryCheckpointEnvelope(value, config.historyContext);
          if (historyCheckpointEnvelopeId(block) !== ids[index]) throw new Error('Policy archive digest mismatch');
          yield block;
        } finally { bytes.fill(0); }
      }
    }, close() { if (!closed) { closed = true; storage?.close(); key.fill(0); } } };
  } catch (error) { storage?.close(); key.fill(0); throw error; }
}
export async function readArchivedPolicySuccessor(config: PolicyObserverConfiguration, value: AdmissionPolicyHead, signal?: AbortSignal) {
  signal?.throwIfAborted(); const previous = parseAdmissionPolicyHead(value), archive = openRetainedPolicyObserverArchive(config);
  const key = readOperatorStorageKey(config.storageKeyFile);
  try {
    if (config.root.kind !== 'continuation') throw new Error('Archive requires certified selected ancestry');
    const replay = await replayPolicyObserverHistory({ context: config.context, historyContext: config.historyContext,
      genesisId: historyCheckpointEnvelopeId(config.genesis), proposal: config.root.proposal, encryptionKey: key,
      blocks: archive.blocks(), blockSource: archive.blocks, successorOf: previous, timeoutMs: 3000, signal });
    if (replay.state.conflict) throw new Error('Retained policy archive contains conflict evidence');
    if (!replay.successor) throw new Error('Requested policy successor is absent from retained selected history');
    return replay.successor;
  } finally { archive.close(); key.fill(0); }
}
