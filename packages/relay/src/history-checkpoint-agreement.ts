/** Explicit replica entry point; live admission and writer activation remain separate. */
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import type { openHistoryCheckpointStore } from './history-checkpoint-store.js';

export function createHistoryAgreementReplica(options: {
  context: HistoryCheckpointContext; store: ReturnType<typeof openHistoryCheckpointStore>;
  signingKey: SigningKeyPair; now?: () => number;
}) {
  const context = parseHistoryCheckpointContext(options.context), key = copyAdmissionSigningKey(options.signingKey);
  try {
    if (!options.store.matches(context, Buffer.from(key.publicKey).toString('base64url'))) throw new Error('Agreement replica/store mismatch');
  } catch (error) { key.secretKey.fill(0); throw error; }
  let closed = false;
  return {
    exchange(frame: unknown) {
      if (closed) throw new Error('Agreement replica is closed');
      return options.store.exchangeAgreement(frame, key, options.now);
    },
    transfer(frame: unknown) {
      if (closed) throw new Error('Agreement replica is closed');
      return options.store.exchangeAgreementData(frame, key, options.now);
    },
    close() { if (!closed) { closed = true; key.secretKey.fill(0); } },
  };
}
