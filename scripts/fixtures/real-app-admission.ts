/** Real local witness relays and protected role/spend histories for the app exercise. */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateSigningKeyPair, type SigningKeyPair } from '@resonance/core';
import { admissionPolicyDigest, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import type { AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointEnvelopeId, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { createRelayServer } from '../../packages/relay/src/server.js';
import { createConfiguredAdmissionVerifier } from '../../packages/relay/src/configured-admission-verifier.js';
import { createAdmissionWitness, createAdmissionQuorumGate } from '../../packages/relay/src/admission-witness.js';
import { openProtectedAdmissionSpendHistory } from '../../packages/relay/src/protected-admission-history.js';
import { openAdmissionRoleCapture } from '../../packages/relay/src/admission-role-capture.js';
import { openHistoryVolunteerService } from '../../packages/relay/src/history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../../packages/relay/src/history-agreement-exchange.js';

type Verifier = Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>;
type VerifierOptions = Parameters<typeof createConfiguredAdmissionVerifier>[0];
type Listener = Awaited<ReturnType<typeof listenHistoryAgreementReplica>>;

export async function prepareRealAppAdmission(directory: string, cleanup: Array<() => void | Promise<void>>) {
  mkdirSync(directory);
  const witnesses = Array.from({ length: 5 }, generateSigningKeyPair), coordinator = generateSigningKeyPair();
  const historyKeys = Array.from({ length: 5 }, generateSigningKeyPair).sort((a, b) => {
    const x = Buffer.from(a.publicKey).toString('base64url'), y = Buffer.from(b.publicKey).toString('base64url');
    return x < y ? -1 : x > y ? 1 : 0;
  });
  cleanup.push(() => [...witnesses, coordinator, ...historyKeys].forEach(key => key.secretKey.fill(0)));
  const verifiers: Verifier[] = [], options: VerifierOptions[] = [], listeners: Listener[][] = [], endpoints: string[] = [];
  for (let i = 0; i < 5; i++) {
    const server = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(directory, `witness-server-${i}`),
      admissionWitness: { vote: (request, acceptNew) => {
        const role = verifiers[i]?.witness; if (!role) throw new Error('Witness is not ready'); return role.vote(request, acceptNew);
      }, close() {} } });
    await server.start(); cleanup.push(() => server.stop()); endpoints.push(`ws://127.0.0.1:${server.getListeningPort()!}/`);
  }
  const witnessSet = { version: 1 as const, quorum: 4 as const,
    members: witnesses.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: endpoints[i] })),
    coordinators: [Buffer.from(coordinator.publicKey).toString('base64url')] };
  return { witnessSet,
    async activate(policy: SignedAdmissionPolicy, observers: AdmissionPolicyObservers) {
      async function owner(index: number, role: 'witness' | 'coordinator', roleKey: SigningKeyPair) {
        const encryptionKey = randomBytes(32), signingKey = generateSigningKeyPair(), ownerDirectory = join(directory, `owner-${index}`);
        cleanup.push(() => { encryptionKey.fill(0); signingKey.secretKey.fill(0); });
        const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends', historyId: randomBytes(32).toString('base64url'),
          owner: Buffer.from(signingKey.publicKey).toString('base64url'), authority: policy.authority,
          policyDigest: `sha256:${admissionPolicyDigest(policy)}`, quorum: 4,
          members: historyKeys.map(key => Buffer.from(key.publicKey).toString('base64url')) };
        const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${i + 1}/history-checkpoint` }));
        const historyOptions = { directory: ownerDirectory, encryptionKey, authority: policy.authority, policy,
          protection: { context, signingKey, members } };
        let history = await openProtectedAdmissionSpendHistory({ ...historyOptions, initialize: true,
          protection: { ...historyOptions.protection, initializeWriter: true } });
        cleanup.push(() => history.close()); const root = history.enrollment().root, retained: Listener[] = [];
        for (let j = 0; j < 5; j++) {
          const localKey = randomBytes(32); cleanup.push(() => { localKey.fill(0); });
          const service = openHistoryVolunteerService({ directory: join(directory, `owner-${index}-replica-${j}`), context,
            genesisId: historyCheckpointEnvelopeId(root), localKey, signingKey: historyKeys[j], initialize: root }); cleanup.push(service.close);
          const listener = await listenHistoryAgreementReplica(service); cleanup.push(listener.close); retained.push(listener);
          members[j].endpoint = listener.checkpointEndpoint;
        }
        listeners.push(retained);
        history.close(); history = await openProtectedAdmissionSpendHistory(historyOptions); await history.ready();
        const localOptions = { directory: ownerDirectory, encryptionKey, policy, signingKey: roleKey, initialize: true };
        const local = role === 'witness' ? createAdmissionWitness(localOptions) : createAdmissionQuorumGate(localOptions);
        local.close();
        const capture = await openAdmissionRoleCapture({ directory: ownerDirectory, encryptionKey, roles: [role], history });
        try { await capture.apply((await capture.review()).approvalDigest); } finally { capture.close(); }
        history.close();
        const configured: VerifierOptions = { directory: ownerDirectory, encryptionKey, authority: policy.authority, policy,
          policyObservers: observers, historyProtection: historyOptions.protection, initialize: true, initializeSpendHistory: false,
          ...(role === 'witness' ? { witnessKey: roleKey } : { coordinatorKey: roleKey }) };
        options.push(configured); verifiers.push(await createConfiguredAdmissionVerifier(configured));
        cleanup.push(async () => { verifiers[index].close(); await verifiers[index].drainPolicyObservations(); });
      }
      for (let i = 0; i < 5; i++) await owner(i, 'witness', witnesses[i]);
      await owner(5, 'coordinator', coordinator);
      return {
        get verifier() { return verifiers[5]; },
        async restart() {
          for (let i = 0; i < verifiers.length; i++) {
            verifiers[i].close(); await verifiers[i].drainPolicyObservations();
            verifiers[i] = await createConfiguredAdmissionVerifier({ ...options[i], initialize: false });
          }
        },
        async loseWitnessQuorum() {
          // Each of two witnesses loses two history copies: only three witnesses
          // can produce a durably retained new vote. Policy observers remain up.
          await Promise.all(listeners.slice(3, 5).flatMap(group => group.slice(3).map(listener => listener.close())));
        },
      };
    },
  };
}
