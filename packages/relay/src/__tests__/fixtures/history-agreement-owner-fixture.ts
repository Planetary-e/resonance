import { join } from 'node:path';
import { createHistoryAgreementReplica } from '../../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../../history-agreement-coordinator.js';
import { listenHistoryAgreementReplica } from '../../history-agreement-exchange.js';
import { historyAgreementFixture } from './history-agreement-fixture.js';

export function historyAgreementOwnerFixture(tail: Parameters<typeof historyAgreementFixture>[0] = 'none', length = 1) {
  const n = historyAgreementFixture(tail, length);
  const roles = n.roles;
  function realClock(i: number) {
    roles[i].close(); roles[i] = createHistoryAgreementReplica({ context: n.context, store: n.stores[i], signingKey: n.memberKeys[i] });
  }
  roles.forEach((_, i) => realClock(i));
  const options = { directory: join(n.directory, 'owner'), context: n.context, localKey: n.localKey, signingKey: n.owner,
    rootId: n.options.rootId, generation: 0, nextGeneration: 1,
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${24000 + i}/history-agreement` })),
    transport: async (member: { publicKey: string }, frame: unknown) => roles[n.context.members.indexOf(member.publicKey)].exchange(frame) };
  const owners: ReturnType<typeof createHistoryAgreementCoordinator>[] = [];
  function owner(initialize = true, changes: Partial<Parameters<typeof createHistoryAgreementCoordinator>[0]> = {}) {
    const c = createHistoryAgreementCoordinator({ ...options, ...(initialize ? { initialize: { proposal: n.a } } : {}), ...changes });
    owners.push(c); return c;
  }
  return { ...n, options, owner, realClock, close() { owners.forEach(o => o.close()); n.close(); } };
}

export async function historyAgreementNetworkFixture(tail: Parameters<typeof historyAgreementFixture>[0] = 'none', length = 1) {
  const n = historyAgreementOwnerFixture(tail, length), listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
  let exchanges = 0;
  async function start(i: number) {
    const listener = await listenHistoryAgreementReplica({ ...n.roles[i], exchange(frame) { exchanges++; return n.roles[i].exchange(frame); }, transfer(frame) { exchanges++; return n.roles[i].transfer(frame); } },
      { port: listeners[i] ? Number(new URL(listeners[i].endpoint).port) : 0, connectionTimeoutMs: 30000 });
    listeners[i] = listener; n.options.members[i].endpoint = listener.endpoint;
  }
  for (let i = 0; i < 5; i++) await start(i);
  // Undefined selects the actual network transport when the coordinator is constructed.
  const options = { ...n.options, transport: undefined };
  return { ...n, options, listeners, exchanges: () => exchanges,
    owner: (initialize = true, changes: Partial<Parameters<typeof createHistoryAgreementCoordinator>[0]> = {}) => n.owner(initialize, { ...options, ...changes }),
    async stop(i: number) { await listeners[i].close(); n.roles[i].close(); n.stores[i].close(); },
    async restart(i: number) { n.reopen(i); n.realClock(i); await start(i); },
    async close() { for (const listener of listeners) await listener.close(); n.close(); } };
}
