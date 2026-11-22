import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, appendFileSync: vi.fn(fs.appendFileSync) };
});
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createLeasedIndexWithdrawalV1,
  createOfflineDiscoveryAckV1,
  createOfflineDiscoveryDepositV1,
  createOfflineDiscoveryRequestV1,
  createOriginalCommitmentV1,
  encryptOfflineDiscoveryRequestV1,
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateSigningKeyPair,
  offlineDiscoveryAdmissionBindingV1,
  serializeLeasedIndexOperationV1,
  serializeOfflineDiscoveryAckV1,
  serializeOfflineDiscoveryDepositV1,
  verifyOfflineDiscoveryReceiptForDepositV1,
  OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES,
  OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES,
  type AdmissionCapabilityV2,
  type LeasedIndexV1,
  type OfflineDiscoveryDepositV1,
  type OfflineDiscoveryRequestV1,
} from '@resonance/core';
import { MailboxGenerationStore } from '../mailbox-generation-store.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const ADMISSION: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'fixed-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

function fixture() {
  const keys = generateLeasedIndexKeyMaterialV1();
  const commitment = createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1());
  const makeIndex = (leaseSequence: number) => createLeasedIndexV1({
    leaseSequence,
    semanticRevision: 0,
    groupId: 'public',
    itemType: 'need',
    derivationId: 'fixed-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(1),
    originalCommitment: commitment,
    createdAt: NOW + leaseSequence * 1_000,
    expiresAt: NOW + 7 * DAY + leaseSequence * 1_000,
  }, keys);
  const indexes = [makeIndex(0), makeIndex(1), makeIndex(2)];
  const sender = generateSigningKeyPair();
  const input = {
    requestNonce: new Uint8Array(16).fill(7),
    createdAt: NOW,
    expiresAt: NOW + DAY,
    payload: 'fixed offline request',
    replyCapability: 'reply-capability',
  };
  return { keys, indexes, sender, input };
}

function depositFor(
  index: LeasedIndexV1,
  sender: ReturnType<typeof generateSigningKeyPair>,
  input: Parameters<typeof createOfflineDiscoveryRequestV1>[0],
  previous?: { request: OfflineDiscoveryRequestV1; deposit: OfflineDiscoveryDepositV1 },
) {
  const request = createOfflineDiscoveryRequestV1({
    ...input,
    ...(previous ? {
      previousGenerationId: previous.request.generationId,
      previousEnvelopeId: previous.deposit.envelopeId,
    } : {}),
  }, index, sender);
  const deposit = createOfflineDiscoveryDepositV1(encryptOfflineDiscoveryRequestV1(request), request, sender);
  return { request, deposit, raw: serializeOfflineDiscoveryDepositV1(deposit) };
}

function environment() {
  const fixtureValue = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'resonance-generation-mailbox-'));
  directories.push(directory);
  let current = fixtureValue.indexes[0];
  const historical = new Map(fixtureValue.indexes.map(index => [
    generation(index), index,
  ]));
  let expectedBinding: string | undefined;
  let admissionCalls = 0;
  const relayIdentity = generateIdentity();
  const options = {
    directory,
    relayIdentity,
    currentIndex: () => current,
    indexForGeneration: (id: string) => historical.get(id),
    verifyAdmission: (_capability: AdmissionCapabilityV2, binding: string) => {
      admissionCalls++;
      return expectedBinding === undefined || binding === expectedBinding;
    },
  };
  const store = new MailboxGenerationStore(options);
  return {
    ...fixtureValue,
    directory,
    options,
    relayIdentity,
    store,
    setCurrent(index: LeasedIndexV1) { current = index; },
    expectDeposit(deposit: OfflineDiscoveryDepositV1) { expectedBinding = offlineDiscoveryAdmissionBindingV1(deposit); },
    admissionCalls: () => admissionCalls,
  };
}

