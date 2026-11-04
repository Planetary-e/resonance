import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';
import { expect, it } from 'vitest';
import { withAdmissionReplayValues } from '@resonance/core';
import { decodePolicyProofReplayRecord, createAdmissionPolicyHistoryProof, createPolicyProofReplayHistory, type PolicyProofOperation } from '../admission-policy-history-proof.js';
import { createOriginalReferenceWorkBudget } from '../admission-original-references.js';
import { AdmissionPolicyArchiveBudget, AdmissionPolicyArchiveExecutionContext, admissionPolicyProofReference, admissionPolicyArchivePageDigest } from '@resonance/core/admission-policy-archive';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

function fixture(maxPageReads = 10) {
  const h = historyCheckpointFixture();
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: h.context.authority,
    genesis: { revision: 1, digest: '0'.repeat(64), transition: '0'.repeat(64) }, quorum: 4,
    members: h.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${35000+i}/` })) });
  const limits = { maxPages: 10, maxEntries: 100, maxArchiveBytes: 1024*1024, maxHistoryBytes: 1024*1024,
    maxTransitions: 10, maxPageReads, timeoutMs: 3000 };
  const reference = admissionPolicyProofReference(context, context.genesis, limits);
  const page = Buffer.from('exact retained original page'), digest = admissionPolicyArchivePageDigest(page);
  const value = { policyProof: reference, policyProofAppend: { version: 1, kind: 'advance', advance: {},
    pages: [{ digest, data: page.toString('base64url') }] } };
  const block = sealHistoryCheckpoint({ context: h.context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from(JSON.stringify(value)), encryptionKey: h.key, signingKey: h.owner });
  const operation: PolicyProofOperation = { startup: new AdmissionPolicyArchiveExecutionContext({ timeoutMs: 3000 }), originalReferenceWork: createOriginalReferenceWorkBudget() };
  const blocks = [block]; let calls = 0;
  const history = (nextOperation = operation) => createPolicyProofReplayHistory({ shareDecodedRecords: true, source: () => { calls++; return blocks; }, context: h.context, encryptionKey: h.key, operation: nextOperation });
  return { h, blocks, reference, operation, page, digest, history, calls: () => calls };
}
const signal = () => new AbortController().signal;

it('authenticates the immutable replay prefix once and charges only actual new decoding work', async () => {
  const f = fixture(1), replay = f.history();
  try {
    const first = createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference });
    expect(await first.reader(f.digest, signal())).toEqual(f.page);
    const used = f.operation.originalReferenceWork!.usedBytes();
    for (let i = 0; i < 20; i++) {
      const page = await createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal());
      expect(page).toEqual(f.page); page.fill(0);
    }
    expect(f.calls()).toBe(1); expect(f.operation.originalReferenceWork!.usedBytes()).toBe(used);
    // No read-counter reset: the one actual read has exhausted this exact allowance.
    expect(() => first.budget.charge('maxPageReads', 1)).toThrow(/maxPageReads/);
  } finally { replay.release(); }
});

it('copies source records, context and keys before awaits and isolates returned page mutation', async () => {
  const f = fixture(), replay = f.history();
  f.blocks[0].ciphertext = 'changed'; f.h.key.fill(0); f.h.context.members.reverse();
  try {
    const proof = createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference });
    expect(await proof.reader(f.digest, signal())).toEqual(f.page);
    expect(Object.isFrozen(replay.source())).toBe(true);
  } finally { replay.release(); }
});

it('does not publish a matching early page before authenticating a corrupt tail', async () => {
  const f = fixture();
  const bad = f.h.next(f.blocks[0], JSON.stringify({ policyProof: f.reference }), 'checkpoint');
  bad.ciphertext = bad.ciphertext.slice(0, -1) + (bad.ciphertext.endsWith('A') ? 'B' : 'A'); f.blocks.push(bad);
  const replay = f.history();
  try {
    const proof = createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference });
    await expect(proof.reader(f.digest, signal())).rejects.toThrow();
    await expect(proof.reader(f.digest, signal())).rejects.toThrow();
    expect(f.calls()).toBe(1);
  } finally { replay.release(); }
});

it('binds progress and its caches to the exact source, context, key and operation', async () => {
  const f = fixture(), replay = f.history();
  try {
    await createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal());
    for (const change of [{ source: () => f.blocks }, { operation: {} }, { encryptionKey: Buffer.alloc(32) },
      { context: { ...replay.context, historyId: Buffer.alloc(32).toString('base64url') } }]) {
      expect(() => createAdmissionPolicyHistoryProof({ ...replay, ...change, reference: f.reference })).toThrow(/replay/);
    }
    const charged = f.operation.budget!;
    f.operation.budget = new AdmissionPolicyArchiveBudget({ limits: f.reference.limits });
    expect(() => createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference })).toThrow(/scope changed/);
    f.operation.budget = charged;
    const changedFunding = admissionPolicyProofReference(f.reference.context, f.reference.head, { ...f.reference.limits, maxPageReads: 9 });
    expect(() => createAdmissionPolicyHistoryProof({ ...replay, reference: changedFunding })).toThrow(/funding bounds/);
    // A later operation cannot inherit this replay's authenticated records.
    f.blocks[0].ciphertext = 'corrupt'; const fresh = f.history({ startup: new AdmissionPolicyArchiveExecutionContext({ timeoutMs: 3000 }), originalReferenceWork: createOriginalReferenceWorkBudget() });
    try { await expect(createAdmissionPolicyHistoryProof({ ...fresh, reference: f.reference }).reader(f.digest, signal())).rejects.toThrow(); }
    finally { fresh.release(); }
  } finally { replay.release(); }
  expect([...replay.encryptionKey].every(byte => byte === 0)).toBe(true);
  expect(() => replay.source()).toThrow(/released/);
  expect(() => createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference })).toThrow(/replay/);
});

it('retains deadline/cancellation checks even when authenticated progress is already available', async () => {
  const f = fixture(), replay = f.history(), abort = new AbortController();
  try {
    const proof = createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference });
    await proof.reader(f.digest, signal()); abort.abort();
    await expect(proof.reader(f.digest, abort.signal)).rejects.toThrow();
    const timed = new AdmissionPolicyArchiveExecutionContext({ timeoutMs: 3000 }); timed.controller.abort();
    expect(() => createPolicyProofReplayHistory({ ...replay, operation: { startup: timed } })).toThrow();
  } finally { replay.release(); }
});

it('keeps the same real read cap for a newly encountered tail and does not hide a missing page', async () => {
  const f = fixture(1); f.blocks.push(f.h.next(f.blocks[0], JSON.stringify({ policyProof: f.reference }), 'checkpoint'));
  const replay = f.history();
  try { await expect(createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal())).rejects.toThrow(/maxPageReads/); }
  finally { replay.release(); }
  const g = fixture(), missing = g.history();
  try { await expect(createAdmissionPolicyHistoryProof({ ...missing, reference: g.reference }).reader('sha256:'+'a'.repeat(64), signal())).rejects.toThrow(/absent/); }
  finally { missing.release(); }
});


it('shares exactly one immutable decoded occurrence with proof lookahead while preserving actual work charges', async () => {
  const f = fixture();
  await withAdmissionReplayValues({ check: () => f.operation.startup!.check(), charge: n => f.operation.originalReferenceWork!.charge(n) }, async () => {
    const replay = f.history();
    try {
      const block = [...replay.source()][0];
      const raw = decodePolicyProofReplayRecord(replay, 0, block) as Record<string, any>;
      const used = f.operation.originalReferenceWork!.usedBytes();
      expect(used).toBeGreaterThan(Buffer.byteLength(JSON.stringify(raw)));
      expect(Object.isFrozen(raw)).toBe(true); expect(Object.isFrozen(raw.policyProof)).toBe(true);
      expect(() => { raw.policyProof.head.revision = 999; }).toThrow();
      await expect(createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal())).resolves.toEqual(f.page);
      // Metadata parsers may actually copy small fields; the full record is reused by identity.
      expect(decodePolicyProofReplayRecord(replay, 0, block)).toBe(raw);
      expect(f.operation.originalReferenceWork!.usedBytes()).toBeGreaterThanOrEqual(used);
      for (const substitute of [{ ...block }, [...replay.source()][1]]) {
        expect(() => decodePolicyProofReplayRecord(replay, 0, substitute!)).toThrow(/occurrence/);
      }
      expect(() => decodePolicyProofReplayRecord(replay, 1, block)).toThrow(/occurrence/);
      for (const changed of [{ operation: {} }, { encryptionKey: Buffer.alloc(32) }, { source: () => [block] }]) {
        expect(() => decodePolicyProofReplayRecord({ ...replay, ...changed }, 0, block)).toThrow(/changed/);
      }
    } finally { replay.release(); }
  });
});

it('refuses a missing middle and duplicate future tail after an already decoded valid prefix', async () => {
  for (const damage of ['gap', 'duplicate'] as const) {
    const f = fixture(), middle = f.h.next(f.blocks[0], JSON.stringify({ policyProof: f.reference }), 'checkpoint');
    const tail = f.h.next(middle, JSON.stringify({ policyProof: f.reference }), 'checkpoint');
    f.blocks.push(...(damage === 'gap' ? [tail] : [middle, middle]));
    const replay = f.history();
    try {
      const first = [...replay.source()][0]; decodePolicyProofReplayRecord(replay, 0, first);
      await expect(createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal())).rejects.toThrow(/tail/);
    } finally { replay.release(); }
  }
});

it('releases an in-flight proof load and forbids detached value-owner reuse', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.blocks.push(f.h.next(f.blocks.at(-1)!, JSON.stringify({ policyProof: f.reference }), 'checkpoint'));
  const replay = f.history();
  const pending = createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal());
  replay.release(); await expect(pending).rejects.toThrow();
  expect(() => replay.source()).toThrow(/released/); expect([...replay.encryptionKey].every(n => n === 0)).toBe(true);
});

it('keeps cumulative work across distinct owned histories and refuses before a second decode can escape', async () => {
  const f = fixture(); f.operation.originalReferenceWork = createOriginalReferenceWorkBudget(Buffer.byteLength(JSON.stringify(f.blocks[0])) + 1);
  const replay = f.history();
  try { await expect(createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal())).rejects.toThrow(/capacity/); }
  finally { replay.release(); }
  expect(() => f.history()).toThrow(/capacity/);
});

it('does not publish an earlier retained page before validating a malformed final continuation', async () => {
  const f = fixture();
  // Intentionally malformed authenticated-source shape: the reader must inspect
  // continuation occurrences even though they carry no encrypted business image.
  f.blocks.push({ version: 1, kind: 'continuation', generation: 1, sequence: 0, proposal: {} } as any);
  const replay = f.history();
  try {
    const proof = createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference });
    await expect(proof.reader(f.digest, signal())).rejects.toThrow();
    await expect(proof.reader(f.digest, signal())).rejects.toThrow();
  } finally { replay.release(); }
});


it('reads an earlier retained page through complete valid continuation tails', async () => {
  const n = await admissionRestoreFixture(false);
  const f = fixture(100);
  try {
    const parent = n.generations[1][0].read().envelopes.at(-1)!;
    const value = { policyProof: f.reference, policyProofAppend: { version: 1, kind: 'advance', advance: {}, pages: [{ digest: f.digest, data: f.page.toString('base64url') }] } };
    const block = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
      header: { kind: 'checkpoint', generation: parent.generation, sequence: parent.sequence + 1, previous: historyCheckpointEnvelopeId(parent) },
      plaintext: Buffer.from(JSON.stringify(value)) });
    n.generations[1].forEach(store => store.append(block)); await n.certify();
    const replay = createPolicyProofReplayHistory({ shareDecodedRecords: true, context: n.context, encryptionKey: n.key, operation: f.operation,
      source: () => n.replayOptions().blocks as Iterable<any> });
    try { await expect(createAdmissionPolicyHistoryProof({ ...replay, reference: f.reference }).reader(f.digest, signal())).resolves.toEqual(f.page); }
    finally { replay.release(); }
  } finally { await n.close(); }
});
