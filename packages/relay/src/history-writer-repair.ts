/** Copy a verified live prefix before asking a lagging member to acknowledge the pending write. */
import type { SigningKeyPair } from '@resonance/core';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, parseHistoryCheckpointEnvelope,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES,
  parseHistoryExchangeResponse, type HistoryReplicaHead } from '@resonance/core/history-exchange';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import { isHistoryWriterPrefix, type HistoryWriterRepairSource } from './history-writer-prefix.js';

export function createHistoryWriterRepair(options: {
  context: HistoryCheckpointContext; key: SigningKeyPair; rootId: string; block: HistoryCheckpointEnvelope;
  retained: () => HistoryWriterRepairSource; transport: HistoryCheckpointTransport;
  challenge: string; issuedAt: number; expiresAt: number; live: () => void;
}) {
  const { context, key, rootId, block, transport, live } = options;
  const targetId = historyCheckpointEnvelopeId(block);
  const blocks: HistoryCheckpointEnvelope[] = [], ids: string[] = [];
  const source = options.retained(), indexed = isHistoryWriterPrefix(source) ? source : null;
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
    const included = indexed.count === block.sequence + 1;
    if (indexed.contextId !== historyCheckpointContextId(context) || indexed.rootId !== rootId || indexed.generation !== block.generation
      || !Number.isSafeInteger(indexed.bytes) || indexed.bytes < 0
      || (!included && indexed.count !== block.sequence) || block.sequence >= HISTORY_RECOVERY_MAX_BLOCKS
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
    if (value.generation !== block.generation || value.sequence !== sequence || value.previous !== (sequence ? idAt(sequence - 1) : null)
      || historyCheckpointEnvelopeId(value) !== idAt(sequence)) throw new Error('Indexed writer payload changed');
    return value;
  }
  function position(head: HistoryReplicaHead): number {
    if (head.freeze || head.sequence > block.sequence || idAt(head.sequence) !== head.envelopeId) {
      throw new Error('Cannot repair frozen, divergent or newer replica history');
    }
    return head.sequence + 1;
  }
  return {
    async synchronize(member: HistoryReplicaEndpoint, signal: AbortSignal) {
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
      let next = position((await send(null)).head);
      while (next < block.sequence) {
        const before = next; next = position((await send(next)).head);
        if (next <= before) throw new Error('Live history repair made no progress');
      }
      // Even a member that already has the target must supply a fresh append
      // receipt to the writer; a head reply or a repaired-prefix receipt cannot count.
      active();
    },
  };
}
