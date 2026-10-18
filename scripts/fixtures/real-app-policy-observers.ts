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
import type { RealAppNetwork } from './real-app-network.js';
import { exchangeHistoryCheckpoint } from '../../packages/relay/src/history-checkpoint-exchange.js';
import { createRealAppHistoryLinks } from './real-app-history-links.js';

export async function realAppPolicyObservers(directory: string, policy: SignedAdmissionPolicy, cleanup: Array<() => void | Promise<void>>, network: RealAppNetwork, historyLinks = false) {
  mkdirSync(directory);
  const keys = Array.from({ length: 5 }, generateSigningKeyPair), handlers: Array<(value: unknown) => Promise<unknown>> = [];
  cleanup.push(() => keys.forEach(key => key.secretKey.fill(0)));
  const listeners: Array<Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>> = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenAdmissionPolicyObserver(value => handlers[i](value)); cleanup.push(listener.close);
    listeners.push({ ...listener, endpoint: await network.protect('policy-observer', listener.endpoint) });
  }
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: policy.authority,
    genesis: admissionPolicyHead(policy), quorum: 4,
    members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: listeners[i].endpoint })) });
  const links = historyLinks ? await createRealAppHistoryLinks(join(directory, 'history-links'), keys, 5, 'policy-history', network, cleanup) : undefined;
  const historyListeners: Array<Array<Awaited<ReturnType<typeof listenHistoryAgreementReplica>>>> = [];
  const linkedOwners: Array<Awaited<ReturnType<NonNullable<typeof links>['owner']>>> = [];
  for (let i = 0; i < 5; i++) {
    const encryptionKey = randomBytes(32), signingKey = keys[i]; cleanup.push(() => { encryptionKey.fill(0); });
    const root = await createPolicyObserverHistoryRoot({ context, policy, encryptionKey, signingKey }), members = [], retained = [];
    for (let j = 0; j < 5; j++) {
      const localKey = randomBytes(32); cleanup.push(() => { localKey.fill(0); });
      const service = openHistoryVolunteerService({ directory: join(directory, `observer-${i}-replica-${j}`), context: root.context,
        genesisId: historyCheckpointEnvelopeId(root.root), localKey, signingKey: keys[j], initialize: root.root }); cleanup.push(service.close);
      if (links) { links.enroll(i, j, root.context, service); continue; }
      const listener = await listenHistoryAgreementReplica({ ...service, checkpoint(value) {
        try { return service.checkpoint(value); }
        catch (error) {
          console.error(`POLICY_HISTORY_FAILURE ${i}/${j} ${error instanceof Error ? error.message.slice(0, 160) : 'Unknown error'}`);
          throw error;
        }
      } }); cleanup.push(listener.close); retained.push(listener);
      members.push({ publicKey: Buffer.from(keys[j].publicKey).toString('base64url'),
        endpoint: await network.protect('policy-history', listener.checkpointEndpoint) });
    }
    historyListeners.push(retained);
    const linked = links && await links.owner(i);
    if (linked) linkedOwners.push(linked);
    const observer = await openProtectedPolicyObserver({ directory: join(directory, `observer-${i}`), context, historyContext: root.context,
      encryptionKey, signingKey, root: root.root, members: linked?.members ?? members, mode: 'create-new',
      // Each fresh read keeps at most four member RPCs live, so two readers
      // fit the persistent router's shared eight-operation budget.
      maximumConcurrentObservations: 2,
      transport: (...args) => network.measure(`observer-history-${args[1].request.action}`, () => (linked?.transport ?? exchangeHistoryCheckpoint)(...args)) }); cleanup.push(observer.close);
    await observer.ready(); const exchange = createAdmissionPolicyObserverExchange(observer, context);
    handlers.push(async value => {
      try { return await exchange(value); }
      catch (error) {
        console.error(`POLICY_OBSERVER_FAILURE ${i} ${error instanceof Error ? error.message.slice(0, 160) : 'Unknown error'}`);
        throw error;
      }
    });
  }
  let queries = 0;
  const responder = createAdmissionPolicyQueryResponder({ context, policy: () => policy }); cleanup.push(responder.close);
  return { context, queries: () => queries,
    query: (value: unknown, signal: AbortSignal) => { queries++; return responder.exchange(value, signal); },
    async loseHistoryQuorums() {
      for (const owner of linkedOwners) { owner.closeReplica(3); owner.closeReplica(4); }
      await Promise.all(historyListeners.flatMap(listeners => listeners.slice(3).map(listener => listener.close())));
    },
  };
}
