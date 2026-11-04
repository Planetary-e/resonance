import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import type { AdmissionIssuanceAllocationBody } from '@resonance/core/admission-issuance-allocation';
import { historyCheckpointFixture } from '../../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { listenHistoryAgreementReplica } from '../../../../relay/src/history-agreement-exchange.js';
import { openHistoryVolunteerService } from '../../../../relay/src/history-volunteer-service.js';
import { allocationAuthorityHistoryAnchor } from '../../admission-allocation-authority-state.js';
import { openProtectedAdmissionAllocationAuthority } from '../../protected-admission-allocation-authority.js';

/** Five actual volunteer services; the history owner and allocation signer are distinct keys. */
export async function protectedAllocationAuthorityFixture(register: (close: () => void | Promise<void>) => void, settings: { writerSibling?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'protected-allocation-')));
  register(() => rmSync(directory, { recursive: true, force: true }));
  const h = historyCheckpointFixture(), authorityKey = generateSigningKeyPair();
  register(() => { h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); authorityKey.secretKey.fill(0); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const context = { ...h.context, role: 'admission-allocation-authority' as const, authority, policyDigest: allocationAuthorityHistoryAnchor(authority) };
  const services: ReturnType<typeof openHistoryVolunteerService>[] = [], members: Array<{ publicKey: string; endpoint: string }> = [];
  let online = 5, now = 150;
  const service = (i: number) => { if (i >= online || !services[i]) throw new Error('Volunteer unavailable'); return services[i]; };
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryAgreementReplica({ checkpoint: raw => service(i).checkpoint(raw), exchange: raw => service(i).exchange(raw),
      transfer: raw => service(i).transfer(raw), provision: raw => service(i).provision(raw) }, { maxConnections: 8 }); register(listener.close);
    members.push({ publicKey: context.members[i], endpoint: listener.checkpointEndpoint });
  }
  const options: Parameters<typeof openProtectedAdmissionAllocationAuthority>[0] = {
    path: join(directory, 'owner', 'authority.json'), authority, secretKey: authorityKey.secretKey, mode: 'open-existing', now: () => now,
    protection: { context, signingKey: h.owner, members, writerDirectory: join(directory, 'owner', settings.writerSibling ? 'authority.json.history' : 'writer'), timeoutMs: 10000 },
  };
  let journal = await openProtectedAdmissionAllocationAuthority({ ...options, mode: 'create-new' }); register(() => journal.close());
  const genesis = journal.enrollment().root;
  if (genesis.kind !== 'checkpoint') throw new Error('Fixture requires original authority genesis');
  const genesisId = historyCheckpointEnvelopeId(genesis);
  for (let i = 0; i < 5; i++) {
    const volunteer = openHistoryVolunteerService({ directory: join(directory, `volunteer-${i}`), context, genesisId,
      localKey: randomBytes(32), signingKey: h.memberKeys[i], initialize: genesis }); services.push(volunteer); register(volunteer.close);
  }
  const rsa = Array.from({ length: 2 }, () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString());
  function plan(epoch = 'period-one'): AdmissionIssuanceAllocationBody {
    return { version: 2, kind: 'admission-issuance-allocation', claimPolicy: 'authority-assigned-v1', community: 'public', epoch,
      notBefore: 100, issueUntil: 200, totalTokenBudget: 4, allocations: rsa.map((issuerPublicKey, i) => ({ batchSize: 1, maxPermits: i === 0 ? 3 : 1,
        profile: { version: 1, scope: { issuer: `issuer-${i}`, community: 'public', epoch }, issuerPublicKey, relayUrls: ['ws://127.0.0.1:44010/'] } })) };
  }
  const request = (claimHandle = randomBytes(32).toString('base64url'), issuer = 0, epoch = 'period-one') => ({ community: 'public' as const,
    epoch, claimHandle, issuerKeyFingerprint: admissionKeyFingerprint(rsa[issuer]) });
  return { directory, authority, authorityKey, context, genesis, members, services, options, plan, request,
    get journal() { return journal; }, online(count: number) { online = count; }, clock(value: number) { now = value; },
    async reopen() { journal.close(); journal = await openProtectedAdmissionAllocationAuthority(options); return journal; } };
}
