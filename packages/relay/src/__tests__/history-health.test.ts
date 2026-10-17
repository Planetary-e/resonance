import { expect, it, vi } from 'vitest';
import { parseRelayHistoryHealth, readRelayHistoryHealth } from '../history-health.js';

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
