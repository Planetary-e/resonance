import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import { historyDigest, historyCheckpointEnvelopeId, sealHistoryCheckpoint, type HistoryCheckpointContext } from '../history-checkpoint.js';
import { createHistoryCompactionProposal, createHistoryCompactionVote, type HistoryCompactionCertificate } from '../history-compaction.js';
import { createHistoryCompactionControlRequest, createHistoryCompactionControlResponse, historyCompactionCertificateId,
  parseHistoryCompactionControlFrame, parseHistoryCompactionControlRequest, parseHistoryCompactionControlResponse, type HistoryCompactionControlFrame } from '../history-compaction-control.js';

function fixture() {
  const owner = generateSigningKeyPair(), keys = Array.from({ length: 5 }, () => generateSigningKeyPair());
  const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends', historyId: randomBytes(32).toString('base64url'),
    owner: Buffer.from(owner.publicKey).toString('base64url'), authority: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'),
    policyDigest: historyDigest('policy'), members: keys.map(k => Buffer.from(k.publicKey).toString('base64url')).sort(), quorum: 4 };
  const genesisId = historyDigest('genesis'), time = Date.now(), replica = Buffer.from(keys[0].publicKey).toString('base64url');
  const checkpoint = sealHistoryCheckpoint({ context, signingKey: owner, encryptionKey: randomBytes(32), plaintext: Buffer.from('state'),
    header: { kind: 'checkpoint', generation: 0, sequence: 1, previous: genesisId } });
  const certificate = (): HistoryCompactionCertificate => {
    const proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt: time, expiresAt: time + 30000 }, context, owner);
    return { version: 1, kind: 'history-compaction-certificate', proposal,
      votes: keys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, context, genesisId, key, time)) };
  };
  const cert = certificate();
  const frame = (action: 'read' | 'retain' = 'retain', proof = cert): HistoryCompactionControlFrame => ({
    request: createHistoryCompactionControlRequest({ action, genesisId, rootId: genesisId, generation: 0, replica,
      certificateId: action === 'retain' ? historyCompactionCertificateId(proof, context, genesisId) : null,
      challenge: randomBytes(32).toString('base64url'), issuedAt: time, expiresAt: time + 10000 }, context, owner),
    certificate: action === 'retain' ? proof : null,
  });
  const original = frame(), head = { rootId: genesisId, generation: 0, sequence: 1, envelopeId: historyCheckpointEnvelopeId(checkpoint), freeze: null };
  return { owner, keys, context, genesisId, replica, time, checkpoint, cert, certificate, frame, original, head };
}
it('authenticates fresh owner control and exact target replies, including a retained proof from another valid attempt', () => {
  const f = fixture(), original = parseHistoryCompactionControlFrame(f.original, f.context, f.genesisId, f.time);
  const response = createHistoryCompactionControlResponse(original, f.head, f.cert, f.context, f.keys[0]);
  expect(parseHistoryCompactionControlResponse(response, original, f.context, f.genesisId)).toEqual(response);
  const another = f.frame('retain', f.certificate()), historical = createHistoryCompactionControlResponse(another, f.head, f.cert, f.context, f.keys[0]);
  expect(parseHistoryCompactionControlResponse(historical, another, f.context, f.genesisId).certificate).toEqual(response.certificate);
  expect(() => parseHistoryCompactionControlResponse(response, another, f.context, f.genesisId)).toThrow('another request');
});
it('permits authenticated absence only on reads and rejects unexpected read payloads', () => {
  const f = fixture(), frame = f.frame('read');
  const absent = createHistoryCompactionControlResponse(frame, f.head, null, f.context, f.keys[0]);
  expect(parseHistoryCompactionControlResponse(absent, frame, f.context, f.genesisId).certificate).toBeNull();
  expect(() => createHistoryCompactionControlResponse(f.original, f.head, null, f.context, f.keys[0])).toThrow('another checkpoint');
  expect(() => parseHistoryCompactionControlFrame({ ...frame, certificate: f.cert }, f.context, f.genesisId, f.time)).toThrow('authorization');
});
it.each(['action', 'genesisId', 'rootId', 'generation', 'replica', 'certificateId', 'challenge', 'issuedAt', 'expiresAt', 'signature', 'extra'])(
  'refuses authorization tampering in %s', field => {
    const f = fixture(), values: Record<string, unknown> = { action: 'read', genesisId: historyDigest('other'), rootId: historyDigest('other'),
      generation: 1, replica: Buffer.from(f.keys[1].publicKey).toString('base64url'), certificateId: historyDigest('other'),
      challenge: randomBytes(32).toString('base64url'), issuedAt: f.time - 1, expiresAt: f.time + 9999, signature: randomBytes(64).toString('base64url'), extra: true };
    expect(() => parseHistoryCompactionControlRequest({ ...f.original.request, [field]: values[field] }, f.context, f.genesisId, f.time)).toThrow();
  },
);
it('rejects expired requests, wrong enrollment, modified proof payloads and oversized frames', () => {
  const f = fixture();
  for (const now of [f.time - 1, f.time + 10000, NaN, Infinity]) expect(() => parseHistoryCompactionControlFrame(f.original, f.context, f.genesisId, now)).toThrow();
  expect(() => parseHistoryCompactionControlFrame(f.original, f.context, historyDigest('other'), f.time)).toThrow();
  expect(() => parseHistoryCompactionControlFrame({ ...f.original, certificate: f.certificate() }, f.context, f.genesisId, f.time)).toThrow('authorization');
  expect(() => parseHistoryCompactionControlFrame({ ...f.original, extra: 'x'.repeat(16384) }, f.context, f.genesisId, f.time)).toThrow();
});
it('rejects wrong member signatures, changed heads and proofs beyond the retained head', () => {
  const f = fixture();
  expect(() => createHistoryCompactionControlResponse(f.original, f.head, f.cert, f.context, f.keys[1])).toThrow('member');
  const response = createHistoryCompactionControlResponse(f.original, f.head, f.cert, f.context, f.keys[0]);
  expect(() => parseHistoryCompactionControlResponse({ ...response, head: { ...response.head, sequence: 2 } }, f.original, f.context, f.genesisId)).toThrow('signature');
  expect(() => parseHistoryCompactionControlResponse({ ...response, signature: randomBytes(64).toString('base64url') }, f.original, f.context, f.genesisId)).toThrow('signature');
  expect(() => createHistoryCompactionControlResponse(f.original, { ...f.head, sequence: 0, envelopeId: f.genesisId }, f.cert, f.context, f.keys[0])).toThrow('certified history');
});
