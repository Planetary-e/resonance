import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from '../crypto.js';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
} from '../leased-index-v1.js';
import {
  MAX_OFFLINE_DISCOVERY_REQUEST_BYTES,
  MAX_OFFLINE_DISCOVERY_REQUEST_LIFETIME_MS,
  OFFLINE_DISCOVERY_FIXED_RESERVE,
  OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES,
  OFFLINE_DISCOVERY_HEADROOM_BYTES,
  OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES,
  OFFLINE_DISCOVERY_MAX_LOGICAL_REQUESTS,
  OFFLINE_DISCOVERY_MODELED_PEAK_BYTES,
  OFFLINE_DISCOVERY_REQUEST_RESERVE,
  OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES,
  OfflineDiscoveryQuotaLedgerV1,
  OfflineDiscoveryRequestReplayV1,
  createOfflineDiscoveryAckIdV1,
  createOfflineDiscoveryEnvelopeIdV1,
  createOfflineDiscoveryReplicaKeyV1,
  createOfflineDiscoveryRequestV1,
  isOfflineDiscoveryRequestActiveV1,
  parseOfflineDiscoveryRequestV1,
  serializeOfflineDiscoveryRequestV1,
  verifyOfflineDiscoveryRequestAgainstIndexV1,
  verifyOfflineDiscoveryRequestV1,
  type CreateOfflineDiscoveryRequestInputV1,
  type OfflineDiscoveryQuotaAdmissionV1,
} from '../offline-discovery-request-v1.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function requestFixture(sequence = 4) {
  const keys = generateLeasedIndexKeyMaterialV1();
  const originalCommitment = createOriginalCommitmentV1(
    new TextEncoder().encode('client-held original'),
    generateOriginalCommitmentKeyV1(),
  );
  const makeIndex = (leaseSequence: number) => createLeasedIndexV1({
    leaseSequence,
    semanticRevision: 0,
    groupId: 'community:test',
    itemType: 'need',
    derivationId: 'fixed-derivation-fixture-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(9),
    originalCommitment,
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, keys);
  const index = makeIndex(0);
  const refreshedIndex = makeIndex(1);
  const sender = generateSigningKeyPair();
  const input: CreateOfflineDiscoveryRequestInputV1 = {
    requestNonce: new Uint8Array(16).fill(sequence),
    createdAt: NOW,
    expiresAt: NOW + DAY,
    payload: `bounded request payload ${sequence}`,
    replyCapability: 'reply-capability-fixture',
  };
  const request = createOfflineDiscoveryRequestV1(input, index, sender);
  const refreshed = createOfflineDiscoveryRequestV1({
    ...input,
    previousGenerationId: createLeasedIndexGenerationIdV1(index),
    previousEnvelopeId: createOfflineDiscoveryEnvelopeIdV1(request),
  }, refreshedIndex, sender);
  return { keys, index, refreshedIndex, sender, input, request, refreshed };
}

function quotaAdmission(sequence: number): OfflineDiscoveryQuotaAdmissionV1 {
  const { request, refreshed } = requestFixture(sequence);
  return {
    requestId: request.requestId,
    replayBytes: new TextEncoder().encode(serializeOfflineDiscoveryRequestV1(request)),
    actualBytes: OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES,
    ackIds: [createOfflineDiscoveryAckIdV1(request), createOfflineDiscoveryAckIdV1(refreshed)],
  };
}

