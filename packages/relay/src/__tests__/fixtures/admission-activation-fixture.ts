import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openProtectedAdmissionSpendHistory } from '../../protected-admission-history.js';
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica, exchangeHistoryCheckpoint, type HistoryCheckpointTransport } from '../../history-checkpoint-exchange.js';
import { createConfiguredAdmissionVerifier } from '../../configured-admission-verifier.js';
import { historyCheckpointFixture } from './history-checkpoint-fixture.js';
import { witnessFixture } from './admission-witness-fixture.js';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';
import { listenHistoryAgreementReplica } from '../../history-agreement-exchange.js';

export async function admissionActivationFixture(options: { recovery?: boolean } = {}) {
  const h = historyCheckpointFixture(), issuer = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'owner-activation-'));
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(directory, { recursive: true, force: true })];
  const close = async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); };
  try {
    const policy = await signAdmissionPolicy({ ...issuer.body, keys: issuer.body.keys.map(({ witnesses, ...entry }) => entry) }, issuer.authority, issuer.authorityKey.secretKey);
    const context = { ...h.context, authority: issuer.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
    const historyDirectory = join(directory, 'prepared-owner'), desktopDirectory = join(directory, 'desktop'), runtimeDirectory = join(desktopDirectory, 'relay-data');
    mkdirSync(runtimeDirectory, { recursive: true });
    const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${i + 1}/history-checkpoint` }));
    // A four-copy operation may finish before the fifth server handles its frame.
    // Exclude precisely those setup requests from later offline-operation checks,
    // including delayed delivery, while keeping the real socket transport.
    let preparing = true, exchanges = 0;
    const preparationRequests = new Set<string>();
    const recordExchange = (value: unknown) => {
      const request = (value as { request?: unknown }).request;
      if (!preparationRequests.has(JSON.stringify(request))) exchanges++;
    };
    const transport: HistoryCheckpointTransport = (member, frame, signal) => {
      if (preparing) preparationRequests.add(JSON.stringify(frame.request));
      return exchangeHistoryCheckpoint(member, frame, signal);
    };
    const protection = { context, members, signingKey: h.owner, timeoutMs: 1500, transport };
    let history = await openProtectedAdmissionSpendHistory({ directory: historyDirectory, authority: issuer.authority, policy, encryptionKey: h.key,
      initialize: true, protection: { ...protection, initializeWriter: true } });
    cleanup.push(() => history.close()); const genesis = history.enrollment().root; history.close();
    const listeners: Array<{ endpoint: string; close: () => Promise<void> }> = [];
    const roles: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
    const services: ReturnType<typeof openHistoryVolunteerService>[] = [];
    for (let i = 0; i < 5; i++) {
      if (options.recovery) {
        const service = openHistoryVolunteerService({ directory: join(directory, `member-${i}`), context, localKey: h.localKey,
          signingKey: h.memberKeys[i], genesisId: historyCheckpointEnvelopeId(genesis), initialize: genesis });
        services.push(service); cleanup.push(() => service.close());
        const listener = await listenHistoryAgreementReplica({ ...service,
          checkpoint: value => { recordExchange(value); return service.checkpoint(value); },
          exchange: value => { recordExchange(value); return service.exchange(value); },
          transfer: value => { recordExchange(value); return service.transfer(value); },
          provision: value => { recordExchange(value); return service.provision(value); } }, { port: 0 });
        listeners.push({ endpoint: listener.checkpointEndpoint, close: listener.close }); cleanup.push(listener.close);
        members[i].endpoint = listener.checkpointEndpoint; continue;
      }
      const store = openHistoryCheckpointStore({ directory: join(directory, `member-${i}`), context, replica: context.members[i],
        localKey: h.localKey, rootId: historyCheckpointEnvelopeId(genesis), generation: 0, initialize: genesis });
      cleanup.push(() => store.close());
      const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); cleanup.push(() => role.close()); roles.push(role);
      const endpoint = await listenHistoryCheckpointReplica({ ...role, exchange: value => { recordExchange(value); return role.exchange(value); } }, { port: 0 });
      listeners.push(endpoint); cleanup.push(endpoint.close); members[i].endpoint = endpoint.endpoint;
    }
    history = await openProtectedAdmissionSpendHistory({ directory: historyDirectory, authority: issuer.authority, policy, encryptionKey: h.key, protection });
    await history.ready(); history.close();
    const verifierOptions = { directory: historyDirectory, authority: issuer.authority, policy, encryptionKey: h.key, historyProtection: protection, initializeSpendHistory: false };
    const verifier = await createConfiguredAdmissionVerifier({ ...verifierOptions, initialize: true });
    const binding = createAdmissionRequestBindingV2('search', { query: 'retained activation token' });
    const token = await issuer.token(), capability = presentBlindAdmissionTokenV2(token, issuer.scope, 'search', binding);
    const request = { action: 'search' as const, requestBinding: binding, now: Date.now() };
    try { if ((await verifier.verifyAndSpend(capability, request)).status !== 'accepted') throw new Error('Fixture token was not accepted'); }
    finally { verifier.close(); }
    const json = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; };
    const keyPath = json('owner-key.json', { publicKey: context.owner, secretKey: Buffer.from(h.owner.secretKey).toString('base64url') });
    const input = { historyConfigFile: json('history.json', { version: 1, context, members, ownerKeyFile: keyPath }),
      enrollmentFile: json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context, root: genesis }),
      policyFile: json('policy.json', policy), authorityFile: join(directory, 'authority.pub'), storageKeyFile: join(directory, 'storage.hex'),
      historyDirectory, linksFile: '', operatorTransportFile: '' };
    writeFileSync(input.authorityFile, issuer.authority); writeFileSync(input.storageKeyFile, h.key.toString('hex'), { mode: 0o600 });
    preparing = false;
    return { ...h, context, issuer, directory, desktopDirectory, runtimeDirectory, historyDirectory, policy, genesis, protection, input,
      capability, token, binding, request, verifierOptions, listeners, roles, services, exchanges: () => exchanges, close,
      activationOptions: { runtimeDirectory, historyDirectory, policy, encryptionKey: h.key, protection, genesis } };
  } catch (error) { await close(); throw error; }
}
