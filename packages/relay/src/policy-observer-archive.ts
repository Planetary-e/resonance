/** Read-only access to a completed recovery download. No transport, repair,
 * initialization or temporary-file cleanup is available on this path. */
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

export async function readArchivedPolicySuccessor(config: PolicyObserverConfiguration, value: AdmissionPolicyHead, signal?: AbortSignal) {
  signal?.throwIfAborted(); const previous = parseAdmissionPolicyHead(value);
  if (config.root.kind !== 'continuation' || !config.archiveDirectory) throw new Error('No retained policy archive is configured');
  const directory = config.archiveDirectory, contextId = historyCheckpointContextId(config.historyContext), proposal = config.root.proposal;
  if (!lstatSync(directory).isDirectory()) throw new Error('Policy archive needs an existing real directory');
  const key = readOperatorStorageKey(config.storageKeyFile);
  type State = { version: 1; contextId: string; proposal: unknown; blocks: string[] };
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined;
  const started = performance.now();
  const live = () => { signal?.throwIfAborted(); if (performance.now() - started >= 3000) throw new Error('Policy archive read timed out'); };
  try {
    const expected = historySuccessorProposalId(proposal);
    storage = openEncryptedLocalState<State>({ path: join(directory, HISTORY_DOWNLOAD_FILENAME), key,
      domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing',
      initial: { version: 1, contextId, proposal, blocks: [] }, validate: (value): value is State => {
        if (!exactWitnessFields(value, ['version', 'contextId', 'proposal', 'blocks']) || value.version !== 1 || value.contextId !== contextId
          || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 10001
          || !value.blocks.every(isHistoryDigest) || new Set(value.blocks).size !== value.blocks.length) return false;
        try { return historySuccessorProposalId(parseHistorySuccessorProposal(value.proposal, config.historyContext)) === expected; } catch { return false; }
      } });
    const ids = storage.read().blocks; let total = 0;
    function* blocks(): Generator<HistoryCheckpointEnvelope> {
      for (let index = ids.length - 1; index >= 0; index--) {
        live(); const bytes = readOperatorFile(join(directory, `${ids[index].slice(7)}.block`), HISTORY_ENVELOPE_MAX_BYTES);
        try {
          if ((total += bytes.length) > 256 * 1024 * 1024) throw new Error('Policy archive exceeds its byte limit');
          let value: unknown;
          try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { throw new Error('Invalid policy archive encoding'); }
          const block = parseHistoryCheckpointEnvelope(value, config.historyContext);
          if (historyCheckpointEnvelopeId(block) !== ids[index]) throw new Error('Policy archive digest mismatch');
          yield block;
        } finally { bytes.fill(0); }
      }
    }
    live(); const replay = await replayPolicyObserverHistory({ context: config.context, historyContext: config.historyContext,
      genesisId: historyCheckpointEnvelopeId(config.genesis), proposal, encryptionKey: key, blocks: blocks(), successorOf: previous, timeoutMs: 3000, signal });
    live();
    if (replay.state.conflict) throw new Error('Retained policy archive contains conflict evidence');
    if (!replay.successor) throw new Error('Requested policy successor is absent from retained selected history');
    return replay.successor;
  } finally { storage?.close(); key.fill(0); }
}