describe('offline request schema and generation identities', () => {
  it('round-trips a signed request and verifies every outer/index binding', () => {
    const { request, index } = requestFixture();

    expect(verifyOfflineDiscoveryRequestV1(request)).toBe(true);
    expect(verifyOfflineDiscoveryRequestAgainstIndexV1(request, index, NOW)).toBe(true);
    expect(parseOfflineDiscoveryRequestV1(serializeOfflineDiscoveryRequestV1(request))).toEqual(request);
    expect(createOfflineDiscoveryEnvelopeIdV1(request)).toMatch(/^env_[A-Za-z0-9_-]{86}$/);
    expect(createOfflineDiscoveryAckIdV1(request)).toMatch(/^oack_[A-Za-z0-9_-]{43}$/);
  });

  it('keeps logical identity and expiry stable while all storage identities change by generation', () => {
    const { request, refreshed, refreshedIndex } = requestFixture();

    expect(refreshed.requestId).toBe(request.requestId);
    expect(refreshed.createdAt).toBe(request.createdAt);
    expect(refreshed.expiresAt).toBe(request.expiresAt);
    expect(refreshed.generationId).not.toBe(request.generationId);
    expect(createOfflineDiscoveryEnvelopeIdV1(refreshed)).not.toBe(createOfflineDiscoveryEnvelopeIdV1(request));
    expect(createOfflineDiscoveryReplicaKeyV1(refreshed)).not.toEqual(createOfflineDiscoveryReplicaKeyV1(request));
    expect(createOfflineDiscoveryAckIdV1(refreshed)).not.toBe(createOfflineDiscoveryAckIdV1(request));
    expect(verifyOfflineDiscoveryRequestAgainstIndexV1(refreshed, refreshedIndex, NOW)).toBe(true);
    expect(verifyOfflineDiscoveryRequestAgainstIndexV1(request, refreshedIndex, NOW)).toBe(false);
  });

  it('rejects unknown fields, wrong signatures and changed stable or generation bindings', () => {
    const { request, refreshed, refreshedIndex } = requestFixture();
    const wrongSignature = createOfflineDiscoveryRequestV1({
      requestNonce: new Uint8Array(16).fill(8),
      createdAt: NOW,
      expiresAt: NOW + DAY,
      payload: 'another request',
      replyCapability: 'reply-capability-fixture',
    }, refreshedIndex, generateSigningKeyPair());

    expect(verifyOfflineDiscoveryRequestV1({ ...request, privateContact: 'address' })).toBe(false);
    expect(verifyOfflineDiscoveryRequestV1({ ...request, generationId: refreshed.generationId })).toBe(false);
    expect(verifyOfflineDiscoveryRequestV1({
      ...request,
      requestId: refreshed.requestId.slice(0, -1) + (refreshed.requestId.endsWith('A') ? 'B' : 'A'),
    })).toBe(false);
    expect(verifyOfflineDiscoveryRequestV1({ ...request, signature: wrongSignature.signature })).toBe(false);
    expect(() => parseOfflineDiscoveryRequestV1(JSON.stringify({ ...request, extra: true })))
      .toThrow('Invalid offline discovery request');
  });

  it('rejects malformed replacement links and cross-generation ACK substitution', () => {
    const { input, refreshedIndex, sender, request, refreshed } = requestFixture();

    expect(() => createOfflineDiscoveryRequestV1({
      ...input,
      previousGenerationId: createLeasedIndexGenerationIdV1(refreshedIndex),
      previousEnvelopeId: createOfflineDiscoveryEnvelopeIdV1(request),
    }, refreshedIndex, sender)).toThrow('Invalid offline discovery request input');
    expect(() => createOfflineDiscoveryRequestV1({
      ...input,
      previousGenerationId: request.generationId,
    }, refreshedIndex, sender)).toThrow('Invalid offline discovery request input');
    expect(createOfflineDiscoveryAckIdV1(request)).not.toBe(createOfflineDiscoveryAckIdV1(refreshed));
  });

  it('enforces absolute expiry, maximum lifetime, meaningful size and strict input bounds', () => {
    const { request, input, index, sender } = requestFixture();

    expect(isOfflineDiscoveryRequestActiveV1(request, NOW - 1)).toBe(false);
    expect(isOfflineDiscoveryRequestActiveV1(request, NOW)).toBe(true);
    expect(isOfflineDiscoveryRequestActiveV1(request, request.expiresAt)).toBe(false);
    expect(verifyOfflineDiscoveryRequestV1(request)).toBe(true);
    expect(() => createOfflineDiscoveryRequestV1({ ...input, expiresAt: NOW }, index, sender)).toThrow();
    expect(() => createOfflineDiscoveryRequestV1({
      ...input,
      expiresAt: NOW + MAX_OFFLINE_DISCOVERY_REQUEST_LIFETIME_MS + 1,
    }, index, sender)).toThrow();
    expect(() => createOfflineDiscoveryRequestV1({ ...input, payload: 'x'.repeat(2049) }, index, sender)).toThrow();
    expect(() => createOfflineDiscoveryRequestV1({ ...input, requestNonce: new Uint8Array(15) }, index, sender)).toThrow();
    expect(() => parseOfflineDiscoveryRequestV1(' '.repeat(MAX_OFFLINE_DISCOVERY_REQUEST_BYTES + 1))).toThrow();
  });
});

