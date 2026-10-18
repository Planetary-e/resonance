/** Real, loopback-only protected policy services for the opt-in application evaluation. */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import type { SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver } from '../../packages/relay/src/admission-policy-observation-transport.js';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../../packages/relay/src/protected-policy-observer.js';
import { openHistoryVolunteerService } from '../../packages/relay/src/history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../../packages/relay/src/history-agreement-exchange.js';
import { createAdmissionPolicyQueryResponder } from '../../packages/relay/src/admission-policy-query.js';

export async function realAppPolicyObservers(directory: string, policy: SignedAdmissionPolicy, cleanup: Array<() => void | Promise<void>>) {
  mkdirSync(directory);
  const keys = Array.from({ length: 5 }, generateSigningKeyPair), handlers: Array<(value: unknown) => Promise<unknown>> = [];
  cleanup.push(() => keys.forEach(key => key.secretKey.fill(0)));
  const listeners: Array<Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>> = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenAdmissionPolicyObserver(value => handlers[i](value)); listeners.push(listener); cleanup.push(listener.close);
  }
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: policy.authority,
    genesis: admissionPolicyHead(policy), quorum: 4,
    members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: listeners[i].endpoint })) });
  const historyListeners: Array<Array<Awaited<ReturnType<typeof listenHistoryAgreementReplica>>>> = [];
  for (let i = 0; i < 5; i++) {
    const encryptionKey = randomBytes(32), signingKey = keys[i]; cleanup.push(() => { encryptionKey.fill(0); });
    const root = await createPolicyObserverHistoryRoot({ context, policy, encryptionKey, signingKey }), members = [], retained = [];
    for (let j = 0; j < 5; j++) {
      const localKey = randomBytes(32); cleanup.push(() => { localKey.fill(0); });
      const service = openHistoryVolunteerService({ directory: join(directory, `observer-${i}-replica-${j}`), context: root.context,
        genesisId: historyCheckpointEnvelopeId(root.root), localKey, signingKey: keys[j], initialize: root.root }); cleanup.push(service.close);
      const listener = await listenHistoryAgreementReplica(service); cleanup.push(listener.close); retained.push(listener);
      members.push({ publicKey: Buffer.from(keys[j].publicKey).toString('base64url'), endpoint: listener.checkpointEndpoint });
    }
    historyListeners.push(retained);
    const observer = await openProtectedPolicyObserver({ directory: join(directory, `observer-${i}`), context, historyContext: root.context,
      encryptionKey, signingKey, root: root.root, members, mode: 'create-new' }); cleanup.push(observer.close);
    await observer.ready(); handlers.push(createAdmissionPolicyObserverExchange(observer, context));
  }
  let queries = 0;
  const responder = createAdmissionPolicyQueryResponder({ context, policy: () => policy }); cleanup.push(responder.close);
  return { context, queries: () => queries,
    query: (value: unknown, signal: AbortSignal) => { queries++; return responder.exchange(value, signal); },
    async loseHistoryQuorums() { await Promise.all(historyListeners.flatMap(listeners => listeners.slice(3).map(listener => listener.close()))); },
  };
}
