import { expect, it } from 'vitest';
import { generateSigningKeyPair } from '../crypto.js';
import { admissionPolicyObserversId, createAdmissionPolicyHeadRequest, createAdmissionPolicyHeadVote,
  parseAdmissionPolicyHeadCertificate, parseAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote,
  parseAdmissionPolicyObservers, type AdmissionPolicyHeadCertificate } from '../admission-policy-freshness.js';

const keys = Array.from({ length: 5 }, () => generateSigningKeyPair()), authority = generateSigningKeyPair();
const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers',
  authority: Buffer.from(authority.publicKey).toString('base64url'), quorum: 4, genesis: { revision: 1, digest: 'a'.repeat(64), transition: 'a'.repeat(64) },
  members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${32000 + i}/` })) });
const now = Date.now(), head = { revision: 2, digest: 'b'.repeat(64), transition: 'c'.repeat(64) };
function fixture() {
  const request = createAdmissionPolicyHeadRequest(context, now);
  const votes = keys.map(key => createAdmissionPolicyHeadVote(request, head, context, key, now));
  const certificate: AdmissionPolicyHeadCertificate = { version: 1, kind: 'admission-policy-head-certificate', votes: votes.slice(0, 4) };
  return { request, votes, certificate, parse: (value: unknown) => parseAdmissionPolicyHeadCertificate(value, request, context, head, now) };
}
it('authenticates four or five distinct enrolled observers of one current challenge and head', () => {
  const n = fixture(); expect(n.parse(n.certificate)).toEqual(n.certificate);
  expect(n.parse({ ...n.certificate, votes: n.votes }).votes).toHaveLength(5);
  expect(n.parse(n.certificate)).not.toBe(n.certificate);
  expect(admissionPolicyObserversId({ ...context, members: [...context.members].reverse() })).toBe(admissionPolicyObserversId(context));
  expect(createAdmissionPolicyHeadRequest(context, now).challenge).not.toBe(n.request.challenge);
});
it.each(['duplicate', 'three', 'six', 'mixed-head', 'mixed-transition', 'bad-signature', 'unknown-observer', 'extra-field', 'cross-request', 'null'])(
  'rejects a %s certificate', kind => {
    const n = fixture(), value: any = structuredClone(n.certificate);
    if (kind === 'duplicate') value.votes[3] = value.votes[0];
    if (kind === 'three') value.votes.pop();
    if (kind === 'six') value.votes = [...n.votes, n.votes[0]];
    if (kind === 'mixed-head') value.votes[0] = createAdmissionPolicyHeadVote(n.request, { ...head, digest: 'c'.repeat(64) }, context, keys[0], now);
    if (kind === 'mixed-transition') value.votes[0] = createAdmissionPolicyHeadVote(n.request, { ...head, transition: 'd'.repeat(64) }, context, keys[0], now);
    if (kind === 'bad-signature') value.votes[0].signature = n.votes[1].signature;
    if (kind === 'unknown-observer') value.votes[0].observer = Buffer.from(authority.publicKey).toString('base64url');
    if (kind === 'extra-field') value.accountId = 'must-not-be-transmitted';
    if (kind === 'cross-request') value.votes[0] = createAdmissionPolicyHeadVote(createAdmissionPolicyHeadRequest(context, now), head, context, keys[0], now);
    if (kind === 'null') value.votes[0] = null;
    expect(() => n.parse(value)).toThrow();
  },
);
it.each(['authority', 'genesis', 'endpoint', 'member'])('binds votes to the independently pinned %s', field => {
  const n = fixture(), other = structuredClone(context);
  if (field === 'authority') other.authority = Buffer.from(generateSigningKeyPair().publicKey).toString('base64url');
  if (field === 'genesis') other.genesis.digest = 'c'.repeat(64);
  if (field === 'endpoint') other.members[0].endpoint = 'ws://127.0.0.1:39999/';
  if (field === 'member') other.members[0].publicKey = Buffer.from(generateSigningKeyPair().publicKey).toString('base64url');
  expect(() => parseAdmissionPolicyHeadCertificate(n.certificate, n.request, other, head, now)).toThrow();
});
it.each(['expires', 'future', 'oversized-lifetime', 'zero-lifetime', 'bad-challenge', 'extra-field'])('refuses a %s request before signing', kind => {
  const n = fixture(), request: any = { ...n.request };
  if (kind === 'expires') request.expiresAt = now;
  if (kind === 'future') { request.issuedAt = now + 1; request.expiresAt = now + 100; }
  if (kind === 'oversized-lifetime') request.expiresAt = now + 30001;
  if (kind === 'zero-lifetime') request.expiresAt = request.issuedAt;
  if (kind === 'bad-challenge') request.challenge += '=';
  if (kind === 'extra-field') request.userId = 'forbidden';
  expect(() => createAdmissionPolicyHeadVote(request, head, context, keys[0], now)).toThrow();
});
it('refuses an expired certificate, another expected head and rollback beneath the pinned genesis', () => {
  const n = fixture();
  expect(() => parseAdmissionPolicyHeadCertificate(n.certificate, n.request, context, head, n.request.expiresAt)).toThrow();
  expect(() => parseAdmissionPolicyHeadCertificate(n.certificate, n.request, context, { ...head, revision: 3, digest: 'c'.repeat(64) }, now)).toThrow();
  expect(() => createAdmissionPolicyHeadVote(n.request, { ...head, revision: 0 }, context, keys[0], now)).toThrow();
  expect(() => createAdmissionPolicyHeadVote(n.request, { ...head, revision: 1 }, context, keys[0], now)).toThrow();
});
it('rejects tampered signed fields and does not mutate caller signing material', () => {
  const n = fixture(), before = keys[0].secretKey.slice();
  for (const vote of [{ ...n.votes[0], head: { ...head, revision: 3 } }, { ...n.votes[0], kind: 'admission-witness-vote' },
    { ...n.votes[0], request: { ...n.request, expiresAt: n.request.expiresAt + 1 } }, { ...n.votes[0], extra: true }]) {
    expect(() => parseAdmissionPolicyHeadVote(vote, n.request, context, now)).toThrow();
  }
  expect(() => createAdmissionPolicyHeadVote(n.request, head, context, authority, now)).toThrow('not enrolled');
  expect(keys[0].secretKey).toEqual(before);
  expect(() => parseAdmissionPolicyHeadRequest(n.request, context, NaN)).toThrow();
  expect(() => createAdmissionPolicyHeadRequest(context, now, Number.MAX_SAFE_INTEGER)).toThrow();
});
it('rejects malformed contexts and duplicate membership before allocating a request', () => {
  for (const value of [null, { ...context, quorum: 3 }, { ...context, members: context.members.slice(0, 4) },
    { ...context, members: [context.members[0], ...context.members.slice(0, 4)] },
    { ...context, members: context.members.map(member => ({ ...member, endpoint: 'ws://public.example/' })) }]) {
    expect(() => parseAdmissionPolicyObservers(value)).toThrow();
  }
});
