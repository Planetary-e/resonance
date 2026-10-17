/** Review an authenticated selected chain before creating a restored owner.
 * Review neither freezes replicas nor authorizes an observation. */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { parseAdmissionPolicyObserverState, policyObserverStateHead, type AdmissionPolicyObserverState } from './admission-policy-observer-state.js';
import { policyObserverReplayDigest, replayPolicyObserverHistory } from './policy-observer-history-replay.js';

export interface PreparedPolicyObserverRestore {
  readonly review: Readonly<{ kind: 'policy-observer-restore'; directory: string; contextId: string; genesisId: string;
    rootId: string; generation: number; policyRevision: number; blocked: boolean; blocks: number; bytes: number;
    generations: number; approvalDigest: string }>;
}
interface Preparation { directory: string; contextId: string; genesisId: string; rootId: string;
  state: AdmissionPolicyObserverState; replayDigest: string; approvalDigest: string }
const prepared = new WeakMap<PreparedPolicyObserverRestore, Preparation>();
export async function preparePolicyObserverRestore(options: Omit<Parameters<typeof replayPolicyObserverHistory>[0], 'proposal'> & {
  directory: string; continuation: HistoryContinuationRoot;
}): Promise<PreparedPolicyObserverRestore> {
  const directory = resolve(options.directory);
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Policy observer restore requires a new empty destination');
  const context = parseAdmissionPolicyObservers(options.context);
  const root = parseHistoryContinuationRoot(options.continuation, options.historyContext), rootId = historyCheckpointEnvelopeId(root);
  const replay = await replayPolicyObserverHistory({ ...options, context, proposal: root.proposal });
  const approvalDigest = historyDigest(`resonance:policy-observer-restore:v1\n${JSON.stringify([directory, replay.contextId, replay.genesisId, rootId, replay.replayDigest])}`);
  const result = Object.freeze({ review: Object.freeze({ kind: 'policy-observer-restore' as const, directory, contextId: replay.contextId,
    genesisId: replay.genesisId, rootId, generation: root.generation, policyRevision: policyObserverStateHead(replay.state, context).revision,
    blocked: replay.state.conflict !== null, blocks: replay.blocks, bytes: replay.bytes, generations: replay.generations, approvalDigest }) });
  prepared.set(result, { directory, contextId: replay.contextId, genesisId: replay.genesisId, rootId, state: replay.state, replayDigest: replay.replayDigest, approvalDigest });
  return result;
}
/** A serialized/cloned review is not an in-process authorization capability. */
export function readPreparedPolicyObserverRestore(value: PreparedPolicyObserverRestore, approvedDigest: string,
  directory: string, context: HistoryCheckpointContext, genesisId: string, rootId: string) {
  const record = prepared.get(value);
  if (!record || approvedDigest !== record.approvalDigest || record.directory !== resolve(directory)
    || record.contextId !== historyCheckpointContextId(context) || record.genesisId !== genesisId || record.rootId !== rootId) {
    throw new Error('Policy observer restore needs matching reviewed history and destination');
  }
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Policy observer restore requires a new empty destination');
  return structuredClone(record);
}

export const POLICY_OBSERVER_RESTORATION_FILENAME = 'policy-observer-restoration.json';
interface SavedRestoration { version: 1; contextId: string; genesisId: string; rootId: string;
  state: AdmissionPolicyObserverState; replayDigest: string }
/** Immutable restored baseline. New decisions live exclusively in the writer;
 * this file never substitutes an old baseline for its committed/pending head. */
export async function openPolicyObserverRestoration(options: {
  directory: string; context: AdmissionPolicyObservers; historyContext: HistoryCheckpointContext;
  genesisId: string; root: HistoryContinuationRoot; encryptionKey: Uint8Array;
  mode: 'create-new' | 'open-existing'; restore?: { preparation: PreparedPolicyObserverRestore; approvedDigest: string };
  /** Independent selected-chain replay when inspecting an existing restoration. */
  expectedReplayDigest?: string;
}) {
  const expected = options.expectedReplayDigest;
  if (expected !== undefined && (options.mode !== 'open-existing' || !isHistoryDigest(expected))) throw new Error('Invalid expected policy restoration digest');
  const contextId = historyCheckpointContextId(options.historyContext), rootId = historyCheckpointEnvelopeId(options.root);
  let initial: SavedRestoration | undefined;
  if (options.mode === 'create-new') {
    if (!options.restore) throw new Error('Policy observer restoration requires reviewed complete history');
    const record = readPreparedPolicyObserverRestore(options.restore.preparation, options.restore.approvedDigest,
      options.directory, options.historyContext, options.genesisId, rootId);
    initial = { version: 1, contextId, genesisId: options.genesisId, rootId, state: record.state, replayDigest: record.replayDigest };
  } else if (options.restore) throw new Error('Policy observer restore capability is only for a new destination');
  const storage = openEncryptedLocalState<SavedRestoration>({ path: join(options.directory, POLICY_OBSERVER_RESTORATION_FILENAME),
    key: options.encryptionKey, domain: 'resonance:policy-observer-restoration:v1', maxBytes: 4 * 1024 * 1024,
    mode: options.mode, initial: initial!, validate: (value): value is SavedRestoration =>
      exactWitnessFields(value, ['version', 'contextId', 'genesisId', 'rootId', 'state', 'replayDigest'])
      && value.version === 1 && value.contextId === contextId && value.genesisId === options.genesisId && value.rootId === rootId });
  try {
    const retained = storage.read(), state = await parseAdmissionPolicyObserverState(retained.state, options.context);
    if (retained.replayDigest !== policyObserverReplayDigest(contextId, options.genesisId, historySuccessorProposalId(options.root.proposal), state)
      || expected !== undefined && retained.replayDigest !== expected) {
      throw new Error('Policy observer baseline differs from its reviewed selected history');
    }
    return { state, close: () => storage.close() };
  } catch (error) { storage.close(); throw error; }
}
