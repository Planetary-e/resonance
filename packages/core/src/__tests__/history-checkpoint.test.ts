import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import {
  createHistoryFreeze, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest,
  openHistoryCheckpoint, parseHistoryCheckpointEnvelope, parseHistoryFreeze, sealHistoryCheckpoint,
  HISTORY_DELTA_MAX_PAYLOAD, type HistoryCheckpointContext,
} from '../history-checkpoint.js';

function fixture() {
  const owner = generateSigningKeyPair(), key = randomBytes(32);
  const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends',
    historyId: randomBytes(32).toString('base64url'), owner: Buffer.from(owner.publicKey).toString('base64url'),
    authority: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), policyDigest: historyDigest('policy'),
    members: Array.from({ length: 5 }, () => Buffer.from(generateSigningKeyPair().publicKey).toString('base64url')).sort(), quorum: 4 };
  const seal = (payload: Buffer) => sealHistoryCheckpoint({ context, encryptionKey: key, signingKey: owner, plaintext: payload,
    header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } });
  return { owner, key, context, seal };
}

it('authenticates opaque recoverable payloads and keeps owner key material unchanged', () => {
  const f = fixture(), secret = Buffer.from(f.owner.secretKey), originalKey = Buffer.from(f.key);
  const plaintext = Buffer.from('sensitive-spent-binding-and-permanent-denials'), envelope = f.seal(plaintext);
  expect(parseHistoryCheckpointEnvelope(envelope, f.context)).toEqual(envelope);
  expect(openHistoryCheckpoint(envelope, f.context, f.key)).toEqual(plaintext);
  expect(JSON.stringify(envelope)).not.toContain(plaintext.toString());
  expect(f.seal(plaintext).nonce).not.toBe(envelope.nonce);
  expect(historyCheckpointEnvelopeId(f.seal(plaintext))).not.toBe(historyCheckpointEnvelopeId(envelope));
  expect(() => openHistoryCheckpoint(envelope, f.context, randomBytes(32))).toThrow();
  expect(f.owner.secretKey).toEqual(new Uint8Array(secret)); expect(f.key).toEqual(originalKey);
});

it.each(['version', 'kind', 'contextId', 'generation', 'sequence', 'previous', 'nonce', 'ciphertext', 'tag', 'signature', 'extra'])
('rejects alteration of %s before exposing plaintext', field => {
  const f = fixture(), envelope = f.seal(Buffer.from('data'));
  const changes: Record<string, unknown> = { version: 2, kind: 'delta', contextId: historyDigest('foreign'), generation: 1,
    sequence: 1, previous: historyDigest('prior'), nonce: randomBytes(12).toString('base64url'),
    ciphertext: Buffer.from('evil').toString('base64url'), tag: randomBytes(16).toString('base64url'),
    signature: randomBytes(64).toString('base64url'), extra: true };
  expect(() => openHistoryCheckpoint({ ...envelope, [field]: changes[field] }, f.context, f.key)).toThrow();
});

it('binds owner, policy, membership and history pins and requires canonical encodings', () => {
  const f = fixture(), envelope = f.seal(Buffer.from('data'));
  for (const context of [
    { ...f.context, historyId: randomBytes(32).toString('base64url') },
    { ...f.context, owner: f.context.authority }, { ...f.context, authority: f.context.owner },
    { ...f.context, policyDigest: historyDigest('other-policy') },
    { ...f.context, members: [...f.context.members].reverse() },
    { ...f.context, members: Array(5).fill(f.context.members[0]) },
  ]) expect(() => parseHistoryCheckpointEnvelope(envelope, context)).toThrow();
  expect(() => parseHistoryCheckpointEnvelope({ ...envelope, nonce: envelope.nonce + '=' }, f.context)).toThrow();
  expect(() => parseHistoryCheckpointEnvelope({ ...envelope, ciphertext: envelope.ciphertext + '=' }, f.context)).toThrow();
  expect(() => sealHistoryCheckpoint({ context: f.context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from('data'), encryptionKey: f.key, signingKey: generateSigningKeyPair() })).toThrow('owner');
});

it('bounds incremental records and rejects empty or structurally impossible envelopes', () => {
  const f = fixture(), root = f.seal(Buffer.from('data'));
  const input = { context: f.context, encryptionKey: f.key, signingKey: f.owner,
    header: { kind: 'delta' as const, generation: 0, sequence: 1, previous: historyCheckpointEnvelopeId(root) } };
  const delta = sealHistoryCheckpoint({ ...input, plaintext: Buffer.alloc(HISTORY_DELTA_MAX_PAYLOAD, 1) });
  expect(openHistoryCheckpoint(delta, f.context, f.key).length).toBe(HISTORY_DELTA_MAX_PAYLOAD);
  expect(() => sealHistoryCheckpoint({ ...input, plaintext: Buffer.alloc(HISTORY_DELTA_MAX_PAYLOAD + 1) })).toThrow('capacity');
  expect(() => f.seal(Buffer.alloc(0))).toThrow('capacity');
  expect(() => sealHistoryCheckpoint({ ...input, header: { ...input.header, sequence: 0 }, plaintext: Buffer.from('x') })).toThrow('header');
  expect(() => parseHistoryCheckpointEnvelope({ ...delta, ciphertext: 'a'.repeat(HISTORY_DELTA_MAX_PAYLOAD * 2) }, f.context)).toThrow('size');
});

it('authenticates a strictly increasing owner-authorized generation barrier', () => {
  const f = fixture(), challenge = randomBytes(32).toString('base64url');
  const freeze = createHistoryFreeze(f.context, 0, 1, challenge, f.owner);
  expect(parseHistoryFreeze(freeze, f.context)).toEqual(freeze);
  expect(freeze.contextId).toBe(historyCheckpointContextId(f.context));
  for (const change of [{ challenge: randomBytes(32).toString('base64url') }, { nextGeneration: 2 }, { generation: 1 }]) {
    expect(() => parseHistoryFreeze({ ...freeze, ...change }, f.context)).toThrow();
  }
  expect(() => createHistoryFreeze(f.context, 1, 1, challenge, f.owner)).toThrow();
  expect(() => createHistoryFreeze(f.context, 1, 0, challenge, f.owner)).toThrow();
});
