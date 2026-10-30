import { expect, it } from 'vitest';
import { createAdmissionOriginalReferences, createOriginalReferenceWorkBudget, originalReferenceWorkBudget, shareOriginalReferenceWorkBudget } from '../admission-original-references.js';
import { createPolicyObserverPageReader } from '../policy-observer-page-reader.js';
import { createAdmissionPolicyHistoryProof, type PolicyProofOperation } from '../admission-policy-history-proof.js';
import { admissionPolicyArchivePageDigest, admissionPolicyProofReference } from '@resonance/core/admission-policy-archive';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

it('nested operation identities share an allowance and cannot replace consumed work', () => {
  const caller = {}, child = {}, shared = originalReferenceWorkBudget(caller);
  shareOriginalReferenceWorkBudget(child, shared);
  originalReferenceWorkBudget(child).charge(100);
  expect(originalReferenceWorkBudget(caller).usedBytes()).toBe(100);
  expect(() => shareOriginalReferenceWorkBudget(child, createOriginalReferenceWorkBudget())).toThrow(/scope changed/);
});

it('shares one reconstruction allowance across replacement dictionaries without refund', () => {
  const value = { retained: 'original'.repeat(100) }, workBudget = createOriginalReferenceWorkBudget(2 * size(value));
  const first = createAdmissionOriginalReferences('context', { workBudget });
  const wire = first.encode(value, null);
  expect(first.accept(wire, null)).toEqual(value);
  expect(createAdmissionOriginalReferences('context', { workBudget }).accept(wire, null)).toEqual(value);
  expect(() => createAdmissionOriginalReferences('context', { workBudget }).accept(wire, null)).toThrow(/cumulative capacity/);
  expect(workBudget.usedBytes()).toBe(2 * size(value));
});

it('retains a dictionary across independent operations while each operation keeps its own cumulative bound', () => {
  const value = { retained: 'original'.repeat(100) }, bytes = size(value);
  const dictionary = createAdmissionOriginalReferences('context', { maxExpandedBytes: 2 * bytes });
  const wire = dictionary.encode(value, null);
  let retainedBytes = 0;
  for (let operation = 0; operation < 300; operation++) {
    const workBudget = createOriginalReferenceWorkBudget(2 * bytes);
    expect(dictionary.accept(wire, null, undefined, workBudget)).toEqual(value);
    expect(dictionary.accept(wire, null, undefined, workBudget)).toEqual(value);
    expect(() => dictionary.accept(wire, null, undefined, workBudget)).toThrow(/cumulative capacity/);
    expect(workBudget.usedBytes()).toBe(2 * bytes);
    if (operation === 0) retainedBytes = dictionary.usage().dictionaryBytes;
    expect(dictionary.usage().dictionaryBytes).toBe(retainedBytes);
  }
  expect(dictionary.usage().expandedBytes).toBe(600 * bytes);
});

it('charges repeated observer page scans to the same work budget while preserving physical accounting', async () => {
  const h = historyCheckpointFixture(), page = Buffer.from('original page'), digest = admissionPolicyArchivePageDigest(page);
  const value = { version: 2, archiveAppend: [{ digest, data: page.toString('base64url') }], retained: 'original'.repeat(100) };
  const workBudget = createOriginalReferenceWorkBudget(2 * size(value));
  const block = sealHistoryCheckpoint({ context: h.context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from(JSON.stringify(value)), encryptionKey: h.key, signingKey: h.owner });
  let reads = 0, physicalBytes = 0;
  const reader = createPolicyObserverPageReader({ source: () => [block], historyContext: h.context, key: h.key,
    maxBlocks: 10, maxBytes: 1024*1024, timeoutMs: 3000, workBudget,
    account: bytes => { reads++; physicalBytes += bytes; } });
  const signal = new AbortController().signal;
  expect(await reader(digest, signal)).toEqual(page);
  expect(await reader(digest, signal)).toEqual(page);
  await expect(reader(digest, signal)).rejects.toThrow(/cumulative capacity/);
  expect(reads).toBe(3); expect(physicalBytes).toBe(3 * size(block));
  expect(workBudget.usedBytes()).toBe(2 * size(value));
});

it('shares proof reconstruction work across images rescans and proof readers in one operation', async () => {
  const h = historyCheckpointFixture(), value = { retained: 'original'.repeat(100) };
  const block = sealHistoryCheckpoint({ context: h.context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from(JSON.stringify(value)), encryptionKey: h.key, signingKey: h.owner });
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: h.context.authority,
    genesis: { revision: 1, digest: '0'.repeat(64), transition: '0'.repeat(64) }, quorum: 4,
    members: h.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${35000+i}/` })) });
  const limits = { maxPages: 10, maxEntries: 100, maxArchiveBytes: 1024*1024, maxHistoryBytes: 1024*1024,
    maxTransitions: 10, maxPageReads: 10, timeoutMs: 3000 };
  const reference = admissionPolicyProofReference(context, context.genesis, limits);
  const operation: PolicyProofOperation = { originalReferenceWork: createOriginalReferenceWorkBudget(2 * size(value)) };
  let reads = 0;
  const options = { source: () => { reads++; return [block]; }, context: h.context, encryptionKey: h.key, reference, operation };
  const first = createAdmissionPolicyHistoryProof(options), signal = new AbortController().signal;
  await expect(first.reader('sha256:'+'a'.repeat(64), signal)).rejects.toThrow(/absent/);
  await expect(first.reader('sha256:'+'a'.repeat(64), signal)).rejects.toThrow(/absent/);
  await expect(createAdmissionPolicyHistoryProof(options).reader('sha256:'+'a'.repeat(64), signal)).rejects.toThrow(/cumulative capacity/);
  expect(reads).toBe(3); expect(operation.originalReferenceWork!.usedBytes()).toBe(2 * size(value));
});
