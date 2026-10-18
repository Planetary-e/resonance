import { expect, it, vi } from 'vitest';
import { parseRelayHistoryHealth, readRelayHistoryHealth } from '../history-health.js';

it('reports an optional observer without disclosing policy heads, keys or conflict evidence', () => {
  const usage = { pending: false, listening: true, policyCurrent: true, blocked: false, fenced: false,
    retainedBlocks: 2, retainedCiphertextBytes: 800, maximumBlocks: 100, maximumCiphertextBytes: 16000000 };
  const privateUsage = { ...usage, head: { revision: 2, digest: 'private-head' }, evidence: ['private-policy'], key: 'private-key', endpoint: 'private-endpoint' };
  const expected = { owner: null, volunteer: null, transport: null };
  expect(readRelayHistoryHealth({ ownerConfigured: false, observerConfigured: true })).toEqual({ ...expected, observer: { state: 'starting' } });
  expect(readRelayHistoryHealth({ ownerConfigured: false, observerConfigured: true,
    observer: () => { throw new Error('private path'); } })).toEqual({ ...expected, observer: { state: 'unavailable' } });
  const result = readRelayHistoryHealth({ ownerConfigured: false, observerConfigured: true, observer: () => privateUsage });
  expect(result).toEqual({ ...expected, observer: { state: 'available', usage } });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(readRelayHistoryHealth({ ownerConfigured: false, observer: () => privateUsage })).toEqual(expected);
  expect(parseRelayHistoryHealth({ ...expected, observer: null })).toEqual({ ...expected, observer: null });
  for (const [field, value] of [['retainedBlocks', -1], ['retainedCiphertextBytes', Infinity], ['maximumBlocks', 1.5],
    ['maximumCiphertextBytes', '8'], ['pending', null], ['listening', 'true'], ['policyCurrent', undefined], ['blocked', 0], ['fenced', []]]) {
    expect(parseRelayHistoryHealth({ ...expected, observer: { state: 'available', usage: { ...usage, [field as string]: value } } })?.observer)
      .toEqual({ state: 'unavailable' });
  }
});

it('distinguishes unopened, absent and unavailable roles without returning private error details', () => {
  const failed = vi.fn(() => { throw new Error('private owner-key.json and peer activity'); });
  expect(readRelayHistoryHealth({ ownerConfigured: true })).toEqual({ owner: { state: 'starting' }, volunteer: null, transport: null });
  expect(readRelayHistoryHealth({ ownerConfigured: false })).toEqual({ owner: null, volunteer: null, transport: null });
  const health = readRelayHistoryHealth({ ownerConfigured: true, owner: failed, volunteer: failed, transport: failed });
  expect(health).toEqual({ owner: { state: 'unavailable' }, volunteer: { state: 'unavailable' }, transport: { state: 'unavailable' } });
  expect(JSON.stringify(health)).not.toContain('private');
});

it('projects only aggregate fields and treats malformed counters as unavailable instead of zero', () => {
  const usage = { initialized: true, busy: false, pending: true, retainedBlocks: 7, retainedCiphertextBytes: 800,
    maximumBlocks: 100, maximumCiphertextBytes: 16000000 };
  const input = { owner: { state: 'available', usage: { ...usage, rootId: 'private-root', token: 'private-token', peers: ['private-peer'] } },
    volunteer: null, transport: null, signingKey: 'private-key' };
  expect(parseRelayHistoryHealth(input)).toEqual({ owner: { state: 'available', usage }, volunteer: null, transport: null });
  expect(JSON.stringify(parseRelayHistoryHealth(input))).not.toContain('private');
  expect(readRelayHistoryHealth({ ownerConfigured: true, owner: () => input.owner.usage })).toEqual({
    owner: { state: 'available', usage }, volunteer: null, transport: null });
  for (const value of [-1, Infinity, NaN, '8', 1.5, undefined]) {
    expect(parseRelayHistoryHealth({ ...input, owner: { state: 'available', usage: { ...usage, retainedBlocks: value } } })?.owner).toEqual({ state: 'unavailable' });
  }
  expect(parseRelayHistoryHealth({ ...input, owner: { state: 'available', usage: { ...usage, initialized: 'true' } } })?.owner).toEqual({ state: 'unavailable' });
  for (const value of [null, undefined, [], false]) expect(parseRelayHistoryHealth(value)).toBeNull();
});

it('preserves a bounded collection count without exposing per-history identities', () => {
  const usage = { generations: 5, maximumGenerations: 40, retainedBlocks: 6, stagedBlocks: 0, retainedCiphertextBytes: 12000,
    manifestReserveBytes: 20971520, reservedBytes: 20983520, currentGenerationReservedBytes: 20983520, currentGenerationBlocks: 6,
    maximumGenerationBytes: 83886080, maximumGenerationBlocks: 5000, maximumAncestryBytes: 1342177280 };
  const input = { owner: null, volunteer: { state: 'available', usage: { ...usage, histories: 5, contexts: ['private-context'] } }, transport: null };
  expect(parseRelayHistoryHealth(input)?.volunteer).toEqual({ state: 'available', usage: { ...usage, histories: 5 } });
  expect(parseRelayHistoryHealth({ ...input, volunteer: { state: 'available', usage } })?.volunteer).toEqual({ state: 'available', usage });
  for (const histories of [0, 9, 1.5, '5', undefined]) expect(parseRelayHistoryHealth({ ...input,
    volunteer: { state: 'available', usage: { ...usage, histories } } })?.volunteer).toEqual({ state: 'unavailable' });
});
