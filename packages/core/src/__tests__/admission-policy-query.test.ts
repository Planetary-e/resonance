import { expect, it } from 'vitest';
import { generateSigningKeyPair } from '../crypto.js';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers } from '../admission-policy-freshness.js';
import { createAdmissionPolicyQuery, parseAdmissionPolicyQuery, parseAdmissionPolicyQueryReply,
  ADMISSION_POLICY_QUERY_REPLY_MAX_BYTES } from '../admission-policy-query.js';
const keys = Array.from({ length: 5 }, () => generateSigningKeyPair()), authority = generateSigningKeyPair(), now = Date.now();
const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers',
  authority: Buffer.from(authority.publicKey).toString('base64url'), quorum: 4, genesis: { revision: 1, digest: 'a'.repeat(64), transition: 'a'.repeat(64) },
  members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${32000 + i}/` })) });
function fixture() {
  const query = createAdmissionPolicyQuery(context, now), head = { revision: 2, digest: 'b'.repeat(64), transition: 'c'.repeat(64) };
  const reply = { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
    votes: keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, context, key, now)) } };
  return { query, reply };
}
it('carries only a fresh challenge and verifies the independently pinned quorum through an untrusted carrier', () => {
  const n = fixture(), raw = JSON.stringify(n.query);
  expect(parseAdmissionPolicyQuery(raw, context, now)).toEqual(n.query);
  expect(Object.keys(n.query)).toEqual(['version', 'type', 'request']);
  expect(raw).not.toContain(context.members[0].endpoint); expect(raw).not.toContain(context.authority);
  expect(parseAdmissionPolicyQueryReply(JSON.stringify(n.reply), n.query, context, now)).toEqual(n.reply);
  expect(() => parseAdmissionPolicyQueryReply(n.reply, createAdmissionPolicyQuery(context, now), context, now)).toThrow();
  expect(() => parseAdmissionPolicyQueryReply(n.reply, n.query, context, n.query.request.expiresAt)).toThrow();
});
it('rejects added identity/routing data, oversized frames and fabricated or mixed certificates', () => {
  const n = fixture();
  for (const added of [{ account: 'root' }, { admission: 'token' }, { endpoint: 'https://target.invalid' }, { policy: 'not part of this frame' }]) {
    expect(() => parseAdmissionPolicyQuery({ ...n.query, ...added }, context, now)).toThrow();
    expect(() => parseAdmissionPolicyQueryReply({ ...n.reply, ...added }, n.query, context, now)).toThrow();
  }
  expect(() => parseAdmissionPolicyQuery(' '.repeat(1025), context, now)).toThrow('limit');
  expect(() => parseAdmissionPolicyQueryReply(' '.repeat(ADMISSION_POLICY_QUERY_REPLY_MAX_BYTES + 1), n.query, context, now)).toThrow('limit');
  for (const damage of ['three', 'duplicate', 'signature', 'branch', 'null']) {
    const reply = structuredClone(n.reply);
    if (damage === 'three') reply.certificate.votes.pop();
    if (damage === 'duplicate') reply.certificate.votes[3] = reply.certificate.votes[0];
    if (damage === 'signature') reply.certificate.votes[0].signature = reply.certificate.votes[1].signature;
    if (damage === 'branch') reply.certificate.votes[0].head.transition = 'd'.repeat(64);
    expect(() => parseAdmissionPolicyQueryReply(damage === 'null' ? { ...reply, certificate: null } : reply, n.query, context, now)).toThrow();
  }
});
