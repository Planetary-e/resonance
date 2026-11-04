import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openAdmissionPolicyStore, signAdmissionPolicy } from '../admission-policy.js';
import { createAdmissionPolicyAdvance } from '../admission-policy-advance.js';
import { createAdmissionPolicyHeadVote, type AdmissionPolicyHead } from '../admission-policy-freshness.js';
import { createAdmissionPolicyQuery, ADMISSION_POLICY_QUERY_REPLY_TYPE } from '../admission-policy-query.js';
import { policyTransferFixture } from './fixtures/policy-transfer-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const n = await policyTransferFixture(); cleanup.push(n.close);
  const directory = mkdtempSync(join(tmpdir(), 'policy-trust-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'policy.json'), encryptionKey = randomBytes(32);
  let now = Date.now(), store = await openAdmissionPolicyStore({ path, encryptionKey, mode: 'create-new', now: () => now });
  cleanup.push(() => { store.close(); encryptionKey.fill(0); });
  const proof = (head: AdmissionPolicyHead) => {
    const query = createAdmissionPolicyQuery(n.context, now);
    return { query, reply: { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE,
      certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const,
        votes: n.keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, n.context, key, now)) } } };
  };
  const reopen = async () => { store.close(); store = await openAdmissionPolicyStore({ path, encryptionKey, mode: 'open-existing', now: () => now }); return store; };
  return { ...n, path, proof, reopen, get store() { return store; }, clock(value: number) { now = value; } };
}

it('pins the genesis and exact transitions in the existing encrypted policy store while preserving protected-history binding', async () => {
  const n = await fixture(), authority = n.context.authority;
  await n.store.install(n.first, authority); n.store.bindProtectedHistory('sha256:' + '1'.repeat(64));
  await n.store.install(n.first, authority, { observers: n.context });
  await expect(n.store.install(n.second, authority)).rejects.toThrow('signed immediate successor');
  await expect(n.store.install(n.second, authority, { advance: n.advance })).resolves.toEqual(n.second);
  await n.reopen(); expect(n.store.protectedHistoryContext()).toBe('sha256:' + '1'.repeat(64));
  expect(n.store.freshness()!.installed).toEqual(n.advance.commitment.next);
  await expect(n.store.install(n.first, authority)).rejects.toThrow();
  await expect(n.store.install(n.second, authority, { observers: { ...n.context, members: n.context.members.map((member, i) => ({ ...member, endpoint: `ws://127.0.0.1:${39000 + i}/` })) } })).rejects.toThrow('already pinned');
  await n.store.install(n.second, authority); expect(n.store.freshness()!.context).toEqual(n.context);
  const copy = n.store.freshness()!; copy.installed.revision = 999; expect(n.store.freshness()!.installed.revision).toBe(2);
});

it('retains a newer observed floor before refusing and fences conflicting quorum evidence across restart', async () => {
  const n = await fixture(), authority = n.context.authority;
  await n.store.install(n.first, authority, { observers: n.context });
  expect(() => n.store.observe(n.proof(n.advance.commitment.next))).toThrow('newer'); await n.reopen();
  expect(n.store.freshness()!.observed).toEqual(n.advance.commitment.next);
  expect(() => n.store.observe(n.proof(n.context.genesis))).toThrow('older');
  const { authority: _authority, signature: _signature, ...body } = n.second;
  const fork = await signAdmissionPolicy({ ...body, expiresAt: body.expiresAt + 1 }, authority, n.key.secretKey);
  const conflict = await createAdmissionPolicyAdvance(n.first, fork, n.context, n.key);
  expect(() => n.store.observe(n.proof(conflict.commitment.next))).toThrow('conflict'); await n.reopen();
  expect(n.store.freshness()!.conflict).toEqual(conflict.commitment.next);
  await expect(n.store.install(n.second, authority, { advance: n.advance })).rejects.toThrow('fenced');
  expect(() => n.store.observe(n.proof(n.advance.commitment.next))).toThrow('fenced');
});

it('rejects unauthenticated or expired observations without changing retained files and requires genesis for initial enrollment', async () => {
  const n = await fixture(), authority = n.context.authority;
  await expect(n.store.install(n.second, authority, { observers: n.context })).rejects.toThrow('genesis');
  expect(n.store.current()).toBeUndefined(); await n.store.install(n.first, authority, { observers: n.context });
  const before = readFileSync(n.path), proof = n.proof(n.advance.commitment.next);
  const invalid = structuredClone(proof); invalid.reply.certificate.votes[0].signature = 'A'.repeat(86);
  expect(() => n.store.observe(invalid)).toThrow(); expect(readFileSync(n.path)).toEqual(before);
  n.clock(proof.query.request.expiresAt); expect(() => n.store.observe(proof)).toThrow(); expect(readFileSync(n.path)).toEqual(before);
});

it('allows authenticated expired intermediate catch-up only below a retained newer floor', async () => {
  const n = await fixture(), authority = n.context.authority;
  const { authority: _authority, signature: _signature, ...body } = n.second;
  const third = await signAdmissionPolicy({ ...body, revision: 3, expiresAt: body.expiresAt + 600000 }, authority, n.key.secretKey);
  const later = await createAdmissionPolicyAdvance(n.second, third, n.context, n.key, n.advance.commitment.next);
  await n.store.install(n.first, authority, { observers: n.context }); n.clock(n.second.expiresAt + 1);
  expect(() => n.store.observe(n.proof(later.commitment.next))).toThrow('newer');
  await n.store.install(n.second, authority, { advance: n.advance });
  expect(n.store.freshness()!.observed.revision).toBe(3);
  await n.store.install(third, authority, { advance: later }); expect(n.store.freshness()!.installed.revision).toBe(3);
});
