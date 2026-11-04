import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConsentOfferV2,
  createDeterministicMatchId,
  createMailboxDepositRequest,
  createMailboxRequest,
  createMatchNoticeMessage,
  createMatchOperationV2,
  createPublicationRecord,
  encryptMatchNotice,
  encryptRelationshipMessage,
  generateIdentity,
  generatePublicationKeyMaterial,
  generateRelationshipKeyMaterial,
  verifyMailboxRequest,
  type EncryptedMailboxEnvelope,
} from '@resonance/core';
import { compactMailboxHistory } from '../mailbox-journal-compaction.js';
import { MailboxStore } from '../mailbox-store.js';
import { RelayOperationLog, type RelayOperationLogEntry } from '../operation-log.js';

const NOW = 1_800_000_000_000;
const directories: string[] = [];

function fixture() {
  const aliceKeys = generatePublicationKeyMaterial();
  const bobKeys = generatePublicationKeyMaterial();
  const base = {
    groupId: 'public', fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0xa5),
    createdAt: NOW, expiresAt: NOW + 86_400_000,
  };
  const alice = createPublicationRecord({ ...base, itemType: 'offer' }, aliceKeys);
  const bob = createPublicationRecord({ ...base, itemType: 'need' }, bobKeys);
  return { alice, bob, aliceKeys, bobKeys };
}

function logAndStore() {
  const dir = mkdtempSync(join(tmpdir(), 'resonance-mailbox-compaction-'));
  directories.push(dir);
  const log = new RelayOperationLog(dir);
  log.load();
  return { log, store: new MailboxStore() };
}

type Records = Parameters<typeof compactMailboxHistory>[0];

/** Same mailbox effects as server replayOperation; expiry purge is last.
 * Optional per-row quota additionally checks transient replay memory. Production
 * verifies the final floor after replay/purge, not this stronger peak property. */
function replay(records: Records, now: number, quota?: number) {
  vi.setSystemTime(now);
  const store = new MailboxStore();
  let peakBytes = 0, peakEnvelopes = 0;
  const enqueue = (envelopes: readonly EncryptedMailboxEnvelope[]) => {
    if (quota !== undefined && !store.canEnqueue(envelopes, quota)) throw new Error('Replay mailbox capacity exceeded');
    envelopes.forEach(envelope => store.enqueue(envelope));
  };
  for (const { entry } of records) {
    if (entry.kind === 'match') enqueue(entry.envelopes);
    else if (entry.kind === 'mailbox-deposit') enqueue([entry.request.envelope]);
    else if (entry.kind === 'mailbox-ack') store.acknowledge(entry.request.mailboxId, entry.request.envelopeIds);
    else if (entry.kind === 'mailbox-replica-event') {
      if (entry.event.kind === 'envelope') enqueue([entry.event.envelope]);
      else store.applyReplicatedAcknowledgement(entry.event.mailboxId, entry.event.envelopeId, entry.event.expiresAt);
    }
    peakBytes = Math.max(peakBytes, store.commitmentFloorBytes);
    peakEnvelopes = Math.max(peakEnvelopes, store.envelopeCount);
  }
  store.purgeExpired(now);
  return { store, peakBytes, peakEnvelopes };
}

function signedMailboxFixture() {
  const { alice, bob, aliceKeys, bobKeys } = fixture();
  const matchId = createDeterministicMatchId(alice.publicationId, bob.publicationId);
  return { alice, bob, aliceKeys, bobKeys,
    envelope(expiresAt = NOW + 60_000) {
      return encryptRelationshipMessage(createConsentOfferV2(
        matchId, alice, bob, aliceKeys, generateRelationshipKeyMaterial(), NOW + 1, expiresAt,
      ), bob);
    },
    deposit(envelope: EncryptedMailboxEnvelope): RelayOperationLogEntry {
      return { kind: 'mailbox-deposit', request: createMailboxDepositRequest(matchId, alice, bob, aliceKeys, envelope, NOW + 2) };
    },
    acknowledge(envelopes: readonly EncryptedMailboxEnvelope[]): RelayOperationLogEntry {
      return { kind: 'mailbox-ack', request: createMailboxRequest('ack', bob, bobKeys, envelopes.map(e => e.envelopeId), NOW + 3) };
    },
  };
}

