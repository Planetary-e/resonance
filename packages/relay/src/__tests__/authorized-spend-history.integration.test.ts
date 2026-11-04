import { afterEach, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdmissionWitnessRequest, createAdmissionWitnessVote, type AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { historyCheckpointEnvelopeId, openHistoryCheckpoint, HISTORY_DELTA_MAX_PAYLOAD } from '@resonance/core/history-checkpoint';
import { reduceAdmissionHistory } from '../admission-history-records.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { protectedRoleFixture } from './fixtures/protected-role-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
async function fixture(maxArchiveBlocks?: number) {
  const n = await protectedRoleFixture(f, maxArchiveBlocks); cleanup.push(n.close);
  const capture = await n.capture(); await capture.apply((await capture.review()).approvalDigest); capture.close();
  const make = () => {
    const claim = n.claim(), request = createAdmissionWitnessRequest(claim, f.coordinators[0]);
    const certificate: AdmissionSpendCertificate = { version: 1, votes: f.witnesses.slice(0, 4).map(key => createAdmissionWitnessVote(request, key)) };
    const row = { issuerKey: claim.issuerKey, spend: claim.spend, action: claim.action, binding: claim.requestBinding };
    return { row, certificate, request };
  };
  return { ...n, make, n };
}
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release); return { promise, release }; }

it.each(['issuerKey', 'spend', 'action', 'binding'] as const)('binds certificate %s to the exact spend before writing an intent', async field => {
  const n = await fixture(), { row, certificate } = n.make(), before = n.history.read();
  if (field === 'action') row.action = 'mailbox-fetch';
  else row[field] = field === 'binding' ? `admreq_${'b'.repeat(86)}` : randomBytes(32).toString('base64url');
  await expect(n.history.writeAuthorizedSpend(row, certificate)).rejects.toThrow('does not match');
  expect(n.history.read()).toEqual(before);
});

it.each(['signature', 'duplicate-witness', 'extra-row-field', 'extra-record-field', 'version', 'size'] as const)('rejects unauthorized or malformed compound %s without mutation', async fault => {
  const n = await fixture(), { row, certificate } = n.make(), before = n.history.read();
  const record: any = { version: 1, kind: 'authorized-spend', at: f.time, row, certificate };
  if (fault === 'signature') certificate.votes[0].signature = randomBytes(64).toString('base64url');
  if (fault === 'duplicate-witness') certificate.votes[3] = structuredClone(certificate.votes[0]);
  if (fault === 'extra-row-field') record.row.extra = true;
  if (fault === 'extra-record-field') record.extra = true;
  if (fault === 'version') record.version = 2;
  if (fault === 'size') record.certificate.extra = 'x'.repeat(HISTORY_DELTA_MAX_PAYLOAD);
  await expect(reduceAdmissionHistory(before.image, record)).rejects.toThrow();
  if (!['extra-record-field', 'version'].includes(fault)) await expect(n.history.writeAuthorizedSpend(row, certificate)).rejects.toThrow();
  expect(n.history.read()).toEqual(before);
});

it.each(['certificate', 'spend'] as const)('enforces the existing %s capacity before intent and preserves the other half', async full => {
  const n = await fixture(); n.history.close();
  const maximum = full === 'certificate' ? 1 : 2;
  const history = await openProtectedAdmissionSpendHistory({ ...n.options, maxSpends: maximum }); cleanup.push(history.close); await history.ready();
  if (full === 'spend') for (let i = 0; i < maximum; i++) await history.write(n.make().row);
  const before = history.read(), { row, certificate } = n.make();
  await expect(history.writeAuthorizedSpend(row, certificate)).rejects.toThrow();
  expect(history.read()).toEqual(before); expect(history.read().pending).toBeNull();
});

it('retains checkpoint headroom and refuses an intent when archive capacity cannot cover the complete combined image', async () => {
  const n = await fixture(3), before = n.history.read(), { row, certificate } = n.make();
  await expect(n.history.writeAuthorizedSpend(row, certificate)).rejects.toThrow('checkpoint headroom');
  expect(n.history.read()).toEqual(before);
});

