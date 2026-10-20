/** Fresh four-member discovery of retained historical checkpoint evidence.
 * The caller must pin the result before recovery. Never reselect an anchor while
 * resuming a durable recovery workspace; historical evidence is not readiness. */
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { isHistoryDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { createHistoryFrontierRequest, parseHistoryFrontierResponse, type HistoryFrontierResponse } from '@resonance/core/history-frontier';
import type { HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import { exchangeHistoryFrontier, type HistoryFrontierTransport } from './history-agreement-exchange.js';

export async function discoverHistoryCompactionFrontier(options: {
  context: HistoryCheckpointContext; genesisId: string; signingKey: SigningKeyPair; members: readonly HistoryReplicaEndpoint[];
  signal?: AbortSignal; timeoutMs?: number; transport?: HistoryFrontierTransport;
}): Promise<{ certificate: HistoryCompactionCertificate | null; receipts: HistoryFrontierResponse[] }> {
  const started = performance.now(), issuedAt = Date.now(), context = parseHistoryCheckpointContext(options.context);
  const genesisId = options.genesisId, timeoutMs = options.timeoutMs ?? 10000, signal = options.signal;
  if (!isHistoryDigest(genesisId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000 || options.members.length !== 5) {
    throw new Error('Invalid history frontier discovery bounds');
  }
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown history frontier member');
    assertSecureRelayTransportEndpoint(member.endpoint); const endpoint = new URL(member.endpoint);
    if (!['/history-checkpoint', '/history-agreement'].includes(endpoint.pathname)) throw new Error('Invalid history frontier endpoint');
    return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('History frontier needs five distinct pinned members and endpoints');
  }
  const key = copyAdmissionSigningKey(options.signingKey), controller = new AbortController(), cancel = () => controller.abort();
  const expiresAt = issuedAt + timeoutMs, challenge = randomBytes(32).toString('base64url');
  const transport = options.transport ?? exchangeHistoryFrontier;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const live = () => {
    if (controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() < issuedAt || Date.now() >= expiresAt) {
      throw new Error('History frontier discovery cancelled or timed out');
    }
  };
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history frontier owner');
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    timer = setTimeout(cancel, Math.max(0, Math.min(timeoutMs - (performance.now() - started), expiresAt - Date.now()))); live();
    const receipts = await new Promise<HistoryFrontierResponse[]>((resolve, reject) => {
      const received: HistoryFrontierResponse[] = []; let settled = false, remaining = 5;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(received);
      };
      const aborted = () => finish(new Error('History frontier discovery cancelled or timed out'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      members.forEach(member => {
        void Promise.resolve().then(async () => {
          live();
          const request = createHistoryFrontierRequest({ genesisId, replica: member.publicKey, challenge, issuedAt, expiresAt }, context, key);
          live(); const raw = await transport(member, structuredClone(request), controller.signal);
          if (settled) return;
          live(); const response = parseHistoryFrontierResponse(raw, request, context, genesisId); live();
          received.push(response); if (received.length === 4) finish();
        }).catch(() => {}).finally(() => {
          if (!settled && received.length + --remaining < 4) {
            try { live(); finish(new Error('Four authenticated history frontier replies unavailable')); }
            catch (error) { finish(error as Error); }
          }
        });
      });
    });
    live();
    const proofs = receipts.flatMap(r => r.certificate ? [r.certificate] : []);
    // Refuse contradictory certified evidence observed in this quorum. A
    // different vote subset for the same checkpoint is not a contradiction.
    for (const a of proofs) for (const b of proofs) {
      if (a.proposal.generation === b.proposal.generation && (a.proposal.rootId !== b.proposal.rootId
        || a.proposal.sequence === b.proposal.sequence && a.proposal.envelopeId !== b.proposal.envelopeId)) {
        throw new Error('Conflicting certified history frontiers require inspection');
      }
    }
    proofs.sort((a, b) => b.proposal.generation - a.proposal.generation || b.proposal.sequence - a.proposal.sequence);
    live(); return structuredClone({ certificate: proofs[0] ?? null, receipts });
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); key.secretKey.fill(0); }
}