describe('offline request exact replay and retained conflicts', () => {
  it('deduplicates only exact full bytes and retains one bounded conflict', () => {
    const { request } = requestFixture();
    const replay = new OfflineDiscoveryRequestReplayV1();
    const canonical = serializeOfflineDiscoveryRequestV1(request);
    const alternateEncoding = JSON.stringify(request);

    expect(replay.submit(canonical, NOW).status).toBe('stored');
    const initialSize = replay.sizeBytes;
    expect(replay.submit(canonical, request.expiresAt).status).toBe('duplicate');
    expect(replay.sizeBytes).toBe(initialSize);
    const conflict = replay.submit(alternateEncoding, NOW);
    expect(conflict.status).toBe('conflicting_request');
    expect(conflict.conflictBytes).toEqual(new TextEncoder().encode(alternateEncoding));
    const conflictSize = replay.sizeBytes;
    expect(conflictSize).toBe(initialSize + new TextEncoder().encode(alternateEncoding).byteLength);
    expect(replay.submit(alternateEncoding, request.expiresAt).conflictBytes).toEqual(conflict.conflictBytes);
    expect(replay.sizeBytes).toBe(conflictSize);

    const third = replay.submit(`${canonical} `, NOW);
    expect(third.status).toBe('conflicting_request');
    expect(third.conflictBytes).toEqual(conflict.conflictBytes);
    expect(replay.sizeBytes).toBe(conflictSize);
  });

  it('separates refreshed generations and refuses invalid or expired mutations', () => {
    const { request, refreshed } = requestFixture();
    const replay = new OfflineDiscoveryRequestReplayV1();

    expect(replay.submit(serializeOfflineDiscoveryRequestV1(request), NOW).status).toBe('stored');
    expect(replay.submit(serializeOfflineDiscoveryRequestV1(refreshed), NOW).status).toBe('stored');
    const size = replay.sizeBytes;
    expect(() => replay.submit(JSON.stringify({ ...request, payload: 'tampered' }), NOW)).toThrow();
    expect(replay.sizeBytes).toBe(size);
    const expiredReplay = new OfflineDiscoveryRequestReplayV1();
    expect(expiredReplay.submit(serializeOfflineDiscoveryRequestV1(request), request.expiresAt).status).toBe('expired');
    expect(expiredReplay.sizeBytes).toBe(0);
  });
});

