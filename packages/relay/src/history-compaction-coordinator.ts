/** Historical checkpoint evidence collection and explicit certificate retention.
 * No prefix deletion or writer activation is implied. */
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, historyCheckpointEnvelopeId,
  type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseHistoryCompactionProposal, parseHistoryCompactionVote, parseHistoryCompactionCertificate, parseHistoryCompactionAttestation,
  type HistoryCompactionVote, type HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { createHistoryCompactionControlRequest, historyCompactionCertificateId, parseHistoryCompactionControlFrame,
  parseHistoryCompactionControlRequest, parseHistoryCompactionControlResponse, type HistoryCompactionControlResponse } from '@resonance/core/history-compaction-control';
import { exchangeHistoryCompaction, exchangeHistoryCompactionControl, type HistoryCompactionTransport, type HistoryCompactionControlTransport } from './history-agreement-exchange.js';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

/** Explicit idempotent remote proof retention. Keep the input certificate durably
 * before calling; an error may leave a subset committed. No pruning/readiness authority. */
export async function retainHistoryCompactionCertificate(options: {
  context: HistoryCheckpointContext; genesisId: string; certificate: unknown; signingKey: SigningKeyPair;
  members: readonly HistoryReplicaEndpoint[]; signal?: AbortSignal; timeoutMs?: number; transport?: HistoryCompactionControlTransport;
}): Promise<HistoryCompactionControlResponse[]> {
  const started = performance.now(), issuedAt = Date.now(), context = parseHistoryCheckpointContext(options.context);
  const genesisId = options.genesisId, certificate = parseHistoryCompactionAttestation(options.certificate, context, genesisId);
  const timeoutMs = options.timeoutMs ?? 10000, signal = options.signal, transport = options.transport;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000 || options.members.length !== 5) throw new Error('Invalid compaction retention bounds');
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown compaction retention member');
    assertSecureRelayTransportEndpoint(member.endpoint); const endpoint = new URL(member.endpoint);
    if (!['/history-checkpoint', '/history-agreement'].includes(endpoint.pathname)) throw new Error('Invalid compaction retention endpoint');
    return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('Compaction retention requires five distinct pinned members and endpoints');
  }
  const key = copyAdmissionSigningKey(options.signingKey), controller = new AbortController(), cancel = () => controller.abort();
  const expiresAt = issuedAt + timeoutMs, challenge = randomBytes(32).toString('base64url');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const live = () => {
    if (controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) {
      throw new Error('Compaction retention cancelled or timed out');
    }
  };
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong compaction retention owner');
    const certificateId = historyCompactionCertificateId(certificate, context, genesisId);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    timer = setTimeout(cancel, Math.max(0, Math.min(timeoutMs - (performance.now() - started), expiresAt - Date.now()))); live();
    const responses = await new Promise<HistoryCompactionControlResponse[]>((resolve, reject) => {
      const received: HistoryCompactionControlResponse[] = []; let settled = false, remaining = 5;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(received);
      };
      const aborted = () => finish(new Error('Compaction retention cancelled or timed out'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      members.forEach(member => {
        void Promise.resolve().then(() => {
          live();
          const request = createHistoryCompactionControlRequest({ action: 'retain', genesisId, rootId: certificate.proposal.rootId,
            generation: certificate.proposal.generation, replica: member.publicKey, certificateId, challenge, issuedAt, expiresAt }, context, key);
          return requestHistoryCompactionControl({ context, genesisId, member, frame: { request, certificate },
            timeoutMs, signal: controller.signal, transport });
        }).then(response => {
          if (settled) return; live(); received.push(response);
          if (received.length === 4) finish();
        }).catch(() => {}).finally(() => {
          if (!settled && received.length + --remaining < 4) {
            // Synchronous signature checks can exhaust the deadline before the
            // timer runs. Preserve cancellation/timeout rather than reporting
            // an unavailable quorum after those requests were refused locally.
            try { live(); finish(new Error('Four authenticated compaction retention replies unavailable')); }
            catch (error) { finish(error as Error); }
          }
        });
      });
    });
    live(); return structuredClone(responses);
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); key.secretKey.fill(0); }
}

/** Fresh owner-authorized request and one authenticated historical result. A
 * retention receipt is not a four-copy commit or current admission readiness. */
