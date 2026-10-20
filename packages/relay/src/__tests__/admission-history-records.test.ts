import { beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { admissionKeyFingerprint, signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { encodeAdmissionHistoryRecord, parseAdmissionHistoryImage, reduceAdmissionHistory, type AdmissionHistoryImage } from '../admission-history-records.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

let f: Awaited<ReturnType<typeof witnessFixture>>, image: AdmissionHistoryImage;
beforeAll(async () => {
  f = await witnessFixture();
  image = await parseAdmissionHistoryImage({ version: 1, kind: 'admission-spend-checkpoint', policy: f.policy,
    state: { version: 2, authority: f.authority, spends: [], retiredIssuerKeys: [] } }, f.authority);
});
const row = () => ({ issuerKey: f.policy.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search', binding: `admreq_${'a'.repeat(86)}` });
const spend = (r = row(), at = f.time) => ({ version: 1, kind: 'spend', at, row: r });

it('replays attribution and exact spends without mutating its input or permitting conflicting binding', async () => {
  const r = row(), a = await reduceAdmissionHistory(image, spend(r));
  expect(image.state.spends).toEqual([]); expect(a.image.state.spends).toEqual([r]);
  expect((await reduceAdmissionHistory(a.image, spend(r))).image).toEqual(a.image);
  await expect(reduceAdmissionHistory(a.image, spend({ ...r, binding: `admreq_${'b'.repeat(86)}` }))).rejects.toThrow('Conflicting');
  const legacy = structuredClone(a.image); legacy.state.spends[0].issuerKey = null;
  expect((await reduceAdmissionHistory(legacy, spend(r))).image).toEqual(a.image);
});
it.each(['extra', 'unknown', 'time', 'key', 'row-extra', 'null-key', 'size'])( 'refuses malformed %s mutation', async damage => {
  const op: any = spend();
  if (damage === 'extra') op.extra = true;
  if (damage === 'unknown') op.kind = 'reset';
  if (damage === 'time') op.at = -1;
  if (damage === 'key') op.row.issuerKey = `sha256:${'0'.repeat(64)}`;
  if (damage === 'row-extra') op.row.token = 'secret';
  if (damage === 'null-key') op.row.issuerKey = null;
  if (damage === 'size') op.row.action = 'x'.repeat(65536);
  await expect(reduceAdmissionHistory(image, op)).rejects.toThrow();
});
it('enforces new-spend and retry cutoffs separately, including fixed entry capacity', async () => {
  const r = row(), a = (await reduceAdmissionHistory(image, spend(r), 1)).image;
  await expect(reduceAdmissionHistory(a, spend(), 1)).rejects.toThrow();
  await expect(reduceAdmissionHistory(image, spend(r, f.policy.keys[0].spendUntil))).rejects.toThrow('unavailable');
  expect((await reduceAdmissionHistory(a, spend(r, f.policy.keys[0].spendUntil))).image).toEqual(a);
  await expect(reduceAdmissionHistory(a, spend(r, f.policy.keys[0].retryUntil))).rejects.toThrow('unavailable');
});
async function successor(): Promise<SignedAdmissionPolicy> {
  const entry = { ...f.body.keys[0], profile: { ...f.body.keys[0].profile, scope: { ...f.scope, epoch: 'second' } } };
  // A second valid RSA key is needed; witnessFixture also supplies the signing authority used below.
  const other = await witnessFixture(); entry.profile.issuerPublicKey = other.body.keys[0].profile.issuerPublicKey;
  return signAdmissionPolicy({ ...f.body, revision: 2, activeKey: admissionKeyFingerprint(entry.profile.issuerPublicKey),
    keys: [...f.body.keys, entry] }, f.authority, f.authorityKey.secretKey);
}
it('preserves signed policy transitions and permanent fences while retaining unproven legacy rows', async () => {
  const r = row(), legacy = { ...row(), issuerKey: null };
  let current = (await reduceAdmissionHistory(image, spend(r))).image; current.state.spends.push(legacy);
  const policy = await successor(); current = (await reduceAdmissionHistory(current, { version: 1, kind: 'policy', at: f.time, policy })).image;
  const retired = (await reduceAdmissionHistory(current, { version: 1, kind: 'retire', at: f.policy.keys[0].retryUntil, issuerKey: r.issuerKey })).image;
  expect(retired.state.spends).toEqual([legacy]); expect(retired.state.retiredIssuerKeys).toEqual([r.issuerKey]);
  await expect(reduceAdmissionHistory(retired, spend(r))).rejects.toThrow();
  await expect(reduceAdmissionHistory(retired, { version: 1, kind: 'policy', at: f.time, policy: f.policy })).rejects.toThrow();
  const recovered = (await reduceAdmissionHistory(retired, { version: 1, kind: 'legacy-recovery', at: f.policy.keys[0].retryUntil,
    attributions: [{ spend: legacy.spend, issuerKey: r.issuerKey }] })).image;
  expect(recovered.state.spends).toEqual([]); expect(recovered.state.retiredIssuerKeys).toEqual([r.issuerKey]);
});
it('authenticates snapshot policy and rejects duplicate spends and fence/key contradictions', async () => {
  const r = row();
  for (const bad of [
    { ...image, policy: { ...image.policy, revision: 77 } },
    { ...image, state: { ...image.state, spends: [r, r] } },
    { ...image, state: { ...image.state, spends: [r], retiredIssuerKeys: [r.issuerKey] } },
    { ...image, extra: true },
  ]) await expect(parseAdmissionHistoryImage(bad, f.authority)).rejects.toThrow();
});
it('binds full policy checkpoints to unchanged spends and permanent denials, including envelope kind and signed successor', async () => {
  const policy = await successor(), legacy = { ...row(), issuerKey: null };
  const current: AdmissionHistoryImage = { ...image, policy, state: { ...image.state, spends: [legacy], retiredIssuerKeys: [f.policy.activeKey] } };
  const { authority, signature, ...body } = policy;
  const next = await signAdmissionPolicy({ ...body, revision: 3 }, f.authority, f.authorityKey.secretKey);
  const checkpoint = { version: 1 as const, kind: 'admission-policy-checkpoint' as const, at: f.time, image: { ...current, policy: next } };
  expect((await reduceAdmissionHistory(current, checkpoint, 10000, 'checkpoint')).image).toEqual(checkpoint.image);
  await expect(reduceAdmissionHistory(current, checkpoint)).rejects.toThrow('mutation');
  await expect(reduceAdmissionHistory(current, spend(), 10000, 'checkpoint')).rejects.toThrow('mutation');
  for (const edit of [
    (value: typeof checkpoint) => { value.image.state.spends = []; },
    (value: typeof checkpoint) => { value.image.state.retiredIssuerKeys = []; },
    (value: typeof checkpoint) => { value.image.state.spends[0].binding = `admreq_${'c'.repeat(86)}`; },
    (value: typeof checkpoint) => { value.image.policy.revision++; },
    (value: typeof checkpoint) => { value.image.policy = f.policy; },
  ]) { const bad = structuredClone(checkpoint); edit(bad); await expect(reduceAdmissionHistory(current, bad, 10000, 'checkpoint')).rejects.toThrow(); }
});

it('retains a complete state checkpoint, including unproven rows and denials, without a policy transition', async () => {
  const policy = await successor(), legacy = { ...row(), issuerKey: null };
  const current: AdmissionHistoryImage = { ...image, policy, state: { ...image.state, spends: [legacy], retiredIssuerKeys: [f.policy.activeKey] } };
  const checkpoint = { version: 1 as const, kind: 'admission-state-checkpoint' as const, at: f.time, image: structuredClone(current) };
  const before = structuredClone(current), reduced = await reduceAdmissionHistory(current, checkpoint, 10000, 'checkpoint');
  expect(reduced.image).toEqual(before); expect(current).toEqual(before); expect(reduced.record).toEqual(checkpoint);
  await expect(reduceAdmissionHistory(current, checkpoint)).rejects.toThrow('mutation');
  const { authority, signature, ...body } = policy;
  const validSuccessor = await signAdmissionPolicy({ ...body, revision: policy.revision + 1 }, f.authority, f.authorityKey.secretKey);
  for (const edit of [
    (value: typeof checkpoint) => { value.image.state.spends = []; },
    (value: typeof checkpoint) => { value.image.state.retiredIssuerKeys = []; },
    (value: typeof checkpoint) => { value.image.state.spends[0].binding = `admreq_${'d'.repeat(86)}`; },
    (value: typeof checkpoint) => { value.image.state.spends[0].issuerKey = policy.activeKey; },
    (value: typeof checkpoint) => { value.image.policy = validSuccessor; },
    (value: typeof checkpoint) => { value.at = policy.expiresAt; },
  ]) { const bad = structuredClone(checkpoint); edit(bad); await expect(reduceAdmissionHistory(current, bad, 10000, 'checkpoint')).rejects.toThrow(); }
});

it('encodes a complete image larger than a delta and refuses it in a delta envelope', async () => {
  const current = { ...image, state: { ...image.state, spends: Array.from({ length: 400 }, () => row()) } };
  const checkpoint = { version: 1 as const, kind: 'admission-state-checkpoint' as const, at: f.time, image: current };
  expect(encodeAdmissionHistoryRecord(checkpoint).length).toBeGreaterThan(65536);
  expect((await reduceAdmissionHistory(current, checkpoint, 10000, 'checkpoint')).image).toEqual(current);
  await expect(reduceAdmissionHistory(current, checkpoint)).rejects.toThrow('capacity');
});