it('snapshots both arguments and exposes neither half before four receipts, then appends exactly one compound block', async () => {
  const n = await fixture(), { row, certificate } = n.make(), original = structuredClone({ row, certificate });
  const before = n.history.read(), blocked = held(); let arrivals = 0;
  n.gate(async () => { if (++arrivals > 3) await blocked.promise; });
  const pending = n.history.writeAuthorizedSpend(row, certificate);
  row.binding = `admreq_${'z'.repeat(86)}`; certificate.votes[0].signature = randomBytes(64).toString('base64url');
  const cutoff = performance.now() + 500;
  while (n.stores.filter(store => store.describe().sequence === before.applied!.sequence + 1).length < 3) {
    if (performance.now() >= cutoff) throw new Error('Three replicas did not durably append in the test'); await delay(1);
  }
  const intent = n.history.read();
  expect(intent.pending?.sequence).toBe(before.applied!.sequence + 1); expect(intent.applied).toEqual(before.applied);
  expect(intent.image).toEqual(before.image); expect(n.history.roleState().coordinator!.certificates).toEqual(before.image.version === 2 ? before.image.roles.coordinator!.certificates : []);
  const record = JSON.parse(openHistoryCheckpoint(intent.pending!, n.context, n.key).toString('utf8'));
  expect(record).toEqual({ version: 1, kind: 'authorized-spend', at: f.time, ...original });
  blocked.release(); await pending; n.gate();
  const after = n.history.read(); expect(after.pending).toBeNull(); expect(after.applied!.sequence).toBe(before.applied!.sequence + 1);
  expect(after.image.state.spends).toContainEqual(original.row);
  expect(n.history.roleState().coordinator!.certificates).toContainEqual(original.certificate);
  expect(n.stores.filter(store => store.describe().sequence === after.applied!.sequence).length).toBeGreaterThanOrEqual(4);
  await n.reopen(); await n.n.history.ready();
  expect(n.n.history.read().image).toEqual(after.image);
});

it('retries only the original pending proof and row after lost replies and leaves legacy APIs strict', async () => {
  const n = await fixture(), { row, certificate, request } = n.make(), before = n.history.read(); n.loseReplies(true);
  await expect(n.history.writeAuthorizedSpend(row, certificate)).rejects.toThrow('Four');
  const pending = n.history.read(); expect(pending.pending).not.toBeNull(); expect(pending.image).toEqual(before.image);
  expect(n.history.pendingRoleDecision()).toEqual({ version: 1, kind: 'coordinator-certificate', at: f.time, certificate });
  const id = historyCheckpointEnvelopeId(pending.pending!);
  const alternate: AdmissionSpendCertificate = { version: 1, votes: f.witnesses.slice(1, 5).map(key => createAdmissionWitnessVote(request, key)) };
  await expect(n.history.writeAuthorizedSpend({ ...row, binding: `admreq_${'z'.repeat(86)}` }, certificate)).rejects.toThrow('pending');
  await expect(n.history.writeAuthorizedSpend(row, alternate)).rejects.toThrow('pending');
  await expect(n.history.write(row)).rejects.toThrow('pending');
  await expect(n.history.writeRoleDecision({ kind: 'coordinator-certificate', certificate })).rejects.toThrow('pending');
  expect(historyCheckpointEnvelopeId(n.history.read().pending!)).toBe(id);
  n.loseReplies(false); n.time(f.time + 500); await n.history.writeAuthorizedSpend(row, certificate);
  expect(n.history.read().applied!.id).toBe(id); expect(n.history.read().image.state.spends).toContainEqual(row);
  expect(n.history.roleState().coordinator!.certificates).toContainEqual(certificate);
  await n.reopen(); await n.n.history.ready();
  expect(n.n.history.read().applied!.id).toBe(id); expect(n.n.history.read().pending).toBeNull();
});

