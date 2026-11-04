import { beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { admissionWitnessSetId, createAdmissionWitnessVote, verifyAdmissionWitnessVote } from '@resonance/core/admission-witness';
import { createRetainedAdmissionVerification } from '../admission-role-verification.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

vi.mock('@resonance/core/admission-witness', async original => {
  const actual = await original<typeof import('@resonance/core/admission-witness')>(); return { ...actual, verifyAdmissionWitnessVote: vi.fn(actual.verifyAdmissionWitnessVote) };
});
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
function claim() { return { setId: admissionWitnessSetId(f.policy.keys[0].witnesses!), issuerKey: f.policy.activeKey,
  spend: randomBytes(32).toString('base64url'), action: 'search' as const, requestBinding: `admreq_${'a'.repeat(86)}` }; }

it('reuses only successful exact signatures and evicts within its fixed bound', () => {
  const verifier = createRetainedAdmissionVerification(2), set = f.policy.keys[0].witnesses!;
  const votes = [0, 1, 2].map(() => createAdmissionWitnessVote(claim(), f.witnesses[0])); vi.mocked(verifyAdmissionWitnessVote).mockClear();
  expect(verifier.vote(votes[0], votes[0], set)).toBe(true);
  expect(verifier.vote(structuredClone(votes[0]), votes[0], set)).toBe(true); expect(verifyAdmissionWitnessVote).toHaveBeenCalledTimes(1);
  expect(verifier.vote(votes[1], votes[1], set)).toBe(true); expect(verifier.vote(votes[2], votes[2], set)).toBe(true);
  expect(verifier.vote(votes[0], votes[0], set)).toBe(true); expect(verifyAdmissionWitnessVote).toHaveBeenCalledTimes(4);
  const invalid = { ...votes[0], signature: randomBytes(64).toString('base64url') };
  expect(verifier.vote(invalid, invalid, set)).toBe(false); expect(verifier.vote(invalid, invalid, set)).toBe(false);
  expect(verifyAdmissionWitnessVote).toHaveBeenCalledTimes(6);
});

it('rechecks altered signatures, expected claims, member sets, extra fields and serialization hooks after a cache hit', () => {
  const verifier = createRetainedAdmissionVerification(), set = f.policy.keys[0].witnesses!, vote = createAdmissionWitnessVote(claim(), f.witnesses[0]);
  expect(verifier.vote(vote, vote, set)).toBe(true);
  expect(verifier.vote(vote, { ...vote, requestBinding: `admreq_${'b'.repeat(86)}` }, set)).toBe(false);
  const changed = structuredClone(set); changed.members[0].endpoint = 'ws://127.0.0.1:1/';
  expect(verifier.vote(vote, vote, changed)).toBe(false);
  expect(verifier.vote({ ...vote, extra: true }, vote, set)).toBe(false);
  const forged = Object.assign(Object.create({ toJSON: () => vote }), vote, { signature: randomBytes(64).toString('base64url') });
  expect(verifier.vote(forged, vote, set)).toBe(false);
  expect(verifier.vote({ ...vote, issuerKey: { toString: () => vote.issuerKey, toJSON: () => vote.issuerKey } }, vote, set)).toBe(false);
  expect(verifier.vote({ ...vote, spend: randomBytes(32).toString('base64url') }, vote, set)).toBe(false);
});

it('requires distinct current members and a complete certificate even when each vote is cached', () => {
  const verifier = createRetainedAdmissionVerification(), set = f.policy.keys[0].witnesses!, c = claim();
  const votes = f.witnesses.map(key => createAdmissionWitnessVote(c, key)); votes.forEach(vote => expect(verifier.vote(vote, c, set)).toBe(true));
  expect(verifier.certificate({ version: 1, votes }, c, set)).toBe(true);
  expect(verifier.certificate({ version: 1, votes: votes.slice(0, 3) }, c, set)).toBe(false);
  expect(verifier.certificate({ version: 1, votes: [votes[0], votes[0], votes[1], votes[2]] }, c, set)).toBe(false);
  expect(verifier.certificate({ version: 1, votes, extra: true }, c, set)).toBe(false);
});
