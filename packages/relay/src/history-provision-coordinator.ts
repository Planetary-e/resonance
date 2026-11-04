/** Explicit owner provisioning attempts. Reopen/read never send; success is historical creation evidence. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest, parseHistoryProvisionReceipt, parseHistoryProvisionRequest,
  type HistoryProvisionReceipt, type HistoryProvisionRequest } from '@resonance/core/history-provision';
import { exchangeHistoryProvision, type HistoryProvisionTransport } from './history-agreement-exchange.js';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export const HISTORY_PROVISION_OWNER_FILENAME = 'history-provision-owner.json';
interface State { version: 1; root: HistoryContinuationRoot; requests: HistoryProvisionRequest[]; receipts: HistoryProvisionReceipt[] }
export function createHistoryProvisionCoordinator(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  root: HistoryContinuationRoot; members: HistoryReplicaEndpoint[]; initialize?: boolean;
  timeoutMs?: number; transport?: HistoryProvisionTransport;
}) {
  const context = parseHistoryCheckpointContext(options.context), root = parseHistoryContinuationRoot(options.root, context);
  const rootId = historyContinuationRootId(root), timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000 || options.members.length !== 5) throw new Error('Invalid provision coordinator bounds');
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown provision member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    const endpoint = new URL(member.endpoint);
    if (endpoint.pathname !== '/history-agreement') throw new Error('Invalid provision endpoint');
    return { publicKey: member.publicKey, endpoint: endpoint.href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) throw new Error('Provisioning requires five distinct pinned members and endpoints');
  function validate(raw: unknown): raw is State {
    if (!exactWitnessFields(raw, ['version', 'root', 'requests', 'receipts']) || raw.version !== 1
      || !Array.isArray(raw.requests) || !Array.isArray(raw.receipts)) return false;
    try {
      if (historyContinuationRootId(parseHistoryContinuationRoot(raw.root, context)) !== rootId) return false;
      if (!raw.requests.length) return !raw.receipts.length;
      if (raw.requests.length !== 5 || ![0, 4].includes(raw.receipts.length)) return false;
      const requests = raw.requests.map(r => parseHistoryProvisionRequest(r, context)), first = requests[0];
      if (new Set(requests.map(r => r.replica)).size !== 5 || requests.some(r => historyContinuationRootId(r.root) !== rootId
        || r.challenge !== first.challenge || r.issuedAt !== first.issuedAt || r.expiresAt !== first.expiresAt)) return false;
      const used = new Set<string>();
      for (const receipt of raw.receipts) {
        let found: string | undefined;
        for (const request of requests) {
          try { parseHistoryProvisionReceipt(receipt, request); found = request.replica; break; } catch { /* Different target. */ }
        }
        if (!found || used.has(found)) return false; used.add(found);
      }
      return true;
    } catch { return false; }
  }
  const key = copyAdmissionSigningKey(options.signingKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong provision owner');
    storage = openEncryptedLocalState<State>({ path: join(options.directory, HISTORY_PROVISION_OWNER_FILENAME), key: options.localKey,
      domain: 'resonance:history-provision-owner:v1', maxBytes: 512 * 1024, initial: { version: 1, root, requests: [], receipts: [] },
      validate, mode: options.initialize ? 'create-new' : 'open-existing' });
  } catch (error) { key.secretKey.fill(0); throw error; }
  let active: AbortController | undefined, closed = false;
  const transport = options.transport ?? exchangeHistoryProvision;
  return {
    read(): State { return structuredClone(storage.read()); },
    /** Every explicit run asks for fresh receipts, even after an earlier successful creation. */
    async run(signal?: AbortSignal): Promise<HistoryProvisionReceipt[]> {
      storage.read();
      if (active || signal?.aborted) throw new Error('Provision attempt active or cancelled');
      const controller = new AbortController(); active = controller;
      const started = performance.now(), issuedAt = Date.now(), expiresAt = issuedAt + timeoutMs;
      const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      const live = () => {
        if (closed || controller.signal.aborted || Date.now() >= expiresAt || performance.now() - started >= timeoutMs) throw new Error('Provision attempt cancelled or timed out');
      };
      try {
        const challenge = randomBytes(32).toString('base64url');
        const requests = members.map(member => createHistoryProvisionRequest({ root, replica: member.publicKey, challenge, issuedAt, expiresAt }, context, key));
        storage.write({ version: 1, root, requests, receipts: [] }); live();
        const receipts = await new Promise<HistoryProvisionReceipt[]>((resolve, reject) => {
          const received: HistoryProvisionReceipt[] = []; let remaining = 5, settled = false;
          const finish = (error?: Error) => {
            if (settled) return; settled = true; controller.signal.removeEventListener('abort', aborted);
            if (error) reject(error); else resolve(received);
          };
          const aborted = () => finish(new Error('Provision attempt cancelled or timed out'));
          controller.signal.addEventListener('abort', aborted, { once: true });
          members.forEach((member, i) => {
            void Promise.resolve().then(() => { live(); return transport(member, structuredClone(requests[i]), controller.signal); }).then(raw => {
              if (settled) return; live();
              const receipt = parseHistoryProvisionReceipt(raw, requests[i]);
              parseHistoryProvisionRequest(requests[i], context, Date.now()); live(); received.push(receipt);
              if (received.length === 4) finish();
            }).catch(() => {}).finally(() => {
              if (!settled && received.length + --remaining < 4) finish(new Error('Four authenticated provision receipts unavailable'));
            });
          });
        });
        live(); storage.write({ version: 1, root, requests, receipts }); live();
        return structuredClone(receipts);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); if (active === controller) active = undefined; }
    },
    close() { if (!closed) { closed = true; active?.abort(); storage.close(); key.secretKey.fill(0); } },
  };
}
