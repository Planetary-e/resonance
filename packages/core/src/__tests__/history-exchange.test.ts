import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import { createHistoryFreeze, historyDigest, historyCheckpointEnvelopeId, sealHistoryCheckpoint, type HistoryCheckpointContext } from '../history-checkpoint.js';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryExchangeRequest,
  parseHistoryExchangeResponse, parseHistoryWriteCertificate, parseHistoryRecoveryPreparation, type HistoryExchangeRequest } from '../history-exchange.js';

function fixture() {
  const owner = generateSigningKeyPair(), members = Array.from({ length: 5 }, () => generateSigningKeyPair());
  const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends', historyId: randomBytes(32).toString('base64url'),
    owner: Buffer.from(owner.publicKey).toString('base64url'), authority: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'),
    policyDigest: historyDigest('policy'), members: members.map(m => Buffer.from(m.publicKey).toString('base64url')).sort(), quorum: 4 };
  const root = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from('state'), encryptionKey: randomBytes(32), signingKey: owner });
  const rootId = historyCheckpointEnvelopeId(root), challenge = randomBytes(32).toString('base64url'), time = Date.now();
  const request = (i = 0, change: Partial<HistoryExchangeRequest> = {}) => createHistoryExchangeRequest({ action: 'append', rootId,
    generation: 0, replica: Buffer.from(members[i].publicKey).toString('base64url'), challenge, issuedAt: time, expiresAt: time + 10000,
    sequence: 0, envelopeId: rootId, ...change }, context, owner);
  const head = { generation: 0, rootId, sequence: 0, envelopeId: rootId, freeze: null };
  const receipts = members.map((key, i) => createHistoryExchangeResponse(request(i), 'stored', head, null, context, key));
  return { owner, members, context, root, rootId, time, request, head, receipts };
}

it('verifies four distinct signatures over one exact durable write and fresh attempt', () => {
  const f = fixture(), certificate = { version: 1, receipts: f.receipts.slice(0, 4) };
  expect(parseHistoryWriteCertificate(certificate, f.root, f.rootId, f.context)).toEqual(certificate);
  for (const receipts of [f.receipts.slice(0, 3), [f.receipts[0], f.receipts[0], ...f.receipts.slice(1, 3)],
    [f.receipts[0], f.receipts[1], f.receipts[2], { ...f.receipts[3], signature: f.receipts[4].signature }]]) {
    expect(() => parseHistoryWriteCertificate({ version: 1, receipts }, f.root, f.rootId, f.context)).toThrow();
  }
  const otherAttempt = createHistoryExchangeResponse(f.request(3, { challenge: randomBytes(32).toString('base64url') }),
    'stored', f.head, null, f.context, f.members[3]);
  expect(() => parseHistoryWriteCertificate({ version: 1, receipts: [...f.receipts.slice(0, 3), otherAttempt] }, f.root, f.rootId, f.context)).toThrow('same attempt');
  expect(() => parseHistoryWriteCertificate(certificate, f.root, historyDigest('other root'), f.context)).toThrow();
});

it.each(['action', 'contextId', 'rootId', 'generation', 'replica', 'challenge', 'issuedAt', 'expiresAt', 'sequence', 'envelopeId', 'signature', 'extra'])
('rejects request tampering in %s', field => {
  const f = fixture(), original = f.request();
  const changes: Record<string, unknown> = { action: 'head', contextId: historyDigest('other'), rootId: historyDigest('other'), generation: 1,
    replica: Buffer.from(f.members[1].publicKey).toString('base64url'), challenge: randomBytes(32).toString('base64url'),
    issuedAt: f.time - 1, expiresAt: f.time + 9999, sequence: 1, envelopeId: historyDigest('different'), signature: randomBytes(64).toString('base64url'), extra: true };
  expect(() => parseHistoryExchangeRequest({ ...original, [field]: changes[field] }, f.context, f.time)).toThrow();
});

it('refuses expired/future requests and cannot replay a signed receipt for a new challenge or destination', () => {
  const f = fixture();
  expect(() => parseHistoryExchangeRequest(f.request(), f.context, f.time - 1)).toThrow();
  expect(() => parseHistoryExchangeRequest(f.request(), f.context, f.time + 10000)).toThrow();
  expect(() => f.request(0, { expiresAt: f.time + 30001 })).toThrow();
  expect(() => parseHistoryExchangeResponse(f.receipts[0], f.request(0, { challenge: randomBytes(32).toString('base64url') }), f.context)).toThrow('another request');
  expect(() => parseHistoryExchangeResponse(f.receipts[0], f.request(1), f.context)).toThrow('another request');
  expect(() => parseHistoryExchangeResponse({ ...f.receipts[0], head: { ...f.head, sequence: 1 } }, f.request(), f.context)).toThrow('signature');
});

it('authenticates full read payloads, rejects substituted blocks, and distinguishes absent blocks', () => {
  const f = fixture(), request = f.request(0, { action: 'read', envelopeId: null });
  const response = createHistoryExchangeResponse(request, 'block', f.head, f.root, f.context, f.members[0]);
  expect(parseHistoryExchangeResponse(response, request, f.context).envelope).toEqual(f.root);
  expect(() => parseHistoryExchangeResponse({ ...response, envelope: { ...f.root, ciphertext: 'fake' } }, request, f.context)).toThrow();
  const missing = f.request(0, { action: 'read', envelopeId: null, sequence: 1 });
  expect(createHistoryExchangeResponse(missing, 'missing', f.head, null, f.context, f.members[0]).status).toBe('missing');
  expect(() => createHistoryExchangeResponse(request, 'missing', f.head, null, f.context, f.members[0])).toThrow();
  expect(() => createHistoryExchangeResponse(request, 'head', f.head, null, f.context, f.members[0])).toThrow();
});