function records(...entries: RelayOperationLogEntry[]): Records {
  return entries.map(entry => ({ committedAt: NOW, entry }));
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mailbox journal compaction', () => {
  it('drops redundant signed ACK rows sharing an already acknowledged live ID', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const { alice, bob, aliceKeys, bobKeys } = fixture();
    const { log, store } = logAndStore();
    const matchId = createDeterministicMatchId(alice.publicationId, bob.publicationId);
    const envelope = (expiresAt: number) => encryptRelationshipMessage(createConsentOfferV2(
      matchId, alice, bob, aliceKeys, generateRelationshipKeyMaterial(), NOW + 1, expiresAt,
    ), bob);
    const long = envelope(NOW + 60_000);
    log.append({ kind: 'mailbox-deposit', request: createMailboxDepositRequest(matchId, alice, bob, aliceKeys, long, NOW + 2) });
    store.enqueue(long);
    const acknowledgements = [];
    for (let i = 0; i < 8; i++) {
      const short = envelope(NOW + 1000);
      log.append({ kind: 'mailbox-deposit', request: createMailboxDepositRequest(matchId, alice, bob, aliceKeys, short, NOW + 3 + i) });
      store.enqueue(short);
      const request = createMailboxRequest('ack', bob, bobKeys, [long.envelopeId, short.envelopeId], NOW + 20 + i);
      acknowledgements.push(request); log.append({ kind: 'mailbox-ack', request });
      store.acknowledge(request.mailboxId, request.envelopeIds);
    }
    vi.setSystemTime(NOW + 2000); store.purgeExpired();
    const retained = compactMailboxHistory(log.entries, store);
    expect(retained.filter(({ entry }) => entry.kind === 'mailbox-ack').map(({ entry }) => entry))
      .toEqual([{ kind: 'mailbox-ack', request: acknowledgements[0] }]);
    expect(retained.map(({ entry }) => entry.kind)).toEqual(['mailbox-deposit', 'mailbox-ack']);
    expect(replay(retained, NOW + 2000).store.events(bob.mailbox.id, NOW + 2000)).toEqual(store.events(bob.mailbox.id, NOW + 2000));
    for (const { entry } of retained) if (entry.kind === 'mailbox-ack') expect(verifyMailboxRequest(entry.request)).toBe(true);
    expect(compactMailboxHistory(retained, store)).toEqual(retained);
  });

  it('ignores an unknown ID in an earlier signed ACK and keeps its later causal removal', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), long = f.envelope(), short = f.envelope(NOW + 1000);
    const early = f.acknowledge([long, short]), causal = f.acknowledge([long]);
    const original = records(f.deposit(short), early, f.deposit(long), causal);
    const { store } = replay(original, NOW + 2000);
    const compacted = compactMailboxHistory(original, store);
    expect(compacted.map(record => record.entry)).toEqual([original[2].entry, causal]);
    expect(compacted[1]).toBe(original[3]);
    expect(replay(compacted, NOW + 2000).store.events(f.bob.mailbox.id, NOW + 2000)).toEqual(store.events(f.bob.mailbox.id, NOW + 2000));
  });

  it.each(['deposit', 'replica', 'match'] as const)('retains causal ACKs after %s introductions across repeated replay', kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), relay = generateIdentity();
    const operation = createMatchOperationV2(f.alice, f.bob, relay, { createdAt: NOW + 1, expiresAt: NOW + 60_000 });
    const notices: [EncryptedMailboxEnvelope, EncryptedMailboxEnvelope] = [
      encryptMatchNotice(createMatchNoticeMessage(f.alice, f.bob, operation, relay), f.alice),
      encryptMatchNotice(createMatchNoticeMessage(f.bob, f.alice, operation, relay), f.bob),
    ];
    const envelope = kind === 'match' ? notices[1] : f.envelope();
    const introduction: RelayOperationLogEntry = kind === 'match' ? { kind: 'match', operation, envelopes: notices }
      : kind === 'replica' ? { kind: 'mailbox-replica-event', publicationId: f.bob.publicationId, event: { kind: 'envelope', envelope } }
        : f.deposit(envelope);
    const first = f.acknowledge([envelope]), redundant = f.acknowledge([envelope]);
    const original = records(introduction, first, introduction, redundant);
    const { store } = replay(original, NOW + 4);
    const compacted = compactMailboxHistory(original, store);
    expect(compacted.filter(record => record.entry.kind === 'mailbox-ack').map(record => record.entry)).toEqual(kind === 'match' ? [first, redundant] : [first]);
    expect(compacted.every(record => original.includes(record))).toBe(true);
    expect(replay(compacted, NOW + 4).store.events(f.bob.mailbox.id, NOW + 4)).toEqual(store.events(f.bob.mailbox.id, NOW + 4));
    expect(compactMailboxHistory(compacted, store)).toEqual(compacted);
    // Both retained match rows enqueue expired notices on a later replay, so
    // both ACKs remain causal even though the second is redundant today.
    expect(replay(compacted, NOW + 90_000).store.events(f.bob.mailbox.id, NOW + 90_000)).toEqual([]);
  });

  it('preserves transient replay capacity across more than 100 envelopes instead of choosing the latest ACK', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), shared = f.envelope(), first = f.acknowledge([shared]);
    const entries = [f.deposit(shared), first];
    for (let i = 0; i < 111; i++) {
      const envelope = f.envelope();
      entries.push(f.deposit(envelope), f.acknowledge(i === 110 ? [shared, envelope] : [envelope]));
    }
    const original = records(...entries), before = replay(original, NOW + 4);
    const compacted = compactMailboxHistory(original, before.store);
    expect(compacted[1]).toBe(original[1]);
    expect(before.store.acknowledgedEnvelopeIds(NOW + 4).size).toBe(112);
    const restored = replay(compacted, NOW + 4, before.peakBytes);
    expect(restored.peakEnvelopes).toBe(1);
    expect(restored.store.events(f.bob.mailbox.id, NOW + 4)).toEqual(before.store.events(f.bob.mailbox.id, NOW + 4));
    expect(() => replay(compacted.filter(record => record !== original[1]), NOW + 4, before.peakBytes)).toThrow('Replay mailbox capacity exceeded');
  });

  it('keeps early replica removal plus the maximum extension without redundant intermediate proofs', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), first = f.envelope(), second = f.envelope();
    const replica = (expiresAt: number): RelayOperationLogEntry => ({ kind: 'mailbox-replica-event', publicationId: f.bob.publicationId,
      event: { kind: 'ack', mailboxId: first.mailboxId, envelopeId: first.envelopeId, expiresAt } });
    const early = replica(NOW + 10_000), maximum = replica(NOW + 90_000), intermediate = replica(NOW + 70_000);
    const original = records(f.deposit(first), early, f.deposit(second), maximum, intermediate, f.acknowledge([second]));
    const before = replay(original, NOW + 4), compacted = compactMailboxHistory(original, before.store);
    expect(compacted.map(record => record.entry)).toEqual([original[0].entry, early, original[2].entry, maximum, original[5].entry]);
    const restored = replay(compacted, NOW + 4, before.peakBytes);
    expect(restored.store.acknowledgementExpiry(first.mailboxId, first.envelopeId)).toBe(NOW + 90_000);
    expect(restored.store.events(f.bob.mailbox.id, NOW + 4)).toEqual(before.store.events(f.bob.mailbox.id, NOW + 4));
  });

  it('keeps an unknown-ID replica barrier before a duplicate introduction and a later maximum', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), envelope = f.envelope();
    const replica = (expiresAt: number): RelayOperationLogEntry => ({ kind: 'mailbox-replica-event', publicationId: f.bob.publicationId,
      event: { kind: 'ack', mailboxId: envelope.mailboxId, envelopeId: envelope.envelopeId, expiresAt } });
    const early = replica(NOW + 70_000), maximum = replica(NOW + 90_000);
    const original = records(early, f.deposit(envelope), f.acknowledge([envelope]), maximum);
    const before = replay(original, NOW + 4), compacted = compactMailboxHistory(original, before.store);
    expect(compacted.map(record => record.entry)).toEqual(original.map(record => record.entry));
    expect(replay(compacted, NOW + 4, before.peakBytes).peakEnvelopes).toBe(0);
  });

  it('retains the strongest preceding replica barrier for a future reopen and repeated compaction', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), first = f.envelope(NOW + 100_000), second = f.envelope(NOW + 100_000);
    const replica = (expiresAt: number): RelayOperationLogEntry => ({ kind: 'mailbox-replica-event', publicationId: f.bob.publicationId,
      event: { kind: 'ack', mailboxId: first.mailboxId, envelopeId: first.envelopeId, expiresAt } });
    const original = records(replica(NOW + 20_000), replica(NOW + 40_000), f.deposit(first), f.deposit(second), replica(NOW + 60_000));
    const current = replay(original, NOW + 10_000), compacted = compactMailboxHistory(original, current.store);
    expect(compacted).toContain(original[1]);
    expect(compactMailboxHistory(compacted, current.store)).toEqual(compacted);
    for (const offset of [30_000, 50_000, 70_000, 110_000]) {
      const later = NOW + offset, expected = replay(original, later), restored = replay(compacted, later, expected.peakBytes);
      expect(restored.peakEnvelopes).toBe(expected.peakEnvelopes);
      expect(restored.store.events(f.bob.mailbox.id, later)).toEqual(expected.store.events(f.bob.mailbox.id, later));
      const again = compactMailboxHistory(compacted, restored.store, later);
      expect(replay(again, later, expected.peakBytes).store.events(f.bob.mailbox.id, later)).toEqual(expected.store.events(f.bob.mailbox.id, later));
      expect(compactMailboxHistory(again, restored.store, later)).toEqual(again);
    }
  });

  it('keeps an ACK that becomes an early release after a preceding replica barrier expires', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = signedMailboxFixture(), first = f.envelope(NOW + 100_000), second = f.envelope(NOW + 100_000);
    const replica = (expiresAt: number): RelayOperationLogEntry => ({ kind: 'mailbox-replica-event', publicationId: f.bob.publicationId,
      event: { kind: 'ack', mailboxId: first.mailboxId, envelopeId: first.envelopeId, expiresAt } });
    const causal = f.acknowledge([first]);
    const original = records(replica(NOW + 20_000), f.deposit(first), causal, f.deposit(second), replica(NOW + 60_000));
    const current = replay(original, NOW + 10_000), compacted = compactMailboxHistory(original, current.store);
    expect(compacted).toContain(original[2]);
    const expected = replay(original, NOW + 30_000), restored = replay(compacted, NOW + 30_000, expected.peakBytes);
    expect(restored.peakEnvelopes).toBe(1);
    expect(restored.store.events(f.bob.mailbox.id, NOW + 30_000)).toEqual(expected.store.events(f.bob.mailbox.id, NOW + 30_000));
    expect(() => replay(compacted.filter(record => record !== original[2]), NOW + 30_000, expected.peakBytes))
      .toThrow('Replay mailbox capacity exceeded');
    const again = compactMailboxHistory(compacted, restored.store, NOW + 30_000);
    expect(replay(again, NOW + 30_000, expected.peakBytes).store.events(f.bob.mailbox.id, NOW + 30_000))
      .toEqual(expected.store.events(f.bob.mailbox.id, NOW + 30_000));
    expect(compactMailboxHistory(again, restored.store, NOW + 30_000)).toEqual(again);
  });

  it('keeps signed deposits and acknowledgements until deduplication expires', () => {
    const { alice, bob, aliceKeys, bobKeys } = fixture();
    const { log, store } = logAndStore();
    const matchId = createDeterministicMatchId(alice.publicationId, bob.publicationId);
    const offer = createConsentOfferV2(
      matchId, alice, bob, aliceKeys, generateRelationshipKeyMaterial(), NOW + 1, NOW + 60_000,
    );
    const envelope = encryptRelationshipMessage(offer, bob);
    const deposit = createMailboxDepositRequest(matchId, alice, bob, aliceKeys, envelope, NOW + 2);
    const acknowledgement = createMailboxRequest('ack', bob, bobKeys, [envelope.envelopeId], NOW + 3);
    log.append({ kind: 'mailbox-deposit', request: deposit });
    store.enqueue(envelope);
    log.append({ kind: 'mailbox-ack', request: acknowledgement });
    store.acknowledge(envelope.mailboxId, [envelope.envelopeId]);

    expect(compactMailboxHistory(log.entries, store, NOW + 4)).toHaveLength(2);
    store.purgeExpired(envelope.expiresAt);
    expect(compactMailboxHistory(log.entries, store, envelope.expiresAt)).toEqual([]);
  });

  it('retains acknowledgements for match notices that replay from signed match events', () => {
    const { alice, bob, bobKeys } = fixture();
    const { log, store } = logAndStore();
    const relay = generateIdentity();
    const operation = createMatchOperationV2(alice, bob, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 60_000,
    });
    const envelopes = [
      encryptMatchNotice(createMatchNoticeMessage(alice, bob, operation, relay), alice),
      encryptMatchNotice(createMatchNoticeMessage(bob, alice, operation, relay), bob),
    ] as const;
    const acknowledgement = createMailboxRequest(
      'ack', bob, bobKeys, [envelopes[1].envelopeId], NOW + 3,
    );
    log.append({ kind: 'match', operation, envelopes: [...envelopes] });
    for (const envelope of envelopes) store.enqueue(envelope);
    log.append({ kind: 'mailbox-ack', request: acknowledgement });
    store.acknowledge(envelopes[1].mailboxId, [envelopes[1].envelopeId]);

    expect(compactMailboxHistory(log.entries, store, NOW + 4).map(record => record.entry.kind))
      .toEqual(['match', 'mailbox-ack']);
    store.purgeExpired(NOW + 60_000);
    // Startup enqueues even expired match notices before its final purge. Keep
    // the causal ACK to release that transient replay capacity at its position.
    expect(compactMailboxHistory(log.entries, store, NOW + 60_000).map(record => record.entry.kind))
      .toEqual(['match', 'mailbox-ack']);
  });

  it('keeps the longest replicated acknowledgement after journal compaction', () => {
    const { alice, bob } = fixture();
    const { log, store } = logAndStore();
    const relay = generateIdentity();
    const operation = createMatchOperationV2(alice, bob, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 60_000,
    });
    const envelope = encryptMatchNotice(
      createMatchNoticeMessage(alice, bob, operation, relay), alice,
    );
    const expiries = [NOW + 60_000, NOW + 70_000, NOW + 65_000];
    for (const expiresAt of expiries) {
      const event = {
        kind: 'ack' as const, mailboxId: envelope.mailboxId,
        envelopeId: envelope.envelopeId, expiresAt,
      };
      log.append({ kind: 'mailbox-replica-event', publicationId: alice.publicationId, event });
      store.applyReplicatedAcknowledgement(event.mailboxId, event.envelopeId, event.expiresAt);
    }

    const compacted = compactMailboxHistory(log.entries, store, NOW + 2);
    expect(compacted).toHaveLength(1);
    const restored = new MailboxStore();
    for (const { entry } of compacted) {
      if (entry.kind === 'mailbox-replica-event' && entry.event.kind === 'ack') {
        restored.applyReplicatedAcknowledgement(
          entry.event.mailboxId, entry.event.envelopeId, entry.event.expiresAt,
        );
      }
    }
    expect(restored.acknowledgementExpiry(envelope.mailboxId, envelope.envelopeId))
      .toBe(NOW + 70_000);
  });
});
