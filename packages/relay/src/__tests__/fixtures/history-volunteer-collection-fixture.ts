import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateIdentity } from '@resonance/core';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createPolicyObserverHistoryRoot } from '../../protected-policy-observer.js';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';
import { policyObserverFixture } from './policy-observer-fixture.js';

export async function historyVolunteerCollectionFixture(register: (close: () => void | Promise<void>) => void, volunteerCount = 1) {
  const n = await policyObserverFixture({ policyLifetimeMs: 300000 }); register(n.close);
  const roots: Array<Awaited<ReturnType<typeof createPolicyObserverHistoryRoot>> & { encryptionKey: Buffer; signingKey: (typeof n.keys)[number] }> = [];
  for (const signingKey of n.keys) {
    const encryptionKey = randomBytes(32); register(() => { encryptionKey.fill(0); });
    roots.push({ ...await createPolicyObserverHistoryRoot({ context: n.context, policy: n.first, signingKey, encryptionKey }), encryptionKey, signingKey });
  }
  const controller = generateIdentity(); const controllerId = controller.did; controller.secretKey.fill(0);
  const configs = [], paths = [];
  for (let i = 0; i < volunteerCount; i++) {
    const signingKey = n.keys[i], localKey = randomBytes(32);
    const signingKeyFile = `member-${i}.json`, storageKeyFile = `member-${i}.hex`;
    writeFileSync(join(n.directory, signingKeyFile), JSON.stringify({ publicKey: Buffer.from(signingKey.publicKey).toString('base64url'), secretKey: Buffer.from(signingKey.secretKey).toString('base64url') }));
    writeFileSync(join(n.directory, storageKeyFile), localKey.toString('hex'));
    const histories = roots.map((root, j) => {
      const directory = `volunteer-${i}-history-${j}`, genesisId = historyCheckpointEnvelopeId(root.root);
      openHistoryVolunteerService({ directory: join(n.directory, directory), context: root.context, genesisId,
        localKey, signingKey, initialize: root.root }).close();
      return { context: root.context, genesisId, directory, signingKeyFile, storageKeyFile,
        limits: { bytesPerGeneration: 16 * 1024 * 1024, blocksPerGeneration: 1000, generations: 8 } };
    }); localKey.fill(0);
    const config = { version: 1, kind: 'history-volunteer-collection', histories,
      controllers: [{ relayId: controllerId, endpoint: 'wss://controller.example/' }] };
    const path = join(n.directory, `collection-${i}.json`); writeFileSync(path, JSON.stringify(config)); configs.push(config); paths.push(path);
  }
  const request = (index: number, replica = 0) => {
    const h = roots[index], issuedAt = Date.now();
    return createHistoryExchangeRequest({ action: 'head', replica: Buffer.from(n.keys[replica].publicKey).toString('base64url'),
      rootId: historyCheckpointEnvelopeId(h.root), generation: 0, sequence: 0, envelopeId: null,
      issuedAt, expiresAt: issuedAt + 30000, challenge: randomBytes(32).toString('base64url') }, h.context, h.signingKey);
  };
  return { ...n, roots, configs, paths, request };
}
