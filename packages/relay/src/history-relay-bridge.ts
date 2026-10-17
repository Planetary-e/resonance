/** Single-hop forwarding envelope. It carries the original signed protocol
 * unchanged; the bridge is neither a history member nor a signature authority. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES } from '@resonance/core/history-checkpoint';
import { HISTORY_COMPACTION_CONTROL_MAX_BYTES } from '@resonance/core/history-compaction-control';
import { HISTORY_ROLE_LIMITS, type HistoryRoleMethod } from './history-relay-link.js';
import { HISTORY_CONTINUATION_RESPONSE_MAX_BYTES, HISTORY_EXCHANGE_MAX_BYTES } from './history-checkpoint-exchange.js';
import { HISTORY_AGREEMENT_MAX_RESPONSE_BYTES } from './history-agreement-exchange.js';

export interface HistoryRelayMemberRoute { publicKey: string; relayId: string; viaRelayId?: string }
export interface HistoryRelayBridgeRoute { controllerRelayId: string; targetRelayId: string }
export function isHistoryRelayId(id: unknown): id is string {
  return typeof id === 'string' && /^did:key:z[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(id);
}
export function parseHistoryBridgeFrame(raw: unknown) {
  if (!exactWitnessFields(raw, ['version', 'targetRelayId', 'method', 'frame']) || raw.version !== 1
    || !isHistoryRelayId(raw.targetRelayId) || typeof raw.method !== 'string' || !Object.hasOwn(HISTORY_ROLE_LIMITS, raw.method)
    || !raw.frame || typeof raw.frame !== 'object' || Array.isArray(raw.frame)) throw new Error('Invalid single-hop history bridge frame');
  const method = raw.method as HistoryRoleMethod;
  if (Buffer.byteLength(JSON.stringify(raw.frame)) > HISTORY_ROLE_LIMITS[method][0]) throw new Error('History bridge payload too large');
  return { targetRelayId: raw.targetRelayId, method, frame: raw.frame };
}
/** Preserve the same action-specific response cap even when using a bridge. */
export function historyRoleResponseLimit(method: HistoryRoleMethod, value: unknown) {
  const frame = value as { request?: { action?: unknown }; action?: unknown; kind?: unknown } | null;
  switch (method) {
    case 'checkpoint': return frame?.request?.action === 'read' ? HISTORY_EXCHANGE_MAX_BYTES
      : frame?.request?.action === 'continuation' ? HISTORY_CONTINUATION_RESPONSE_MAX_BYTES : 4096;
    case 'agreement': return frame?.request?.action === 'promise' ? HISTORY_AGREEMENT_MAX_RESPONSE_BYTES : 4096;
    case 'transfer': return frame?.action === 'read' ? HISTORY_ENVELOPE_MAX_BYTES + 4096 : 4096;
    case 'provision': return 1024;
    case 'compaction': return frame?.kind === 'history-compaction-proposal' ? 1024 : HISTORY_COMPACTION_CONTROL_MAX_BYTES;
  }
}
