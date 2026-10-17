/** Copy a verified live prefix before asking a lagging member to acknowledge the pending write. */
import type { SigningKeyPair } from '@resonance/core';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, parseHistoryCheckpointEnvelope,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES,
  parseHistoryExchangeResponse, type HistoryReplicaHead } from '@resonance/core/history-exchange';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import { isHistoryWriterPrefix, type HistoryWriterRepairSource } from './history-writer-prefix.js';
import { parseHistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { historyCompactionCertificateId } from '@resonance/core/history-compaction-control';

export function createHistoryWriterRepair(options: {
  context: HistoryCheckpointContext; key: SigningKeyPair; rootId: string; block: HistoryCheckpointEnvelope;
  retained: () => HistoryWriterRepairSource; transport: HistoryCheckpointTransport;
  challenge: string; issuedAt: number; expiresAt: number; live: () => void;
}) {
  const { context, key, rootId, block, transport, live } = options;
  const targetId = historyCheckpointEnvelopeId(block);
  const blocks: HistoryCheckpointEnvelope[] = [], ids: string[] = [];
  const source = options.retained(), indexed = isHistoryWriterPrefix(source) ? source : null;
  const compaction = indexed?.compaction;
  let bytes = 0;
  function add(raw: HistoryCheckpointEnvelope) {
    live();
    if (blocks.length >= HISTORY_RECOVERY_MAX_BLOCKS || blocks.length > block.sequence) throw new Error('Retained writer block capacity exceeded');
    bytes += Buffer.byteLength(JSON.stringify(raw));
    if (bytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('Retained writer byte capacity exceeded');
    const parsed = parseHistoryCheckpointEnvelope(raw, context), id = historyCheckpointEnvelopeId(parsed);
    if (parsed.generation !== block.generation || parsed.sequence !== blocks.length
      || parsed.previous !== (ids.at(-1) ?? null) || (!blocks.length && id !== rootId)) {
      throw new Error('Retained writer history has a gap, fork or different root');
    }
    blocks.push(parsed); ids.push(id);
  }
  // The writer separately persists the exact pending block. A retained source may
  // already include that block, but must never contain a later speculative tail.
  if (indexed) {
    const included = indexed.count === block.sequence + 1, start = compaction?.certificate.proposal.sequence ?? 0;
    if (indexed.contextId !== historyCheckpointContextId(context) || indexed.rootId !== rootId || indexed.generation !== block.generation
      || !Number.isSafeInteger(indexed.bytes) || indexed.bytes < 0
      || !Number.isSafeInteger(indexed.count) || indexed.count < 0 || (!included && indexed.count !== block.sequence)
      || !Number.isSafeInteger(indexed.retainedCount) || indexed.retainedCount < 0
      || indexed.retainedCount + (included ? 0 : 1) > HISTORY_RECOVERY_MAX_BLOCKS
      || !Number.isSafeInteger(start) || start < 0 || start > block.sequence || block.sequence - start >= HISTORY_RECOVERY_MAX_BLOCKS
      || indexed.bytes + (included ? 0 : Buffer.byteLength(JSON.stringify(block))) > HISTORY_RECOVERY_MAX_BYTES
      || (indexed.count && indexed.idAt(0) !== rootId)
      || indexed.idAt(indexed.count - 1) !== (included ? targetId : block.previous)) {
      throw new Error('Indexed writer history does not match the pending block');
    }
  } else {
    for (const raw of source as Iterable<HistoryCheckpointEnvelope>) add(raw);
    if (blocks.length === block.sequence) add(block);
    if (blocks.length !== block.sequence + 1 || ids.at(-1) !== targetId) {
      throw new Error('Retained writer history does not reach the pending block');
    }
  }
  live();
  const idAt = (sequence: number) => sequence === block.sequence ? targetId
    : indexed ? indexed.idAt(sequence) : ids[sequence];
  function blockAt(sequence: number) {
    if (!indexed) return blocks[sequence];
    const value = parseHistoryCheckpointEnvelope(indexed.blockAt(sequence), context);
    const previous = sequence ? idAt(sequence - 1) : null;
    const certifiedGap = sequence > 0 && previous === null && sequence === compaction?.certificate.proposal.sequence;
    if (value.generation !== block.generation || value.sequence !== sequence || (!certifiedGap && value.previous !== previous)
      || historyCheckpointEnvelopeId(value) !== idAt(sequence)) throw new Error('Indexed writer payload changed');
    return value;
  }
  function position(head: HistoryReplicaHead): number {
    const known = idAt(head.sequence);
    if (head.freeze || head.sequence > block.sequence || (known !== null ? known !== head.envelopeId
      : !proof || head.sequence >= proof.proposal.sequence)) {
      throw new Error('Cannot repair frozen, divergent or newer replica history');
    }
    return head.sequence + 1;
  }
  const proof = compaction ? parseHistoryCompactionCertificate(compaction.certificate, context, compaction.genesisId,
    blockAt(compaction.certificate.proposal.sequence)) : null;
  if (proof && (proof.proposal.rootId !== rootId || proof.proposal.generation !== block.generation
    || proof.proposal.sequence > block.sequence)) throw new Error('Writer repair checkpoint belongs to another history');
  const certificateId = proof ? historyCompactionCertificateId(proof, context, compaction!.genesisId) : null;
  return {
    async synchronize(member: HistoryReplicaEndpoint, signal: AbortSignal, throughTarget = false) {
      function active() { live(); if (signal.aborted) throw new Error('History repair cancelled'); }
      async function send(sequence: number | null) {
        active();
        const request = createHistoryExchangeRequest({ action: sequence === null ? 'head' : 'append', rootId,
          generation: block.generation, replica: member.publicKey, challenge: options.challenge,
          issuedAt: options.issuedAt, expiresAt: options.expiresAt, sequence: sequence ?? 0,
          envelopeId: sequence === null ? null : idAt(sequence)! }, context, key);
        const response = await transport(member, { request, envelope: sequence === null ? null : structuredClone(blockAt(sequence)) }, signal);
        active(); const parsed = parseHistoryExchangeResponse(response, request, context); active(); return parsed;
      }
      let response = await send(null), next = position(response.head);
      // A read of an already current replica does not authorize maintenance or
      // resend a certified checkpoint merely to reclaim an older prefix.
      if (throughTarget && next === block.sequence + 1) { active(); return response; }
      if (proof && (next <= proof.proposal.sequence || compaction!.reclaimPrefix && next === proof.proposal.sequence + 1)) {
        active(); const checkpoint = blockAt(proof.proposal.sequence);
        const request = createHistoryExchangeRequest({ action: 'install', rootId, generation: block.generation,
          replica: member.publicKey, challenge: options.challenge, issuedAt: options.issuedAt, expiresAt: options.expiresAt,
          sequence: checkpoint.sequence, envelopeId: proof.proposal.envelopeId, certificateId: certificateId!,
          ...(compaction!.reclaimPrefix ? { reclaimPrefix: true as const } : {}) }, context, key);
        const raw = await transport(member, { request, envelope: structuredClone(checkpoint), compaction: structuredClone(proof) }, signal);
        active(); response = parseHistoryExchangeResponse(raw, request, context); next = position(response.head); active();
      }
      while (next < block.sequence || throughTarget && next === block.sequence) {
        const before = next; response = await send(next); next = position(response.head);
        if (next <= before) throw new Error('Live history repair made no progress');
      }
      // Writes still require a fresh append receipt separately. Read observations
      // may use this request-bound current head, repairing through the target only
      // when necessary. A head receipt is never converted into a write certificate.
      active(); return response;
    },
  };
}
