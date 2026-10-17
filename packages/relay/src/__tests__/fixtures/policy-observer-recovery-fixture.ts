import { join } from 'node:path';
import { createHistoryGenerationReplica } from '../../history-generation-provisioner.js';
import { listenHistoryAgreementReplica, exchangeHistoryAgreement, exchangeHistoryAgreementData, exchangeHistoryProvision } from '../../history-agreement-exchange.js';
import { exchangeHistoryCheckpoint } from '../../history-checkpoint-exchange.js';
import { policyObserverRestoreFixture } from './policy-observer-restore-fixture.js';

export async function policyObserverRecoveryFixture(register: (close: () => void | Promise<void>) => void) {
  const f = await policyObserverRestoreFixture(register), context = f.enrolled.context;
  const roles = f.stores.map((parent, i) => createHistoryGenerationReplica({ directory: join(f.directory, `slot-${i}`),
    localKey: f.localKeys[i], context, signingKey: f.signingKeys[i], parent, initialize: true }));
  roles.forEach(role => register(role.close));
  const members = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryAgreementReplica(roles[i]); register(listener.close);
    members.push({ publicKey: context.members[i], endpoint: listener.checkpointEndpoint });
  }
  let online = 5, calls = 0;
  function before(member: { publicKey: string }) { calls++; if (context.members.indexOf(member.publicKey) >= online) throw new Error('Volunteer unavailable'); }
  const options = { directory: join(f.directory, 'workflow'), encryptionKey: f.key, signingKey: f.owner,
    context: f.context, historyContext: context, genesis: f.enrolled.root, members, timeoutMs: 10000,
    transport: ((member, frame, signal) => { before(member); return exchangeHistoryCheckpoint(member, frame, signal); }) as typeof exchangeHistoryCheckpoint,
    agreementTransport: ((member, frame, signal) => { before(member); return exchangeHistoryAgreement(member, frame, signal); }) as typeof exchangeHistoryAgreement,
    dataTransport: ((member, frame, signal) => { before(member); return exchangeHistoryAgreementData(member, frame, signal); }) as typeof exchangeHistoryAgreementData,
    provisionTransport: ((member, frame, signal) => { before(member); return exchangeHistoryProvision(member, frame, signal); }) as typeof exchangeHistoryProvision,
  };
  return { ...f, recoveryOptions: options, recoveryMembers: members, calls: () => calls,
    online(value: number) { online = value; f.online(value); } };
}
