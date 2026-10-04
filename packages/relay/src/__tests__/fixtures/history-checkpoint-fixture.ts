import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '@resonance/core';
import { historyDigest, sealHistoryCheckpoint, historyCheckpointEnvelopeId,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';

export function historyCheckpointFixture() {
  const owner = generateSigningKeyPair(), key = randomBytes(32), localKey = randomBytes(32);
  const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends',
    historyId: randomBytes(32).toString('base64url'), owner: Buffer.from(owner.publicKey).toString('base64url'),
    authority: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), policyDigest: historyDigest('test-policy'),
    members: Array.from({ length: 5 }, () => Buffer.from(generateSigningKeyPair().publicKey).toString('base64url')).sort(), quorum: 4 };
  const root = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from('{"spends":[],"retiredIssuerKeys":[]}'), encryptionKey: key, signingKey: owner });
  const next = (previous: HistoryCheckpointEnvelope, plaintext = 'a spent binding', kind: 'delta' | 'checkpoint' = 'delta') =>
    sealHistoryCheckpoint({ context, header: { kind, generation: previous.generation, sequence: previous.sequence + 1,
      previous: historyCheckpointEnvelopeId(previous) }, plaintext: Buffer.from(plaintext), encryptionKey: key, signingKey: owner });
  return { context, owner, key, localKey, root, next, options: { localKey, context, replica: context.members[0],
    rootId: historyCheckpointEnvelopeId(root), generation: 0 } };
}
