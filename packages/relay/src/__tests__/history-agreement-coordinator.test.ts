import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHistoryAgreementRequest, parseHistoryAgreementCertificate, parseHistoryAgreementResponse,
  type HistoryAgreementFrame, type HistoryViewReport } from '@resonance/core/history-agreement';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { createHistoryAgreementCoordinator, HISTORY_AGREEMENT_COORDINATOR_FILENAME } from '../history-agreement-coordinator.js';
import { historyAgreementOwnerFixture } from './fixtures/history-agreement-owner-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
function fixture() { const n = historyAgreementOwnerFixture(); clean.push(() => n.close()); return n; }
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); clean.splice(0).reverse().forEach(close => close()); });

describe('durable agreement owner', { timeout: 30_000 }, () => {
it('retries a lost final response from the exact persisted phase, then returns a retained decision without network traffic', async () => {
  const n = fixture(), challenges: string[] = [];
  let lose = true;
  const transport = vi.fn(async (m, f) => {
    const response = await n.options.transport(m, f);
    if (f.request.action === 'confirm') { challenges.push(f.request.challenge); if (lose) throw new Error('lost confirmation'); }
    return response;
  });
  let owner = n.owner(true, { transport });
  expect(transport).not.toHaveBeenCalled();
  await expect(owner.run()).rejects.toThrow('Four');
  const pending = owner.read(); expect(pending.phase).toBe('confirm'); expect(pending.selected).toEqual(n.a);
  const initialChallenge = pending.attempt!.challenge; owner.close();
  const calls = transport.mock.calls.length; owner = n.owner(false, { transport });
  expect(transport).toHaveBeenCalledTimes(calls); expect(owner.read()).toEqual(pending);
  lose = false; const certificate = await owner.run();
  expect(parseHistoryAgreementCertificate(certificate, n.context, 'confirmed')).toEqual(certificate);
  expect(new Set(challenges).size).toBe(2); expect(certificate.votes[0].request.challenge).not.toBe(initialChallenge);
  const completedCalls = transport.mock.calls.length;
  expect(await owner.run()).toEqual(certificate); expect(transport).toHaveBeenCalledTimes(completedCalls);
  expect(() => owner.beginView(2)).toThrow('decided');
  expect(readFileSync(join(n.options.directory, HISTORY_AGREEMENT_COORDINATOR_FILENAME), 'utf8')).not.toContain(n.a.rootId);
});

it('catches up a different fourth volunteer between promise, preparation and confirmation', async () => {
  const n = fixture(), actions = new Map<string, string[]>();
  const owner = n.owner(true, { transport: async (member, frame) => {
    const i = n.context.members.indexOf(member.publicKey), phase = owner.read().phase;
    if ((phase === 'promise' && i === 4) || (phase === 'prepare' && i === 3) || (phase === 'confirm' && i === 2)) throw new Error('offline in this phase');
    actions.set(`${phase}:${i}`, [...(actions.get(`${phase}:${i}`) ?? []), frame.request.action]);
    return n.options.transport(member, frame);
  } });
  const final = await owner.run(); expect(final.votes).toHaveLength(4);
  expect(actions.get('prepare:4')).toEqual(['promise', 'prepare']);
  expect(actions.get('confirm:3')).toEqual(['prepare', 'confirm']);
  expect(final.votes.some(v => v.request.replica === n.context.members[3])).toBe(true);
});

it('requires an explicit higher view to resolve split tentative choices while the fifth member is silent', async () => {
  const n = fixture();
  const fresh = (frames: HistoryAgreementFrame[]) => { const issuedAt = Date.now(); return frames.map(f => ({ ...f,
    request: createHistoryAgreementRequest({ ...f.request, issuedAt, expiresAt: issuedAt + 30_000 }, n.context, n.options.signingKey) })); };
  const promise = fresh(n.frames('promise', 1)), reports = n.viewCertificate(promise.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  const a = fresh(n.frames('prepare', 1, n.a, reports)), b = fresh(n.frames('prepare', 1, n.b, reports));
  [0, 1, 2, 3].forEach(i => n.roles[i].exchange(i < 2 ? a[i] : b[i]));
  let calls = 0;
  const owner = n.owner(true, { transport: async (m, f) => { calls++; if (m.publicKey === n.context.members[4]) throw new Error('silent fifth'); return n.options.transport(m, f); } });
  await expect(owner.run()).rejects.toThrow('Four'); expect(owner.read().view).toBe(1); expect(owner.read().phase).toBe('prepare');
  const before = calls; owner.beginView(2); expect(calls).toBe(before);
  expect(() => owner.beginView(2)).toThrow('regress');
  const final = await owner.run(); expect(final.votes.every(v => v.request.view === 2 && v.request.proposalId === historySuccessorProposalId(n.a))).toBe(true);
});

it('carries a hidden final decision into a later coordinator even when its preferred proposal differs', async () => {
  const n = fixture(), old = n.owner(true, { transport: async (m, f) => {
    const response = await n.options.transport(m, f);
    if (f.request.action === 'confirm') throw new Error('reply lost'); return response;
  } });
  await expect(old.run()).rejects.toThrow('Four'); old.beginView(2);
  expect(old.read().previous?.proposal).toEqual(n.a); old.close();
  const newer = n.owner(true, { directory: join(n.directory, 'other-owner'), initialize: { proposal: n.b, view: 2 } });
  const final = await newer.run(); expect(newer.read().selected).toEqual(n.a);
  expect(final.votes.every(v => v.request.proposalId === historySuccessorProposalId(n.a))).toBe(true);
}, 90_000); // Two separate 30-second operations plus real-crypto setup and reopening.

it('rejects cached replies to fresh attempts and refuses phase, target and signature substitutions', async () => {
  const n = fixture(), cached = new Map<string, unknown>(); let replay = false;
  const owner = n.owner(true, { transport: async (m, f) => {
    if (replay) return cached.get(m.publicKey);
    const response = await n.options.transport(m, f); cached.set(m.publicKey, response); throw new Error('lost report');
  } });
  await expect(owner.run()).rejects.toThrow('Four'); const challenge = owner.read().attempt!.challenge;
  replay = true; await expect(owner.run()).rejects.toThrow('Four');
  expect(owner.read().phase).toBe('promise'); expect(owner.read().attempt!.challenge).not.toBe(challenge);
  const first = cached.get(n.context.members[0]) as HistoryViewReport;
  for (const bad of [cached.get(n.context.members[1]), { ...first, signature: randomBytes(64).toString('base64url') },
    { ...first, kind: 'history-agreement-vote', phase: 'prepared' }]) {
    expect(() => parseHistoryAgreementResponse(bad, first.request, n.context)).toThrow();
  }
});

it.each(['promise', 'prepare', 'confirm'] as const)('keeps %s pending after its local proof flush fails, then resumes without erasing remote votes', async phase => {
  const n = fixture(); let responses = 0;
  const transport = async (m: { publicKey: string }, f: HistoryAgreementFrame) => {
    if (m.publicKey === n.context.members[4]) throw new Error('offline');
    const response = await n.options.transport(m, f);
    if (f.request.action === phase && ++responses === 4) vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('owner proof flush'); });
    return response;
  };
  let owner = n.owner(true, { transport }); await expect(owner.run()).rejects.toThrow('owner proof flush');
  expect(() => owner.read()).toThrow('write failed'); owner.close();
  owner = n.owner(false); expect(owner.read().phase).toBe(phase); expect(owner.read().attempt).not.toBeNull();
  expect((await owner.run()).votes).toHaveLength(4);
});

it('sends nothing after failed intent persistence and refuses a competing run or view change while active', async () => {
  const n = fixture(), transport = vi.fn(n.options.transport); let owner = n.owner(true, { transport });
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('intent flush'); });
  await expect(owner.run()).rejects.toThrow('intent flush'); expect(transport).not.toHaveBeenCalled(); owner.close();
  owner = n.owner(false, { transport: () => new Promise(() => {}), timeoutMs: 1000 });
  const attempt = expect(owner.run()).rejects.toThrow('cancelled');
  await expect(owner.run()).rejects.toThrow('active'); expect(() => owner.beginView(2)).toThrow('active');
  owner.close(); await attempt;
});

