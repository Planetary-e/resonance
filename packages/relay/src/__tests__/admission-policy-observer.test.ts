import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fsyncSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '@resonance/core';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadCertificate, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, createAdmissionPolicyAdvance, parseAdmissionPolicyAdvance, parseAdmissionPolicyAdvanceCommitment } from '@resonance/core/admission-policy-advance';
import { openAdmissionPolicyObserver } from '../admission-policy-observer.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => void> = [];
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() { const n = await policyObserverFixture(); cleanup.push(n.close); return n; }
async function open(n: Awaited<ReturnType<typeof fixture>>, mode: 'create-new' | 'open-existing' = 'create-new') {
  const observer = await openAdmissionPolicyObserver({ ...n.options, mode }); cleanup.push(observer.close); return observer;
}

it('installs immediate authenticated heads durably and keeps exact retries/read observations stable after restart', async () => {
  const n = await fixture(); let observer = await open(n);
  const request = createAdmissionPolicyHeadRequest(n.context, n.now);
  expect(parseAdmissionPolicyHeadVote(observer.observe(request), request, n.context, n.now).head).toEqual(n.context.genesis);
  expect(await observer.advance(n.advance)).toEqual(n.advance.commitment.next);
  const bytes = fs.readFileSync(n.options.path); observer.close(); observer = await open(n, 'open-existing');
  await observer.advance(n.advance); expect(fs.readFileSync(n.options.path)).toEqual(bytes);
  expect(observer.status()).toMatchObject({ head: n.advance.commitment.next, blocked: false, evidence: [] });
  expect(observer.policy()).toEqual(n.second); expect(observer.policy()).not.toBe(n.second);
  expect(observer.observe(request).head).toEqual(n.advance.commitment.next);
  expect(bytes.toString()).not.toContain(n.authority);
  await observer.advance(n.later); expect(observer.observe(request).head.revision).toBe(3);
});

it('blocks observations permanently on authenticated same-revision equivocation and retains both authority commitments', async () => {
  const n = await fixture(); let observer = await open(n); await observer.advance(n.advance);
  await expect(observer.advance(n.conflict)).rejects.toThrow('equivocated');
  const evidence = observer.status().evidence; expect(evidence).toHaveLength(2);
  evidence.forEach(commitment => expect(parseAdmissionPolicyAdvanceCommitment(commitment, n.context)).toEqual(commitment));
  expect(evidence[0].next.revision).toBe(evidence[1].next.revision); expect(evidence[0].next.digest).not.toBe(evidence[1].next.digest);
  observer.close(); observer = await open(n, 'open-existing'); const bytes = fs.readFileSync(n.options.path);
  expect(observer.status().blocked).toBe(true);
  expect(() => observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).toThrow('equivocated');
  await expect(observer.advance(n.later)).rejects.toThrow('equivocated'); expect(fs.readFileSync(n.options.path)).toEqual(bytes);
});

it('rejects gaps, changed bodies, false signatures and rollback without damaging the retained head', async () => {
  const n = await fixture(), observer = await open(n), initial = fs.readFileSync(n.options.path);
  await expect(observer.advance(n.later)).rejects.toThrow('skips or rolls back');
  for (const value of [{ ...n.advance, policy: n.fork }, { ...n.advance, commitment: { ...n.advance.commitment, signature: randomBytes(64).toString('base64url') } },
    { ...n.advance, unexpected: true }, { ...n.advance, commitment: { ...n.advance.commitment, previous: { ...n.advance.commitment.previous, digest: 'a'.repeat(64) } } }]) {
    await expect(observer.advance(value)).rejects.toThrow(); expect(fs.readFileSync(n.options.path)).toEqual(initial);
  }
  await expect(createAdmissionPolicyAdvance(n.first, n.third, n.context, n.key)).rejects.toThrow('immediate successor');
  await expect(createAdmissionPolicyAdvance(n.second, n.third, n.context, n.key)).rejects.toThrow('retained predecessor');
  await observer.advance(n.advance); await observer.advance(n.later); const latest = fs.readFileSync(n.options.path);
  await expect(observer.advance(n.advance)).rejects.toThrow('skips or rolls back'); expect(fs.readFileSync(n.options.path)).toEqual(latest);
});

