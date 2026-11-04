import { beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { admissionWitnessSetId, createAdmissionWitnessVote, type AdmissionSpendCertificate, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { admissionKeyFingerprint, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { encodeAdmissionHistoryRecord, parseAdmissionHistoryImage, reduceAdmissionHistory, type AdmissionHistoryImage } from '../admission-history-records.js';
import { admissionRoleHistoriesIdentity, type AdmissionRoleHistories } from '../admission-role-history.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

let f: Awaited<ReturnType<typeof witnessFixture>>, other: typeof f, base: AdmissionHistoryImage, roles: AdmissionRoleHistories;
beforeAll(async () => {
  f = await witnessFixture(); other = await witnessFixture();
  base = await parseAdmissionHistoryImage({ version: 1, kind: 'admission-spend-checkpoint', policy: f.policy,
    state: { version: 2, authority: f.authority, spends: [], retiredIssuerKeys: [] } }, f.authority);
  roles = { witness: { version: 2, witness: Buffer.from(f.witnesses[0].publicKey).toString('base64url'), votes: [], retiredIssuerKeys: [] },
    coordinator: { version: 2, coordinator: Buffer.from(f.coordinators[0].publicKey).toString('base64url'), certificates: [], retiredIssuerKeys: [] } };
});
function claim(): AdmissionSpendClaim {
  return { setId: admissionWitnessSetId(f.policy.keys[0].witnesses!), issuerKey: f.policy.activeKey,
    spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${'a'.repeat(86)}` };
}
function certificate(c = claim()): AdmissionSpendCertificate { return { version: 1, votes: f.witnesses.slice(0, 4).map(key => createAdmissionWitnessVote(c, key)) }; }
async function capture(captured = roles, image = base) {
  return (await reduceAdmissionHistory(image, { version: 1, kind: 'admission-roles-checkpoint', at: f.time,
    image: { ...image, version: 2, roles: captured } }, 10000, 'checkpoint')).image as AdmissionHistoryImage & { version: 2 };
}
const voteMutation = (c = claim(), at = f.time) => ({ version: 1, kind: 'witness-vote', at, vote: createAdmissionWitnessVote(c, f.witnesses[0]) });
const certMutation = (c = claim(), at = f.time) => ({ version: 1, kind: 'coordinator-certificate', at, certificate: certificate(c) });

it('keeps v1 replay bytes stable and captures authenticated roles without changing policy or spends', async () => {
  expect(Object.keys(base)).toEqual(['version', 'kind', 'policy', 'state']);
  expect(encodeAdmissionHistoryRecord(await parseAdmissionHistoryImage(base, f.authority))).toEqual(encodeAdmissionHistoryRecord(base));
  const c = claim(), before = structuredClone(base), current = await capture({
    witness: { ...roles.witness!, votes: [createAdmissionWitnessVote(c, f.witnesses[0])] },
    coordinator: { ...roles.coordinator!, certificates: [certificate(c)] },
  });
  expect(current.state).toEqual(before.state); expect(current.policy).toEqual(before.policy); expect(base).toEqual(before);
  expect(await parseAdmissionHistoryImage(JSON.parse(encodeAdmissionHistoryRecord(current).toString()), f.authority)).toEqual(current);
  await expect(reduceAdmissionHistory(base, voteMutation(c))).rejects.toThrow(/captured/);
  await expect(reduceAdmissionHistory(base, { version: 1, kind: 'admission-roles-checkpoint', at: f.time, image: current })).rejects.toThrow(/mutation/);
});

it.each(['witness', 'coordinator'] as const)('preserves %s decisions across exact retry, competing claims and bounded capacity', async role => {
  const initial = await capture(), c = claim(), mutation = role === 'witness' ? voteMutation : certMutation;
  const first = (await reduceAdmissionHistory(initial, mutation(c), 1)).image;
  expect((await reduceAdmissionHistory(first, mutation(c), 1)).image).toEqual(first);
  await expect(reduceAdmissionHistory(first, mutation({ ...c, requestBinding: `admreq_${'b'.repeat(86)}` }), 1)).rejects.toThrow(/Conflicting/);
  await expect(reduceAdmissionHistory(first, mutation(), 1)).rejects.toThrow(/history/);
  expect(initial.roles).toEqual(roles);
});

it('enforces witness new-vote and retry cutoffs while accepting already signed quorum evidence until final cutoff', async () => {
  const initial = await capture(), c = claim(), cutoff = f.policy.keys[0];
  const voted = (await reduceAdmissionHistory(initial, voteMutation(c))).image;
  expect((await reduceAdmissionHistory(voted, voteMutation(c, cutoff.spendUntil))).image).toEqual(voted);
  await expect(reduceAdmissionHistory(initial, voteMutation(c, cutoff.spendUntil))).rejects.toThrow(/unavailable/);
  const certified = await reduceAdmissionHistory(initial, certMutation(c, cutoff.spendUntil));
  for (const [image, mutation] of [[voted, voteMutation(c, cutoff.retryUntil)], [certified.image, certMutation(c, cutoff.retryUntil)]] as const) {
    await expect(reduceAdmissionHistory(image, mutation)).rejects.toThrow(/unavailable/);
  }
});

it.each(['signature', 'duplicate', 'member', 'quorum', 'coordinator', 'fence', 'field', 'limit'] as const)('rejects invalid captured role evidence: %s', damage => {
  const c = claim(), bad = structuredClone(roles);
  bad.witness!.votes = [createAdmissionWitnessVote(c, f.witnesses[0])]; bad.coordinator!.certificates = [certificate(c)];
  if (damage === 'signature') bad.witness!.votes[0].signature = randomBytes(64).toString('base64url');
  if (damage === 'duplicate') bad.witness!.votes.push(bad.witness!.votes[0]);
  if (damage === 'member') bad.witness!.witness = Buffer.from(other.witnesses[0].publicKey).toString('base64url');
  if (damage === 'quorum') bad.coordinator!.certificates[0].votes.pop();
  if (damage === 'coordinator') bad.coordinator!.coordinator = Buffer.from(other.coordinators[0].publicKey).toString('base64url');
  if (damage === 'fence') bad.witness!.retiredIssuerKeys.push(c.issuerKey);
  if (damage === 'field') Object.assign(bad.witness!, { token: 'must-not-be-retained' });
  return expect(parseAdmissionHistoryImage({ ...base, version: 2, roles: bad }, f.authority, damage === 'limit' ? 0 : 10000)).rejects.toThrow();
});

it('retains both role fences across retirement, later checkpoints and policy updates', async () => {
  const entry = structuredClone(f.body.keys[0]); entry.profile.issuerPublicKey = other.body.keys[0].profile.issuerPublicKey;
  const policy = await signAdmissionPolicy({ ...f.body, revision: 2, activeKey: admissionKeyFingerprint(entry.profile.issuerPublicKey),
    keys: [...f.body.keys, entry] }, f.authority, f.authorityKey.secretKey);
  const c = claim(); let current: AdmissionHistoryImage = await capture();
  current = (await reduceAdmissionHistory(current, voteMutation(c))).image;
  current = (await reduceAdmissionHistory(current, certMutation(c))).image;
  current = (await reduceAdmissionHistory(current, { version: 1, kind: 'policy', at: f.time, policy })).image;
  for (const role of ['witness', 'coordinator'] as const) {
    const record = { version: 1, kind: 'role-retire', role, issuerKey: c.issuerKey, at: f.policy.keys[0].retryUntil };
    await expect(reduceAdmissionHistory(current, { ...record, at: f.time })).rejects.toThrow(/cutoff/);
    current = (await reduceAdmissionHistory(current, record)).image;
    await expect(reduceAdmissionHistory(current, role === 'witness' ? voteMutation(c) : certMutation(c))).rejects.toThrow(/unavailable/);
  }
  expect(current.version).toBe(2); if (current.version !== 2) throw new Error('Expected retained roles');
  expect(current.roles.witness).toMatchObject({ votes: [], retiredIssuerKeys: [c.issuerKey] });
  expect(current.roles.coordinator).toMatchObject({ certificates: [], retiredIssuerKeys: [c.issuerKey] });
  const checkpoint = { version: 1, kind: 'admission-state-checkpoint', at: f.time, image: current };
  expect((await reduceAdmissionHistory(current, checkpoint, 10000, 'checkpoint')).image).toEqual(current);
  for (const edit of [
    (v: any) => { delete v.image.roles; v.image.version = 1; },
    (v: any) => { v.image.roles.witness = null; },
    (v: any) => { v.image.roles.coordinator.retiredIssuerKeys = []; },
  ]) { const changed = structuredClone(checkpoint); edit(changed); await expect(reduceAdmissionHistory(current, changed, 10000, 'checkpoint')).rejects.toThrow(/preserve/); }
});

it('capture cannot replace existing participants, forget votes, clear denials or change unrelated state', async () => {
  const c = claim(), first = await capture({ ...roles, witness: { ...roles.witness!, votes: [createAdmissionWitnessVote(c, f.witnesses[0])] } });
  for (const replacement of [roles, { ...roles, witness: null }, { ...roles, witness: { ...roles.witness!, witness: Buffer.from(f.witnesses[1].publicKey).toString('base64url') } }]) {
    await expect(capture(replacement, first)).rejects.toThrow(/preserve/);
  }
  const onlyWitness = await capture({ ...first.roles, coordinator: null });
  expect((await capture(first.roles, onlyWitness)).roles).toEqual(first.roles);
  const changed = structuredClone(first); changed.state.retiredIssuerKeys = [c.issuerKey];
  await expect(reduceAdmissionHistory(first, { version: 1, kind: 'admission-roles-checkpoint', at: f.time, image: changed }, 10000, 'checkpoint')).rejects.toThrow(/preserve/);
});

it('treats collection order as irrelevant but keeps complete signed decision evidence', async () => {
  const c = claim(), initial = await capture({ ...roles, coordinator: { ...roles.coordinator!, certificates: [certificate(c)] } });
  const reordered = structuredClone(initial.roles); reordered.coordinator!.certificates[0].votes.reverse();
  expect(admissionRoleHistoriesIdentity(initial.roles)).toBe(admissionRoleHistoriesIdentity(reordered));
  expect((await capture(reordered, initial)).roles).toEqual(reordered);
  const fewer = structuredClone(initial.roles); fewer.coordinator!.certificates[0].votes[0] = createAdmissionWitnessVote(c, f.witnesses[4]);
  await expect(capture(fewer, initial)).rejects.toThrow(/preserve/);
});
