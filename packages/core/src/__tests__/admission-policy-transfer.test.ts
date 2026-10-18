import { beforeAll, afterAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { policyTransferFixture } from './fixtures/policy-transfer-fixture.js';
import { ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES, ADMISSION_POLICY_MAX_CHUNKS, createAdmissionPolicyChunkRequest,
  createAdmissionPolicyTransfer, parseAdmissionPolicyChunkRequest, parseAdmissionPolicyChunkReply, assembleAdmissionPolicyTransfer } from '../admission-policy-transfer.js';

let n: Awaited<ReturnType<typeof policyTransferFixture>>, artifact: Awaited<ReturnType<typeof createAdmissionPolicyTransfer>>;
beforeAll(async () => { n = await policyTransferFixture(true); artifact = await createAdmissionPolicyTransfer(n.advance, n.context); }, 30000);
afterAll(() => n?.close());
const request = () => createAdmissionPolicyChunkRequest(n.context, n.context.genesis);
function chunks() { const first = artifact.chunk(request()); return Array.from({ length: first.count }, (_, index) => artifact.chunk({ ...request(), artifact: first.artifact, index })); }

it('transfers a real signed policy above one private payload cap using independently bounded chunks', async () => {
  expect(artifact.bytes).toBeGreaterThan(190 * 1024);
  const values = chunks(); expect(values.length).toBeGreaterThan(1); expect(values.length).toBeLessThanOrEqual(ADMISSION_POLICY_MAX_CHUNKS);
  for (const value of values) expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES);
  expect(await assembleAdmissionPolicyTransfer(values, n.context, n.context.genesis)).toEqual(n.advance);
});

it('rejects arbitrary destinations, unknown fields, invalid offsets and another context before serving', () => {
  for (const value of [{ ...request(), endpoint: 'wss://attacker.example/' }, { ...request(), index: 1 }, { ...request(), index: -1 },
    { ...request(), index: ADMISSION_POLICY_MAX_CHUNKS }, { ...request(), contextId: 'sha256:' + 'a'.repeat(64) }]) {
    expect(() => parseAdmissionPolicyChunkRequest(value, n.context)).toThrow();
  }
  expect(() => artifact.chunk({ ...request(), artifact: 'a'.repeat(64) })).toThrow();
});

it('refuses oversized, noncanonical, missing, repeated, reordered and mixed fragments', async () => {
  const values = chunks(), first = values[0];
  for (const changed of [{ ...first, bytes: 1e9 }, { ...first, count: 1e9 }, { ...first, data: first.data + '=' }, { ...first, data: first.data.slice(1) },
    { ...first, index: 1 }, { ...first, next: { ...first.next, revision: first.next.revision + 1 } }]) {
    expect(() => parseAdmissionPolicyChunkReply(changed, request(), n.context)).toThrow();
  }
  for (const changed of [values.slice(1), [values[0], ...values], [...values].reverse(), values.map((v, i) => i ? v : { ...v, artifact: 'a'.repeat(64) }),
    values.map((v, i) => i ? v : { ...v, next: { ...v.next, transition: 'b'.repeat(64) } })]) {
    await expect(assembleAdmissionPolicyTransfer(changed, n.context, n.context.genesis)).rejects.toThrow();
  }
});

it('does not trust a self-consistent transfer digest instead of authority authentication', async () => {
  const values = chunks(), bytes = Buffer.concat(values.map(v => Buffer.from(v.data, 'base64url')));
  const raw = JSON.parse(bytes.toString('utf8')); raw.policy.signature = 'A'.repeat(raw.policy.signature.length);
  const changed = Buffer.from(JSON.stringify(raw)), id = createHash('sha256').update(changed).digest('hex');
  expect(changed.length).toBe(bytes.length);
  const forged = values.map(v => ({ ...v, artifact: id, data: changed.subarray(v.index * 65536, (v.index + 1) * 65536).toString('base64url') }));
  await expect(assembleAdmissionPolicyTransfer(forged, n.context, n.context.genesis)).rejects.toThrow();
});

it('bounds evidence frames and binds every fragment to its exact original-genesis or historical-page request', async () => {
  const { createAdmissionPolicyEvidenceRequest, createAdmissionPolicyEvidenceReply, assembleAdmissionPolicyEvidence, parseAdmissionPolicyEvidenceRequest, parseAdmissionPolicyEvidenceReply } = await import('../admission-policy-transfer.js');
  const original = createAdmissionPolicyEvidenceRequest(n.context, 'genesis', n.context.genesis);
  const bytes = Buffer.from(JSON.stringify(n.first));
  const first = createAdmissionPolicyEvidenceReply(bytes, original, n.context);
  const parts = Array.from({ length: first.count }, (_, index) => createAdmissionPolicyEvidenceReply(bytes, { ...original, index }, n.context));
  expect(Buffer.from(assembleAdmissionPolicyEvidence(parts, original, n.context))).toEqual(bytes);
  expect(() => parseAdmissionPolicyEvidenceRequest({ ...original, head: n.advance.commitment.next }, n.context)).toThrow('pinned genesis');
  expect(() => parseAdmissionPolicyEvidenceRequest({ ...original, endpoint: 'wss://attacker.example/' }, n.context)).toThrow();
  expect(() => parseAdmissionPolicyEvidenceRequest({ ...original, index: 8 }, n.context)).toThrow();
  expect(() => parseAdmissionPolicyEvidenceReply({ ...first, data: first.data + '=' }, original, n.context)).toThrow();
  const page = createAdmissionPolicyEvidenceRequest(n.context, 'page', n.advance.commitment.next, 'sha256:' + 'a'.repeat(64));
  expect(() => parseAdmissionPolicyEvidenceReply(first, page, n.context)).toThrow();
  expect(() => assembleAdmissionPolicyEvidence(parts.slice(1), original, n.context)).toThrow();
  expect(() => assembleAdmissionPolicyEvidence([...parts].reverse(), original, n.context)).toThrow();
});