describe('inclusive offline discovery quota ledger', () => {
  it('charges every reserved component and reaches the reviewed two-generation peak', () => {
    expect(Object.values(OFFLINE_DISCOVERY_REQUEST_RESERVE).reduce((sum, value) => sum + value, 0))
      .toBe(OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES);
    expect(Object.values(OFFLINE_DISCOVERY_FIXED_RESERVE).reduce((sum, value) => sum + value, 0))
      .toBe(OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES);

    const ledger = new OfflineDiscoveryQuotaLedgerV1();
    const admissions = Array.from({ length: 16 }, (_, index) => quotaAdmission(index));
    for (const admission of admissions) expect(ledger.admit(admission).status).toBe('admitted');

    expect(ledger.snapshot()).toMatchObject({
      logicalRequests: 16,
      reservedBytes: OFFLINE_DISCOVERY_MODELED_PEAK_BYTES,
      actualBytes: 3_624_960,
      headroomBytes: OFFLINE_DISCOVERY_HEADROOM_BYTES,
    });
    expect(OFFLINE_DISCOVERY_MODELED_PEAK_BYTES).toBe(3_624_960);
    expect(OFFLINE_DISCOVERY_HEADROOM_BYTES).toBe(569_344);
  });

  it('refuses the 17th logical request even with byte headroom', () => {
    const ledger = new OfflineDiscoveryQuotaLedgerV1();
    for (let index = 0; index < OFFLINE_DISCOVERY_MAX_LOGICAL_REQUESTS; index++) {
      ledger.admit(quotaAdmission(index));
    }
    const before = ledger.snapshot();

    expect(ledger.admit(quotaAdmission(16)).status).toBe('request_limit');
    expect(ledger.snapshot()).toEqual(before);
  });

  it('enforces actual serialized bytes independently below the count cap', () => {
    const ledger = new OfflineDiscoveryQuotaLedgerV1();
    const first = quotaAdmission(0);
    first.actualBytes = OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES - OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES;
    expect(ledger.admit(first).status).toBe('admitted');
    expect(ledger.snapshot().logicalRequests).toBe(1);
    expect(ledger.snapshot().actualBytes).toBe(OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES);
    const before = ledger.snapshot();

    const second = quotaAdmission(1);
    second.actualBytes = 1;
    expect(ledger.admit(second).status).toBe('byte_limit');
    expect(ledger.snapshot()).toEqual(before);
  });

  it('allows exact duplicate and prepaid ACK/withdrawal maintenance at full quota without growth', () => {
    const ledger = new OfflineDiscoveryQuotaLedgerV1();
    const admissions = Array.from({ length: 16 }, (_, index) => quotaAdmission(index));
    for (const admission of admissions) ledger.admit(admission);
    const full = ledger.snapshot();

    expect(ledger.admit(admissions[0]).status).toBe('duplicate');
    expect(ledger.snapshot()).toEqual(full);
    expect(ledger.acknowledge(admissions[0].ackIds[0]).status).toBe('acknowledged');
    expect(ledger.acknowledge(admissions[0].ackIds[0]).status).toBe('duplicate');
    expect(ledger.acknowledge(admissions[0].ackIds[1]).status).toBe('acknowledged');
    expect(ledger.withdraw(admissions[0].requestId).status).toBe('withdrawn');
    expect(ledger.withdraw(admissions[0].requestId).status).toBe('duplicate');
    expect(ledger.snapshot()).toEqual(full);

    const changedRetry = { ...admissions[0], replayBytes: Uint8Array.from(admissions[0].replayBytes).reverse() };
    expect(ledger.admit(changedRetry).status).toBe('conflict');
    expect(ledger.snapshot()).toEqual(full);
  });

  it('refuses unknown ACKs and lowering limits below accepted obligations without mutation', () => {
    const ledger = new OfflineDiscoveryQuotaLedgerV1();
    const admission = quotaAdmission(0);
    ledger.admit(admission);
    const before = ledger.snapshot();

    expect(ledger.acknowledge(`oack_${'A'.repeat(43)}`).status).toBe('unknown_ack');
    expect(ledger.acknowledge('not-an-ack').status).toBe('unknown_ack');
    expect(ledger.snapshot()).toEqual(before);
    expect(() => ledger.setLimits({
      maxLogicalRequests: 0,
      maxInclusiveBytes: OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES,
    })).toThrow('below accepted obligations');
    expect(() => ledger.setLimits({
      maxLogicalRequests: 1,
      maxInclusiveBytes: before.reservedBytes - 1,
    })).toThrow('below accepted obligations');
    expect(ledger.snapshot()).toEqual(before);
  });

  it('does not permit configured limits above the fixed prototype caps', () => {
    expect(() => new OfflineDiscoveryQuotaLedgerV1({
      maxLogicalRequests: 17,
      maxInclusiveBytes: OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES,
    })).toThrow('Invalid offline discovery quota limits');
    expect(() => new OfflineDiscoveryQuotaLedgerV1({
      maxLogicalRequests: 16,
      maxInclusiveBytes: OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES + 1,
    })).toThrow('Invalid offline discovery quota limits');
  });
});
