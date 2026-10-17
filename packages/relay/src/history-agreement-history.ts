/** Complete-history checks and bounded suffix write-back before agreement preparation. */
import type { SigningKeyPair } from '@resonance/core';
import { historyCheckpointEnvelopeId, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { assertHistorySuccessorChain, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { parseHistoryCompactionAttestation } from '@resonance/core/history-compaction';
import { assertHistoryCompactedSuccessorChain } from '@resonance/core/history-compacted-chain';
import { parseHistoryAgreementRequest, type HistoryAgreementFrame } from '@resonance/core/history-agreement';
import { createHistoryAgreementDataFrame, parseHistoryAgreementDataResponse, type HistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import type { HistoryAgreementDataTransport } from './history-agreement-exchange.js';

export function createHistoryAgreementHistory(options: {
  context: HistoryCheckpointContext; key: SigningKeyPair; members: HistoryReplicaEndpoint[];
  proposal: HistorySuccessorProposal; authorization: (member: HistoryReplicaEndpoint) => HistoryAgreementFrame;
  transport: HistoryAgreementDataTransport; signal: AbortSignal; live: () => void;
  /** A completed ancestry cache, iterated oldest first. Its selected generation is revalidated here. */
  retained?: () => Iterable<HistoryCheckpointEnvelope>;
  compaction?: { genesisId: string; certificate: unknown };
}) {
  const { context, key, members, proposal, transport, live, signal } = options;
  if (options.compaction !== undefined && !exactWitnessFields(options.compaction, ['genesisId', 'certificate'])) throw new Error('Invalid compacted transfer pins');
  const genesisId = options.compaction?.genesisId;
  const compaction = options.compaction ? parseHistoryCompactionAttestation(options.compaction.certificate, context, genesisId!) : undefined;
  if (compaction && (compaction.proposal.rootId !== proposal.rootId || compaction.proposal.generation !== proposal.generation
    || compaction.proposal.sequence > proposal.sequence)) throw new Error('Compacted transfer proof does not match selection');
  const start = compaction?.proposal.sequence ?? 0;
  const blocks: HistoryCheckpointEnvelope[] = [], ids: string[] = [];
  function verify() {
    if (compaction) assertHistoryCompactedSuccessorChain({ proposal, certificate: compaction, checkpoint: blocks[start],
      context, genesisId: genesisId!, ids: ids.slice(start) });
    else assertHistorySuccessorChain(proposal, ids);
  }
  async function send(member: HistoryReplicaEndpoint, action: HistoryAgreementDataFrame['action'], sequence: number,
    envelopeId: string, group: AbortSignal, envelope: HistoryCheckpointEnvelope | null = null) {
    live(); if (group.aborted) throw new Error('History transfer cancelled');
    const frame = createHistoryAgreementDataFrame({ action, authorization: options.authorization(member), sequence, envelopeId, envelope,
      ...(action === 'stage' && sequence === start && compaction ? { compaction } : {}) }, context, key, genesisId);
    const raw = await transport(member, structuredClone(frame), group);
    live(); if (group.aborted) throw new Error('History transfer cancelled');
    const response = parseHistoryAgreementDataResponse(raw, frame, context);
    parseHistoryAgreementRequest(frame.authorization.request, context, Date.now()); live(); return response;
  }
  return {
    /** Follow authenticated predecessor hashes backwards, trying every pinned source. */
    async download() {
      if (proposal.sequence > 10_000) throw new Error('History transfer block capacity exceeded');
      if (options.retained) {
        let count = 0, bytes = 0, generationBytes = 0;
        for (const raw of options.retained()) {
          live();
          const size = Buffer.byteLength(JSON.stringify(raw)); bytes += size;
          if (++count > 10_001 || bytes > 256 * 1024 * 1024) throw new Error('Retained ancestry capacity exceeded');
          const block = parseHistoryCheckpointEnvelope(raw, context);
          if (block.generation !== proposal.generation || block.sequence < start) continue;
          generationBytes += size;
          if (generationBytes > 64 * 1024 * 1024 || block.sequence !== Math.max(start, blocks.length)
            || (!(compaction && block.sequence === start) && block.previous !== (ids.at(-1) ?? null))) throw new Error('Retained history is incomplete or out of order');
          blocks[block.sequence] = block; ids[block.sequence] = historyCheckpointEnvelopeId(block);
        }
        verify(); live(); return;
      }
      let expected = proposal.envelopeId, size = 0;
      for (let sequence = proposal.sequence; sequence >= start; sequence--) {
        live();
        const envelope = await new Promise<HistoryCheckpointEnvelope>((resolve, reject) => {
          const group = new AbortController(); let settled = false, remaining = members.length;
          const finish = (envelope?: HistoryCheckpointEnvelope) => {
            if (settled) return; settled = true; signal.removeEventListener('abort', abort); group.abort();
            if (envelope) resolve(envelope); else reject(new Error('Selected history unavailable or transfer cancelled'));
          };
          const abort = () => finish(); signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { abort(); return; }
          for (const member of members) void send(member, 'read', sequence, expected, group.signal)
            .then(r => finish(r.envelope!)).catch(() => {}).finally(() => { if (--remaining === 0) finish(); });
        });
        size += Buffer.byteLength(JSON.stringify(envelope));
        if (size > 64 * 1024 * 1024) throw new Error('History transfer byte capacity exceeded');
        blocks[sequence] = envelope; ids[sequence] = historyCheckpointEnvelopeId(envelope); expected = envelope.previous!;
      }
      verify(); live();
    },
    async synchronize(member: HistoryReplicaEndpoint, group: AbortSignal) {
      let response = await send(member, 'head', proposal.sequence, proposal.envelopeId, group);
      function position() {
        const { head, pending } = response;
        if (head.sequence > proposal.sequence || (head.sequence >= start && ids[head.sequence] !== head.envelopeId)
          || (head.sequence === 0 && head.envelopeId !== proposal.rootId)) throw new Error('Replica retains different or newer history');
        if (pending && (pending.sequence <= head.sequence || pending.sequence < start || pending.sequence > proposal.sequence || ids[pending.sequence] !== pending.envelopeId)) {
          throw new Error('Invalid staged history position');
        }
        return head.sequence === proposal.sequence ? null : pending?.sequence ?? proposal.sequence;
      }
      let next = position();
      while (next !== null) {
        const before = next;
        response = await send(member, 'stage', next, ids[next], group, blocks[next]);
        next = position();
        if (next !== null && next >= before) throw new Error('History transfer made no progress');
      }
    },
  };
}