it('refuses another genesis or signer before creating local state, and requires retained state on ordinary reopen', async () => {
  const n = await fixture();
  await expect(openAdmissionPolicyObserver({ ...n.options, mode: 'create-new', initialPolicy: n.second })).rejects.toThrow('genesis');
  await expect(openAdmissionPolicyObserver({ ...n.options, mode: 'create-new', signingKey: generateSigningKeyPair() })).rejects.toThrow('not enrolled');
  expect(fs.existsSync(n.options.path)).toBe(false);
  await expect(open(n, 'open-existing')).rejects.toThrow('missing');
  const observer = await open(n); observer.close();
  const bytes = fs.readFileSync(n.options.path);
  await expect(open(n)).rejects.toThrow('already exists');
  await expect(openAdmissionPolicyObserver({ ...n.options, mode: 'open-existing', encryptionKey: randomBytes(32) })).rejects.toThrow();
  expect(fs.readFileSync(n.options.path)).toEqual(bytes);
});

it('serializes updates, snapshots caller input and prevents writes after closure', async () => {
  const n = await fixture(), observer = await open(n), input = structuredClone(n.advance);
  const pending = observer.advance(input); input.policy.expiresAt += 1;
  await expect(observer.advance(n.later)).rejects.toThrow('already in progress'); await pending;
  expect(observer.policy()).toEqual(n.second);
  const late = observer.advance(n.later); observer.close(); await expect(late).rejects.toThrow('closed');
  const reopened = await open(n, 'open-existing'); expect(reopened.policy()).toEqual(n.second);
});

it('captures initialization keys and path before asynchronous policy validation', async () => {
  const n = await fixture(), supplied = { ...n.options, encryptionKey: Uint8Array.from(n.options.encryptionKey), mode: 'create-new' as const };
  const pending = openAdmissionPolicyObserver(supplied);
  supplied.encryptionKey.fill(0); supplied.path += '.changed';
  const observer = await pending; observer.close(); expect(fs.existsSync(supplied.path)).toBe(false);
  const reopened = await open(n, 'open-existing'); expect(reopened.policy()).toEqual(n.first);
});

it.each(['file', ...(process.platform === 'win32' ? [] : ['directory'])])('poisons the writer after an uncertain %s flush and sends no guessed observation', async phase => {
  const n = await fixture(), observer = await open(n);
  if (phase === 'directory') vi.mocked(fsyncSync).mockImplementationOnce(actualFsync);
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('Injected flush failure'); });
  await expect(observer.advance(n.advance)).rejects.toThrow('Injected flush failure'); vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync);
  expect(() => observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).toThrow();
  observer.close(); const reopened = await open(n, 'open-existing'); expect(reopened.policy()).toEqual(phase === 'file' ? n.first : n.second);
  await reopened.advance(n.advance); expect(reopened.policy()).toEqual(n.second);
});

it('refuses observations once the retained policy expires and rejects expired successor installation', async () => {
  const n = await fixture(); let time = n.now;
  n.options.now = () => time; const observer = await open(n); time = n.second.expiresAt;
  expect(() => observer.observe(createAdmissionPolicyHeadRequest(n.context, time))).toThrow('not current');
  await expect(observer.advance(n.advance)).rejects.toThrow('not current'); expect(observer.policy()).toEqual(n.first);
});

it('collects a real four-observer new-head certificate while rejecting mixed and replayed observations', async () => {
  const n = await fixture(), observers = [];
  for (let i = 0; i < 5; i++) {
    const observer = await openAdmissionPolicyObserver({ ...n.options, path: `${n.options.path}.${i}`, signingKey: n.keys[i], mode: 'create-new' });
    cleanup.push(observer.close); observers.push(observer);
  }
  const oldRequest = createAdmissionPolicyHeadRequest(n.context, n.now), oldVotes = observers.slice(0, 4).map(observer => observer.observe(oldRequest));
  await Promise.all(observers.slice(0, 4).map(observer => observer.advance(n.advance)));
  const request = createAdmissionPolicyHeadRequest(n.context, n.now), votes = observers.map(observer => observer.observe(request));
  const certificate = { version: 1, kind: 'admission-policy-head-certificate', votes: votes.slice(0, 4) };
  expect(parseAdmissionPolicyHeadCertificate(certificate, request, n.context, n.advance.commitment.next, n.now).votes).toHaveLength(4);
  expect(() => parseAdmissionPolicyHeadCertificate({ ...certificate, votes: [votes[0], votes[1], votes[2], votes[4]] }, request, n.context, n.advance.commitment.next, n.now)).toThrow();
  expect(() => parseAdmissionPolicyHeadCertificate({ ...certificate, votes: oldVotes }, request, n.context, admissionPolicyHead(n.first), n.now)).toThrow();
  await expect(parseAdmissionPolicyAdvance({ ...n.advance, policy: n.first }, n.context)).rejects.toThrow('digest');
});