it('reopens an unapplied compound intent and recovers the original proof and envelope without another delta', async () => {
  const n = await fixture(), original = structuredClone(n.make()), before = n.history.read();
  n.loseReplies(true);
  await expect(n.history.writeAuthorizedSpend(original.row, original.certificate)).rejects.toThrow('Four');
  const pending = n.history.read().pending!;
  expect(pending).not.toBeNull(); expect(n.history.read().image).toEqual(before.image);
  expect(n.history.read().applied).toEqual(before.applied);
  const id = historyCheckpointEnvelopeId(pending);
  expect(JSON.parse(openHistoryCheckpoint(pending, n.context, n.key).toString('utf8'))).toEqual({
    version: 1, kind: 'authorized-spend', at: f.time, row: original.row, certificate: original.certificate,
  });
  await n.reopen();
  expect(n.n.history.read().pending).toEqual(pending);
  expect(n.n.history.read().image).toEqual(before.image);
  expect(n.n.history.read().applied).toEqual(before.applied);
  n.loseReplies(false); await n.n.history.ready();
  const recovered = n.n.history.read();
  expect(recovered.pending).toBeNull(); expect(recovered.applied).toEqual({ sequence: pending.sequence, id });
  expect(pending.sequence).toBe(before.applied!.sequence + 1);
  expect(recovered.image.state.spends).toEqual([...before.image.state.spends, original.row]);
  expect(n.n.history.roleState().coordinator!.certificates).toEqual([
    ...(before.image.version === 2 ? before.image.roles.coordinator!.certificates : []), original.certificate,
  ]);
  const retained = n.stores.flatMap(store => store.read().envelopes.filter(envelope => envelope.sequence > before.applied!.sequence));
  expect(retained.length).toBeGreaterThanOrEqual(4);
  expect(new Set(retained.map(historyCheckpointEnvelopeId))).toEqual(new Set([id]));
  await n.n.history.writeAuthorizedSpend(original.row, original.certificate);
  expect(n.n.history.read()).toEqual(recovered);
});

it('validates both halves of an idempotent combined state and preserves new-spend and retry cutoffs', async () => {
  const n = await fixture(), { row, certificate } = n.make(); await n.history.writeAuthorizedSpend(row, certificate);
  const accepted = n.history.read();
  await n.history.writeAuthorizedSpend(row, certificate); expect(n.history.read()).toEqual(accepted);
  const invalid = structuredClone(certificate); invalid.votes[0].signature = randomBytes(64).toString('base64url');
  await expect(n.history.writeAuthorizedSpend(row, invalid)).rejects.toThrow(); expect(n.history.read()).toEqual(accepted);
  n.time(f.policy.keys[0].spendUntil);
  await n.history.writeAuthorizedSpend(row, certificate); expect(n.history.read()).toEqual(accepted);
  const fresh = n.make(); await expect(n.history.writeAuthorizedSpend(fresh.row, fresh.certificate)).rejects.toThrow('unavailable');
  expect(n.history.read()).toEqual(accepted);
  n.time(f.policy.keys[0].retryUntil);
  await expect(n.history.writeAuthorizedSpend(row, certificate)).rejects.toThrow('unavailable'); expect(n.history.read()).toEqual(accepted);
});

it('replays the compound through real generation agreement and restore with both decisions retained', async () => {
  const n = await fixture(), { row, certificate } = n.make(); await n.history.writeAuthorizedSpend(row, certificate);
  const review = await n.recover(); expect(review).toMatchObject({ spends: 1, coordinatorCertificates: 2 });
  expect(n.n.history.read().image.state.spends).toContainEqual(row); expect(n.n.history.roleState().coordinator!.certificates).toContainEqual(certificate);
  const applied = n.n.history.read().applied;
  await n.n.history.writeAuthorizedSpend(row, certificate); expect(n.n.history.read().applied).toEqual(applied);
});

it.each(['certificate', 'spend'] as const)('preserves a legacy %s half while atomically completing the matching combined state', async retained => {
  const n = await fixture(); let { row, certificate } = n.make();
  if (retained === 'certificate') {
    certificate = n.history.roleState().coordinator!.certificates[0];
    const claim = certificate.votes[0]; row = { issuerKey: claim.issuerKey, spend: claim.spend, action: claim.action, binding: claim.requestBinding };
  } else await n.history.write(row);
  const before = n.history.read(), certificates = n.history.roleState().coordinator!.certificates.length;
  await n.history.writeAuthorizedSpend(row, certificate);
  const after = n.history.read(); expect(after.applied!.sequence).toBe(before.applied!.sequence + 1);
  expect(after.image.state.spends).toEqual([row]);
  expect(n.history.roleState().coordinator!.certificates).toHaveLength(certificates + (retained === 'spend' ? 1 : 0));
  expect(n.history.roleState().coordinator!.certificates).toContainEqual(certificate);
  await n.history.writeAuthorizedSpend(row, certificate); expect(n.history.read()).toEqual(after);
});