function generation(index: LeasedIndexV1): string {
  return createLeasedIndexGenerationIdV1(index);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('durable generation mailbox deposits', () => {
  it('stores exact encrypted bytes, replays without another spend, and restores after restart', () => {
    const env = environment();
    const value = depositFor(env.indexes[0], env.sender, env.input);
    env.expectDeposit(value.deposit);
    const stored = env.store.deposit(value.raw, ADMISSION, NOW);
    expect(stored.status).toBe('stored');
    expect(stored.receipt && verifyOfflineDiscoveryReceiptForDepositV1(stored.receipt, value.deposit)).toBe(true);
    const quota = env.store.quota(env.indexes[0].clientLeaseId);
    const journal = readFileSync(join(env.directory, 'generation-mailbox.ndjson'), 'utf8');

    const duplicate = env.store.deposit(value.raw, ADMISSION, NOW);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.receipt?.status).toBe('already-stored');
    expect(env.store.quota(env.indexes[0].clientLeaseId)).toEqual(quota);
    expect(readFileSync(join(env.directory, 'generation-mailbox.ndjson'), 'utf8')).toBe(journal);
    expect(env.admissionCalls()).toBe(1);

    const reopened = new MailboxGenerationStore(env.options);
    expect(reopened.deposit(value.raw, ADMISSION, NOW).status).toBe('duplicate');
    expect(reopened.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([value.raw]);
    expect(reopened.quota(env.indexes[0].clientLeaseId)).toEqual(quota);
  });

  it('retains and quarantines a changed-ciphertext conflict without ID-only dedup', () => {
    const env = environment();
    const first = depositFor(env.indexes[0], env.sender, env.input);
    const conflict = depositFor(env.indexes[0], env.sender, env.input);
    env.store.deposit(first.raw, ADMISSION, NOW);
    expect(conflict.raw).not.toBe(first.raw);
    const result = env.store.deposit(conflict.raw, ADMISSION, NOW);
    expect(result.status).toBe('conflicting_request');
    expect(result.conflictBytes).toBe(conflict.raw);
    expect(env.store.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);
    const journal = readFileSync(join(env.directory, 'generation-mailbox.ndjson'), 'utf8');
    const third = depositFor(env.indexes[0], env.sender, env.input);
    const thirdResult = env.store.deposit(third.raw, ADMISSION, NOW);
    expect(thirdResult.status).toBe('conflicting_request');
    expect(thirdResult.conflictBytes).toBe(conflict.raw);
    expect(readFileSync(join(env.directory, 'generation-mailbox.ndjson'), 'utf8')).toBe(journal);

    const reopened = new MailboxGenerationStore(env.options);
    expect(reopened.deposit(conflict.raw, ADMISSION, NOW).status).toBe('conflicting_request');
    expect(reopened.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);

    const repairDirectory = mkdtempSync(join(tmpdir(), 'resonance-generation-mailbox-'));
    directories.push(repairDirectory);
    const repaired = new MailboxGenerationStore({ ...env.options, directory: repairDirectory });
    repaired.repairFrom(env.store, env.indexes[0].clientLeaseId, NOW);
    expect(repaired.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);
    expect(repaired.deposit(conflict.raw, ADMISSION, NOW).status).toBe('conflicting_request');
  });

  it('reopens safely after a torn journal suffix', () => {
    const env = environment();
    const value = depositFor(env.indexes[0], env.sender, env.input);
    env.store.deposit(value.raw, ADMISSION, NOW);
    const path = join(env.directory, 'generation-mailbox.ndjson');
    appendFileSync(path, '{"sequence":99');

    const reopened = new MailboxGenerationStore(env.options);
    expect(reopened.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([value.raw]);
    expect(reopened.deposit(value.raw, ADMISSION, NOW).status).toBe('duplicate');
  });

  it('replays an exact admission after a crash between admission and deposit append', () => {
    const env = environment();
    const value = depositFor(env.indexes[0], env.sender, env.input);
    const defaultAppend = vi.mocked(appendFileSync).getMockImplementation()!;
    vi.mocked(appendFileSync)
      .mockImplementationOnce(defaultAppend)
      .mockImplementationOnce(() => { throw new Error('injected deposit append failure'); });

    expect(() => env.store.deposit(value.raw, ADMISSION, NOW)).toThrow('injected deposit append failure');
    expect(() => env.store.deposit(value.raw, ADMISSION, NOW)).toThrow('reopen');
    const reopened = new MailboxGenerationStore(env.options);
    expect(reopened.quota(env.indexes[0].clientLeaseId).logicalRequests).toBe(0);
    expect(reopened.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);
    expect(reopened.deposit(value.raw, ADMISSION, NOW).status).toBe('stored');
    expect(reopened.quota(env.indexes[0].clientLeaseId).logicalRequests).toBe(1);
    expect(reopened.deposit(value.raw, ADMISSION, NOW).status).toBe('duplicate');
    expect(reopened.quota(env.indexes[0].clientLeaseId).logicalRequests).toBe(1);
  });
});

describe('generation drain and observed-remove ACKs', () => {
  it('allows active plus one draining generation, then requires old ACK before a third', () => {
    const env = environment();
    const first = depositFor(env.indexes[0], env.sender, env.input);
    const second = depositFor(env.indexes[1], env.sender, env.input, first);
    const third = depositFor(env.indexes[2], env.sender, env.input, second);
    env.store.deposit(first.raw, ADMISSION, NOW);
    env.setCurrent(env.indexes[1]);
    expect(env.store.deposit(second.raw, ADMISSION, NOW + 1_000).status).toBe('stored');
    env.setCurrent(env.indexes[2]);
    expect(env.store.deposit(third.raw, ADMISSION, NOW + 2_000).status).toBe('drain_required');
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.expiresAt).toBe(first.request.expiresAt);
    expect(second.deposit.envelopeId).not.toBe(first.deposit.envelopeId);

    const oldAck = createOfflineDiscoveryAckV1(first.request, env.indexes[0], env.keys, NOW + 2_000);
    expect(env.store.acknowledge(serializeOfflineDiscoveryAckV1(oldAck), NOW + 2_000).status).toBe('acknowledged');
    expect(env.store.fetch(env.indexes[0].mailbox.id, NOW + 2_000)).toEqual([second.raw]);
    expect(env.store.deposit(third.raw, ADMISSION, NOW + 2_000).status).toBe('stored');
    expect(env.store.acknowledge(serializeOfflineDiscoveryAckV1(oldAck), NOW + 2_000).status).toBe('duplicate');
    expect(env.store.fetch(env.indexes[0].mailbox.id, NOW + 2_000).sort()).toEqual([second.raw, third.raw].sort());
  });

  it('refuses unknown ACKs but accepts signed ACK-before-deposit replica evidence', () => {
    const env = environment();
    const value = depositFor(env.indexes[0], env.sender, env.input);
    const ack = createOfflineDiscoveryAckV1(value.request, env.indexes[0], env.keys, NOW + 1);
    const ackBytes = serializeOfflineDiscoveryAckV1(ack);
    expect(env.store.acknowledge(ackBytes, NOW + 1).status).toBe('unknown_ack');
    expect(env.store.deposit(value.raw, ADMISSION, NOW).status).toBe('stored');

    const otherDirectory = mkdtempSync(join(tmpdir(), 'resonance-generation-mailbox-'));
    directories.push(otherDirectory);
    const otherOptions = { ...env.options, directory: otherDirectory };
    const other = new MailboxGenerationStore(otherOptions);
    const result = other.applySyncEvent({
      kind: 'ack',
      ack,
      deposit: value.deposit,
      admission: ADMISSION,
    }, NOW + 1);
    expect(result.status).toBe('acknowledged');
    expect(other.deposit(value.raw, ADMISSION, NOW).status).toBe('duplicate');
    other.compact(NOW + 1);
    const reopened = new MailboxGenerationStore(otherOptions);
    expect(reopened.deposit(value.raw, ADMISSION, NOW).status).toBe('duplicate');
    expect(reopened.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);
  });

  it('suppresses every generation after withdrawal, including withdrawal-before-deposit', () => {
    const env = environment();
    const value = depositFor(env.indexes[0], env.sender, env.input);
    const withdrawal = createLeasedIndexWithdrawalV1(env.indexes[0], env.keys, NOW + 1);
    expect(env.store.withdraw(withdrawal).status).toBe('acknowledged');
    expect(env.store.deposit(value.raw, ADMISSION, NOW).status).toBe('withdrawn');
    const reopened = new MailboxGenerationStore(env.options);
    expect(reopened.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);
    expect(reopened.deposit(value.raw, ADMISSION, NOW).status).toBe('withdrawn');
  });
});

describe('admission, replication, and quota', () => {
  it('rejects wrong admission/current-index evidence before mutation and propagates valid evidence', () => {
    const env = environment();
    const value = depositFor(env.indexes[0], env.sender, env.input);
    env.expectDeposit(value.deposit);
    expect(env.store.deposit(value.raw, ADMISSION, NOW).status).toBe('stored');

    const targetDirectory = mkdtempSync(join(tmpdir(), 'resonance-generation-mailbox-'));
    directories.push(targetDirectory);
    const target = new MailboxGenerationStore({
      ...env.options,
      directory: targetDirectory,
      verifyAdmission: (capability, binding) => capability.requestProof === ADMISSION.requestProof
        && binding === offlineDiscoveryAdmissionBindingV1(value.deposit),
    });
    const rejected = target.applySyncEvent({ kind: 'deposit', deposit: value.deposit, admission: {
      ...ADMISSION,
      requestProof: 'C'.repeat(43),
    } }, NOW);
    expect(rejected.status).toBe('admission_rejected');
    expect(target.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);
    const repaired = target.repairFrom(env.store, env.indexes[0].clientLeaseId, NOW);
    expect(repaired).toBe(1);
    expect(target.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([value.raw]);
  });

  it('enforces configured bytes and refuses lowering below obligations', () => {
    const env = environment();
    env.store.setQuotaLimits(env.indexes[0].clientLeaseId, {
      maxLogicalRequests: 16,
      maxInclusiveBytes: OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES + 1,
    });
    const value = depositFor(env.indexes[0], env.sender, env.input);
    expect(env.store.deposit(value.raw, ADMISSION, NOW).status).toBe('byte_limit');
    expect(env.store.fetch(env.indexes[0].mailbox.id, NOW)).toEqual([]);

    const normal = environment();
    const normalValue = depositFor(normal.indexes[0], normal.sender, normal.input);
    expect(normal.store.deposit(normalValue.raw, ADMISSION, NOW).status).toBe('stored');
    expect(() => normal.store.setQuotaLimits(normal.indexes[0].clientLeaseId, {
      maxLogicalRequests: 0,
      maxInclusiveBytes: 4 * 1024 * 1024,
    })).toThrow('below accepted obligations');
    const before = normal.store.quota(normal.indexes[0].clientLeaseId);
    expect(normal.store.deposit(normalValue.raw, ADMISSION, NOW).status).toBe('duplicate');
    expect(normal.store.quota(normal.indexes[0].clientLeaseId)).toEqual(before);
  });

  it('refuses the 17th logical request while exact replay and prepaid ACK maintenance remain free', () => {
    const env = environment();
    const values = Array.from({ length: 17 }, (_, index) => depositFor(
      env.indexes[0],
      generateSigningKeyPair(),
      {
        ...env.input,
        requestNonce: new Uint8Array(16).fill(index),
        payload: `fixed request ${index}`,
      },
    ));
    for (const value of values.slice(0, 16)) {
      expect(env.store.deposit(value.raw, ADMISSION, NOW).status).toBe('stored');
    }
    const full = env.store.quota(env.indexes[0].clientLeaseId);
    expect(full.logicalRequests).toBe(16);
    expect(full.reservedBytes).toBe(3_624_960);
    expect(full.headroomBytes).toBeGreaterThanOrEqual(569_344);
    expect(env.store.deposit(values[16].raw, ADMISSION, NOW).status).toBe('request_limit');
    expect(env.store.quota(env.indexes[0].clientLeaseId)).toEqual(full);

    expect(env.store.deposit(values[0].raw, ADMISSION, NOW).status).toBe('duplicate');
    const ack = createOfflineDiscoveryAckV1(values[0].request, env.indexes[0], env.keys, NOW + 1);
    expect(env.store.acknowledge(serializeOfflineDiscoveryAckV1(ack), NOW + 1).status).toBe('acknowledged');
    expect(env.store.quota(env.indexes[0].clientLeaseId)).toEqual(full);
  });
});