export async function requestHistoryCompactionControl(options: {
  context: HistoryCheckpointContext; genesisId: string; member: HistoryReplicaEndpoint; frame: unknown;
  signal?: AbortSignal; timeoutMs?: number; transport?: HistoryCompactionControlTransport;
}) {
  const started = performance.now(), context = parseHistoryCheckpointContext(options.context), genesisId = options.genesisId;
  const frame = parseHistoryCompactionControlFrame(options.frame, context, genesisId, Date.now());
  const member = { ...options.member }, timeoutMs = options.timeoutMs ?? 10000, external = options.signal;
  const transport = options.transport ?? exchangeHistoryCompactionControl;
  if (frame.request.replica !== member.publicKey || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) {
    throw new Error('Invalid compaction control member or timeout');
  }
  assertSecureRelayTransportEndpoint(member.endpoint);
  if (!['/history-checkpoint', '/history-agreement'].includes(new URL(member.endpoint).pathname)) throw new Error('Invalid compaction control endpoint');
  const controller = new AbortController(), cancel = () => controller.abort();
  external?.addEventListener('abort', cancel, { once: true }); if (external?.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(0, Math.min(timeoutMs - (performance.now() - started), frame.request.expiresAt - Date.now())));
  const live = () => {
    if (controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= frame.request.expiresAt) throw new Error('Compaction control cancelled or timed out');
    parseHistoryCompactionControlRequest(frame.request, context, genesisId, Date.now());
  };
  try {
    live();
    const raw = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (value?: unknown, error?: unknown) => {
        if (settled) return; settled = true; controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(undefined, new Error('Compaction control cancelled or timed out'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      void Promise.resolve().then(() => {
        live(); return transport(member, structuredClone(frame), controller.signal);
      }).then(value => finish(value), error => finish(undefined, error));
    });
    live(); const response = parseHistoryCompactionControlResponse(raw, frame, context, genesisId); live(); return response;
  } finally { clearTimeout(timer); external?.removeEventListener('abort', cancel); controller.abort(); }
}

export async function collectHistoryCompactionCertificate(options: {
  context: HistoryCheckpointContext; genesisId: string; proposal: unknown; checkpoint: unknown;
  members: readonly HistoryReplicaEndpoint[]; signal?: AbortSignal; timeoutMs?: number; transport?: HistoryCompactionTransport;
}): Promise<HistoryCompactionCertificate> {
  const started = performance.now(), context = parseHistoryCheckpointContext(options.context), genesisId = options.genesisId;
  const proposal = parseHistoryCompactionProposal(options.proposal, context, genesisId, Date.now());
  const checkpoint = parseHistoryCheckpointEnvelope(options.checkpoint, context), timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000 || options.members.length !== 5
    || checkpoint.kind !== 'checkpoint' || checkpoint.generation !== proposal.generation || checkpoint.sequence !== proposal.sequence
    || historyCheckpointEnvelopeId(checkpoint) !== proposal.envelopeId) throw new Error('Invalid compaction collection bounds or checkpoint');
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown compaction member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    const endpoint = new URL(member.endpoint);
    if (!['/history-checkpoint', '/history-agreement'].includes(endpoint.pathname)) throw new Error('Invalid compaction endpoint');
    return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('Compaction needs five distinct pinned members and endpoints');
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  const transport = options.transport ?? exchangeHistoryCompaction;
  const signal = options.signal;
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(0, Math.min(timeoutMs - (performance.now() - started), proposal.expiresAt - Date.now())));
  const live = () => {
    if (controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= proposal.expiresAt) throw new Error('Compaction collection cancelled or timed out');
    parseHistoryCompactionProposal(proposal, context, genesisId, Date.now());
  };
  try {
    live();
    const votes = await new Promise<HistoryCompactionVote[]>((resolve, reject) => {
      const received: HistoryCompactionVote[] = [];
      let remaining = 5, settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(received);
      };
      const aborted = () => finish(new Error('Compaction collection cancelled or timed out'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      members.forEach(member => {
        void Promise.resolve().then(() => {
          live(); return transport(member, structuredClone(proposal), controller.signal);
        }).then(raw => {
          if (settled) return; live();
          const vote = parseHistoryCompactionVote(raw, proposal, context, genesisId);
          if (vote.replica !== member.publicKey) throw new Error('Compaction response belongs to another member');
          live(); received.push(vote);
          if (received.length === 4) finish();
        }).catch(() => {}).finally(() => {
          if (!settled && received.length + --remaining < 4) {
            try { live(); finish(new Error('Four authenticated compaction votes unavailable')); }
            catch (error) { finish(error as Error); }
          }
        });
      });
    });
    live();
    const certificate = parseHistoryCompactionCertificate({ version: 1, kind: 'history-compaction-certificate', proposal, votes }, context, genesisId, checkpoint);
    live(); return certificate;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
}
