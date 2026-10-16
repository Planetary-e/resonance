import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { createHistoryGenerationReplica } from '../history-generation-provisioner.js';
import { exchangeHistoryAgreementData, listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { historyAgreementOwnerFixture } from './fixtures/history-agreement-owner-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(tail: Parameters<typeof historyAgreementOwnerFixture>[0] = 'none', length = 1) {
  const n = historyAgreementOwnerFixture(tail, length); cleanup.push(() => n.close()); return n;
}

it('persists only the four-report selection, survives reopen and returns isolated historical evidence without new traffic', async () => {
  const n = fixture(), actions: string[] = [];
  const transport = async (...args: Parameters<typeof n.options.transport>) => {
    actions.push((args[1] as any).request.action); return n.options.transport(...args);
  };
  let owner = n.owner(true, { transport }); const selected = await owner.select();
  expect(actions.every(a => a === 'promise')).toBe(true); expect(owner.read().phase).toBe('prepare');
  expect(owner.read().preparedCertificate).toBeNull(); expect(selected.proposal).toEqual(n.a);
  selected.proposal.signature = 'mutated caller result'; expect(owner.read().selected).toEqual(n.a);
  const calls = actions.length; owner.close(); owner = n.owner(false, { transport });
  expect((await owner.select()).proposal).toEqual(n.a); expect(actions).toHaveLength(calls);
  const cert = await owner.run(); expect(cert.phase).toBe('confirmed');
  expect((await owner.select()).proposal).toEqual(n.a);
});

it('selects the carried hidden decision before a cache can be chosen from a different preferred proposal', async () => {
  const n = fixture(), old = n.owner(true, { transport: async (member, frame) => {
    const response = await n.options.transport(member, frame);
    if (frame.request.action === 'confirm') throw new Error('lost decision'); return response;
  } });
  await expect(old.run()).rejects.toThrow('Four'); old.close();
  const actions: string[] = [];
  const newer = n.owner(true, { directory: join(n.directory, 'new-owner'), initialize: { proposal: n.b, view: 2 },
    transport: async (member, frame) => { actions.push(frame.request.action); return n.options.transport(member, frame); } });
  const selected = await newer.select(); expect(selected.proposal).toEqual(n.a);
  expect(newer.read().preferred).toEqual(n.b); expect(actions.every(a => a === 'promise')).toBe(true);
  expect(selected.viewCertificate.reports.some(r => r.prepared?.proposal.signature === n.a.signature)).toBe(true);
}, 60_000);

it.each(['gap', 'longer', 'corrupt'] as const)('refuses %s retained data before requesting any prepare vote', async kind => {
  const n = fixture(), actions: string[] = [];
  const blocks = kind === 'gap' ? [n.next(n.root)] : kind === 'longer' ? [n.root, n.next(n.root)] : [{ ...n.root, signature: 'invalid' }];
  const owner = n.owner(true, { historyTransfer: { retained: () => blocks }, transport: async (member, frame) => {
    actions.push(frame.request.action); return n.options.transport(member, frame);
  } });
  await owner.select(); actions.length = 0;
  await expect(owner.run()).rejects.toThrow(); expect(actions).toEqual([]); expect(owner.read().phase).toBe('prepare');
  expect(n.stores.every(s => !s.agreementState()?.prepared)).toBe(true);
});

it('stops a retained iterator from sending after the owner closes during cache traversal', async () => {
  const n = fixture(); let calls = 0;
  const owner = n.owner(true, { historyTransfer: { retained: function* () { owner.close(); yield n.root; } },
    transport: async (member, frame) => { calls++; return n.options.transport(member, frame); } });
  await owner.select(); const before = calls;
  await expect(owner.run()).rejects.toThrow('cancelled'); expect(calls).toBe(before);
});

