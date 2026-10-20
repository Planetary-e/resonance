/** Fixed-context, bounded policy artifacts. A cached signed successor is useful
 * for catch-up but never substitutes for a fresh four-observer head. */
import { parseAdmissionPolicyObservers, type AdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { ADMISSION_POLICY_EVIDENCE_TYPE, parseAdmissionPolicyEvidenceRequest, createAdmissionPolicyEvidenceReply, type AdmissionPolicyChunkRequest, type AdmissionPolicyChunkReply, type AdmissionPolicyEvidenceRequest, type AdmissionPolicyEvidenceReply } from '@resonance/core/admission-policy-transfer';
import { verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { admissionPolicyArchivePageDigest, decodeAdmissionPolicyArchivePage } from '@resonance/core/admission-policy-archive';
import { createArchivedAdmissionPolicyTransfer, parseAdmissionPolicyChunkRequest } from '@resonance/core/admission-policy-transfer';

export function createAdmissionPolicyTransferResponder(options: {
  context: AdmissionPolicyObservers; successor: (previous: AdmissionPolicyHead, signal: AbortSignal) => Promise<unknown>;
  genesis?: (signal: AbortSignal) => Promise<unknown>;
  page?: (head: AdmissionPolicyHead, digest: string, signal: AbortSignal) => Promise<Uint8Array>;
  timeoutMs?: number;
}) {
  const context = parseAdmissionPolicyObservers(options.context), timeout = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('Invalid policy transfer timeout');
  const cache: Array<{ artifact: Awaited<ReturnType<typeof createArchivedAdmissionPolicyTransfer>>; expires: number }> = [];
  let active: { controller: AbortController; drained: Promise<void> } | undefined, closing = false;
  async function exchange(value: AdmissionPolicyChunkRequest, signal?: AbortSignal): Promise<AdmissionPolicyChunkReply>;
  async function exchange(value: AdmissionPolicyEvidenceRequest, signal?: AbortSignal): Promise<AdmissionPolicyEvidenceReply>;
  async function exchange(value: unknown, signal?: AbortSignal): Promise<AdmissionPolicyChunkReply | AdmissionPolicyEvidenceReply>;
  async function exchange(value: unknown, signal?: AbortSignal): Promise<AdmissionPolicyChunkReply | AdmissionPolicyEvidenceReply> {
      signal?.throwIfAborted(); const evidence = (value as { type?: unknown })?.type === ADMISSION_POLICY_EVIDENCE_TYPE;
      const request = evidence ? parseAdmissionPolicyEvidenceRequest(value, context) : parseAdmissionPolicyChunkRequest(value, context);
      if (closing) throw new Error('Policy transfer responder is closed');
      for (let i = cache.length - 1; i >= 0; i--) if (performance.now() >= cache[i].expires) cache.splice(i, 1);
      const legacy = evidence ? undefined : parseAdmissionPolicyChunkRequest(request, context);
      const saved = legacy && cache.find(entry => legacy.artifact === null
        ? sameAdmissionPolicyHead(entry.artifact.previous, legacy.previous) : entry.artifact.artifact === legacy.artifact);
      if (saved) return saved.artifact.chunk(legacy!);
      if (legacy && legacy.artifact !== null) throw new Error('Policy artifact is no longer available; restart its transfer');
      if (active) throw new Error('Policy artifact preparation is busy');
      const controller = new AbortController(), deadline = performance.now() + timeout;
      const abort = () => controller.abort(new Error('Policy artifact preparation cancelled or timed out'));
      const timer = setTimeout(abort, timeout); signal?.addEventListener('abort', abort, { once: true });
      const check = () => { if (performance.now() >= deadline) abort(); controller.signal.throwIfAborted(); signal?.throwIfAborted(); };
      const job = { controller, drained: Promise.resolve() }; active = job;
      let rejectAbort!: (error: Error) => void;
      const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const aborted = () => rejectAbort(new Error('Policy artifact preparation cancelled or timed out'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      const work = Promise.resolve().then(async () => {
        check();
        if (evidence) {
          const selected = request as AdmissionPolicyEvidenceRequest;
          let bytes: Uint8Array;
          if (selected.kind === 'genesis') {
            if (!options.genesis) throw new Error('Original genesis transfer is unavailable');
            const policy = await verifyAdmissionPolicy(await options.genesis(controller.signal), context.authority); check();
            if (!sameAdmissionPolicyHead(admissionPolicyHead(policy), context.genesis)) throw new Error('Original genesis differs from pins');
            bytes = Buffer.from(JSON.stringify(policy));
          } else {
            if (!options.page) throw new Error('Historical page transfer is unavailable');
            bytes = Uint8Array.from(await options.page(selected.head, selected.digest!, controller.signal)); check();
            if (admissionPolicyArchivePageDigest(bytes) !== selected.digest) throw new Error('Historical page differs from request');
            const page = await decodeAdmissionPolicyArchivePage(bytes); check();
            if (page.contextId !== selected.contextId) throw new Error('Historical page context differs');
          }
          return createAdmissionPolicyEvidenceReply(bytes, selected, context);
        }
        const value = await options.successor(legacy!.previous, controller.signal); check();
        const artifact = await createArchivedAdmissionPolicyTransfer(value, context); check();
        const result = artifact.chunk(legacy!); check();
        if (cache.length === 2) cache.shift(); cache.push({ artifact, expires: performance.now() + 30000 });
        return result;
      });
      // Cancellation returns promptly but does not free the preparation slot
      // until the source/verification actually finishes.
      job.drained = work.then(() => {}, () => {}).finally(() => { if (active === job) active = undefined; });
      try { return await Promise.race([work, cancelled]); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', aborted); controller.abort(); }
  }
  return {
    exchange,
    health() { return { operations: active ? 1 : 0, cachedArtifacts: cache.length, cachedBytes: cache.reduce((sum, entry) => sum + entry.artifact.bytes, 0) }; },
    async close() { closing = true; cache.length = 0; const job = active; job?.controller.abort(); await job?.drained; },
  };
}