it('binds a freeze receipt to the exact requested successor barrier and fresh challenge', () => {
  const f = fixture(), request = f.request(0, { action: 'freeze', envelopeId: null, sequence: 2 });
  const freeze = createHistoryFreeze(f.context, 0, 2, request.challenge, f.owner);
  const response = createHistoryExchangeResponse(request, 'frozen', { ...f.head, freeze }, null, f.context, f.members[0]);
  expect(parseHistoryExchangeResponse(response, request, f.context)).toEqual(response);
  expect(() => f.request(0, { action: 'freeze', envelopeId: null, sequence: 0 })).toThrow();
  expect(() => createHistoryExchangeResponse(request, 'frozen', f.head, null, f.context, f.members[0])).toThrow();
  expect(() => createHistoryExchangeResponse(request, 'frozen', { ...f.head,
    freeze: createHistoryFreeze(f.context, 0, 3, request.challenge, f.owner) }, null, f.context, f.members[0])).toThrow();
  expect(() => parseHistoryExchangeResponse(response, f.request(0, { ...request,
    challenge: randomBytes(32).toString('base64url') }), f.context)).toThrow();
});

it('keeps absent activated-child observations separate from reads, fresh writes and global readiness', () => {
  const f = fixture(), request = f.request(0, { action: 'continuation', envelopeId: null });
  const response = createHistoryExchangeResponse(request, 'no-continuation', f.head, null, f.context, f.members[0]);
  expect(parseHistoryExchangeResponse(response, request, f.context)).toEqual(response);
  expect(() => f.request(0, { action: 'continuation', envelopeId: null, sequence: 1 })).toThrow();
  expect(() => f.request(0, { action: 'continuation' })).toThrow();
  expect(() => createHistoryExchangeResponse(request, 'continuation', f.head, f.root, f.context, f.members[0])).toThrow();
  expect(() => createHistoryExchangeResponse(request, 'no-continuation', f.head, f.root, f.context, f.members[0])).toThrow();
  expect(() => createHistoryExchangeResponse(request, 'head', f.head, null, f.context, f.members[0])).toThrow();
  expect(() => parseHistoryWriteCertificate({ version: 1, receipts: Array(4).fill(response) }, f.root, f.rootId, f.context)).toThrow();
  expect(() => parseHistoryExchangeResponse(response, f.request(0, { ...request, challenge: randomBytes(32).toString('base64url') }), f.context)).toThrow();
});

it('requires four frozen head anchors on one complete chain, not just the highest signed sequence', () => {
  const f = fixture(), freeze = createHistoryFreeze(f.context, 0, 1, f.request().challenge, f.owner);
  const delta = sealHistoryCheckpoint({ context: f.context, signingKey: f.owner, encryptionKey: randomBytes(32), plaintext: Buffer.from('delta'),
    header: { kind: 'delta', generation: 0, sequence: 1, previous: f.rootId } });
  const receipts = f.members.slice(0, 4).map((key, i) => createHistoryExchangeResponse(
    f.request(i, { action: 'freeze', sequence: 1, envelopeId: null }), 'frozen',
    { ...f.head, ...(i ? {} : { sequence: 1, envelopeId: historyCheckpointEnvelopeId(delta) }), freeze }, null, f.context, key));
  const prepared = { version: 1, kind: 'frozen-history', rootId: f.rootId, generation: 0, nextGeneration: 1,
    receipts, envelopes: [f.root, delta] };
  expect(parseHistoryRecoveryPreparation(prepared, f.context)).toEqual(prepared);
  for (const bad of [
    { ...prepared, envelopes: [delta] }, { ...prepared, envelopes: [f.root] },
    { ...prepared, envelopes: Array(10002).fill(f.root) },
    { ...prepared, receipts: receipts.slice(0, 3) }, { ...prepared, receipts: [receipts[0], receipts[0], ...receipts.slice(1, 3)] },
    { ...prepared, nextGeneration: 2 }, { ...prepared, rootId: historyDigest('other') },
    { ...prepared, receipts: f.receipts.slice(0, 4) },
    { ...prepared, receipts: receipts.map((r, i) => i ? r : createHistoryExchangeResponse(r.request, 'frozen',
      { ...r.head, envelopeId: historyDigest('unrelated') }, null, f.context, f.members[0])) },
  ]) expect(() => parseHistoryRecoveryPreparation(bad, f.context)).toThrow();
  const otherAttempt = f.request(3, { action: 'freeze', sequence: 1, envelopeId: null, challenge: randomBytes(32).toString('base64url') });
  const other = createHistoryExchangeResponse(otherAttempt, 'frozen', { ...f.head, freeze }, null, f.context, f.members[3]);
  expect(() => parseHistoryRecoveryPreparation({ ...prepared, receipts: [...receipts.slice(0, 3), other] }, f.context)).toThrow();
});