it('bounds silent transports, cancels all pending work, and ignores replies arriving after timeout', async () => {
  const n = fixture(), late: Array<() => void> = [], signals: AbortSignal[] = [];
  // Equal scheduled deadlines force the whole-run timer to win. This previously
  // surfaced cancellation instead of timeout depending on scheduler rounding.
  const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const owner = n.owner(true, { timeoutMs: 1000, transport: (m, f, signal) => {
      signals.push(signal); const response = n.roles[n.context.members.indexOf(m.publicKey)].exchange(f);
      return new Promise(resolve => late.push(() => resolve(response)));
    } });
    const pending = expect(owner.run()).rejects.toThrow('deadline');
    await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(signals).toHaveLength(5); expect(signals.every(s => s.aborted)).toBe(true);
    const saved = owner.read(); late.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve));
    expect(owner.read()).toEqual(saved); expect(saved.phase).toBe('promise');
    const cancel = new AbortController(); cancel.abort(); await expect(owner.run(cancel.signal)).rejects.toThrow('cancelled');
    expect(owner.read()).toEqual(saved);
  } finally { vi.useRealTimers(); wall.mockRestore(); monotonic.mockRestore(); }
});

it('retains a decision but suppresses success when the final flush crosses the operation deadline', async () => {
  const n = fixture(); let confirmations = 0;
  const clock = vi.spyOn(Date, 'now');
  try {
    const owner = n.owner(true, { transport: async (m, f) => {
      if (m.publicKey === n.context.members[4]) throw new Error('offline');
      const response = await n.options.transport(m, f);
      if (f.request.action === 'confirm' && ++confirmations === 4) {
        vi.mocked(fsyncSync).mockImplementationOnce(fd => { actualFsync(fd); clock.mockReturnValue(f.request.expiresAt); });
      }
      return response;
    } });
    await expect(owner.run()).rejects.toThrow('timed out'); clock.mockRestore();
    expect(owner.read().phase).toBe('decided'); const before = confirmations;
    expect((await owner.run()).votes).toHaveLength(4); expect(confirmations).toBe(before);
  } finally { clock.mockRestore(); }
});

it('fails closed on lost or altered owner state and checks independent view anchors', async () => {
  const n = fixture(); expect(() => n.owner(false)).toThrow('missing');
  let owner = n.owner(); const path = join(n.options.directory, HISTORY_AGREEMENT_COORDINATOR_FILENAME), initial = readFileSync(path);
  expect(() => n.owner()).toThrow(); owner.beginView(2); owner.close(); writeFileSync(path, initial);
  expect(() => n.owner(false, { minimumView: 2 })).toThrow('anchor');
  owner = n.owner(false); await owner.run(); const state = owner.read(); owner.close();
  const corrupt = openEncryptedLocalState<any>({ path, key: n.localKey, domain: 'resonance:history-agreement-owner:v2',
    maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: null, validate: (v): v is any => !!v });
  corrupt.write({ ...state, selected: n.b }); corrupt.close();
  expect(() => createHistoryAgreementCoordinator(n.options)).toThrow('state is invalid');
});
});