it('cannot use retained ciphertext to bypass a newer promised view while a download was pending', async () => {
  const n = fixture();
  const transfer = { retained: () => [n.root], transport: async (member: { publicKey: string }, frame: unknown) =>
    n.roles[n.context.members.indexOf(member.publicKey)].transfer(frame) };
  const owner = n.owner(true, { historyTransfer: transfer });
  await owner.select();
  const newer = n.owner(true, { directory: join(n.directory, 'newer-owner'), initialize: { proposal: n.a, view: 2 } });
  await newer.select();
  await expect(owner.run()).rejects.toThrow('Four');
  expect(owner.read().view).toBe(1); expect(owner.read().phase).toBe('prepare');
  expect(n.stores.every(s => !s.agreementState()?.prepared)).toBe(true);
  owner.beginView(3); await owner.select();
  const certificate = await owner.run();
  expect(certificate.votes.every(v => v.request.view === 3)).toBe(true); expect(certificate.phase).toBe('confirmed');
  expect(n.stores.every(s => s.read().envelopes.length === 1)).toBe(true);
});

it('resumes selected ciphertext on disk, then repairs a different fourth volunteer and confirms through real sockets', async () => {
  const n = fixture('missing', 3), actions: string[] = [], dataActions: string[] = [];
  const listeners: Awaited<ReturnType<typeof listenHistoryAgreementReplica>>[] = [];
  for (let i = 0; i < 5; i++) {
    const role = createHistoryGenerationReplica({ directory: join(n.directory, `slot-${i}`), localKey: n.localKey, context: n.context,
      signingKey: n.memberKeys[i], parent: n.stores[i], initialize: true }); cleanup.push(() => role.close());
    const listener = await listenHistoryAgreementReplica({ ...role, exchange(frame) {
      actions.push((frame as any).request.action); return role.exchange(frame);
    } }); cleanup.push(() => listener.close()); listeners.push(listener);
  }
  await listeners[3].close(); // The remaining fourth replica has only the root.
  let cache: ReturnType<typeof createHistoryAncestryDownload> | undefined;
  const changes: Partial<Parameters<typeof createHistoryAgreementCoordinator>[0]> = {
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].endpoint })), transport: undefined,
    historyTransfer: { retained: () => { if (!cache) throw new Error('No retained cache'); return cache.blocks(); }, transport: async (...args) => {
      dataActions.push(args[1].action); if (args[1].action === 'read') throw new Error('Already retained selected data must not be downloaded again');
      return exchangeHistoryAgreementData(...args);
    } },
  };
  let owner = n.owner(true, changes); const selected = await owner.select();
  const cacheOptions = { directory: join(n.directory, 'selected-download'), localKey: n.localKey, context: n.context,
    signingKey: n.options.signingKey, proposal: selected.proposal,
    members: n.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].checkpointEndpoint })) };
  cache = createHistoryAncestryDownload({ ...cacheOptions, initialize: true }); cleanup.push(() => cache?.close());
  await cache.run({ maxBlocks: 1 });
  const before = actions.length; await expect(owner.run()).rejects.toThrow('incomplete');
  expect(actions).toHaveLength(before); expect(dataActions).toEqual([]); expect(n.stores[4].describe().sequence).toBe(0);
  owner.close(); cache.close();
  owner = n.owner(false, changes); cache = createHistoryAncestryDownload(cacheOptions); cleanup.push(() => cache?.close());
  expect(cache.read().blocks).toBe(1); expect((await owner.select()).proposal).toEqual(selected.proposal); expect(actions).toHaveLength(before);
  expect((await cache.run()).complete).toBe(true);
  const certificate = await owner.run(); expect(certificate.votes).toHaveLength(4);
  expect(certificate.votes.some(v => v.request.replica === n.context.members[4])).toBe(true);
  expect(certificate.votes.every(v => v.request.proposalId === historySuccessorProposalId(selected.proposal))).toBe(true);
  expect(n.stores[4].read().envelopes).toEqual(n.blocks);
  expect(dataActions).toContain('stage'); expect(dataActions).not.toContain('read');
  expect(certificate.votes[0].request.challenge).not.toBe(selected.viewCertificate.reports[0].request.challenge);
}, 60_000);
