import { describe, expect, it } from 'vitest';
import { generateIdentity, decodeUTF8, encodeUTF8 } from '../crypto.js';
import {
  MAX_PRIVATE_FRAME_BYTES,
  MAX_PRIVATE_REQUEST_BYTES,
  PrivateRequestReplayCacheV1,
  createPrivateRequestV1,
  createPrivateResponseV1,
  generateRelayTransportKeyV1,
  isRelayTransportKeyActiveV1,
  openPrivateDestinationRequestV1,
  openPrivateEntryRequestV1,
  openPrivateResponseV1,
  parsePrivateRequestLayerV1,
  serializePrivateRequestLayerV1,
  serializePrivateResponseV1,
  verifyRelayTransportKeyV1,
} from '../private-envelope.js';

const NOW = 1_800_000_000_000;

describe('private two-relay request envelope', () => {
  it('hides exact request and reply sizes inside bounded padding buckets', async () => {
    const entry = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const destination = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const small = await createPrivateRequestV1(
      new Uint8Array(64), entry.attestation, destination.attestation, NOW + 1,
    );
    const large = await createPrivateRequestV1(
      new Uint8Array(4_096), entry.attestation, destination.attestation, NOW + 1,
    );
    const nextBucket = await createPrivateRequestV1(
      new Uint8Array(7_000), entry.attestation, destination.attestation, NOW + 1,
    );
    const smallBytes = decodeUTF8(serializePrivateRequestLayerV1(small.request)).length;
    const largeBytes = decodeUTF8(serializePrivateRequestLayerV1(large.request)).length;
    const nextBytes = decodeUTF8(serializePrivateRequestLayerV1(nextBucket.request)).length;
    expect(largeBytes).toBe(smallBytes);
    expect(nextBytes).toBeGreaterThan(largeBytes);
    const entryReplay = new PrivateRequestReplayCacheV1();
    const destinationReplay = new PrivateRequestReplayCacheV1();
    const inner = await openPrivateEntryRequestV1(large.request, entry, entryReplay, NOW + 2);
    const openedLarge = await openPrivateDestinationRequestV1(inner, destination, destinationReplay, NOW + 2);
    expect(openedLarge.data).toEqual(new Uint8Array(4_096));
    const openedSmall = await openPrivateDestinationRequestV1(
      await openPrivateEntryRequestV1(small.request, entry, entryReplay, NOW + 2),
      destination, destinationReplay, NOW + 2,
    );
    const openedNext = await openPrivateDestinationRequestV1(
      await openPrivateEntryRequestV1(nextBucket.request, entry, entryReplay, NOW + 2),
      destination, destinationReplay, NOW + 2,
    );

    const replySmall = await createPrivateResponseV1(
      new Uint8Array(64), openedSmall.responseKey,
      small.request.requestId, destination.attestation.relayId,
    );
    const replyLarge = await createPrivateResponseV1(
      new Uint8Array(4_096), openedNext.responseKey,
      nextBucket.request.requestId, destination.attestation.relayId,
    );
    expect(decodeUTF8(serializePrivateResponseV1(replySmall)).length)
      .toBe(decodeUTF8(serializePrivateResponseV1(replyLarge)).length);
    expect(await openPrivateResponseV1(replySmall, small.responsePrivateKey,
      small.request.requestId, destination.attestation.relayId)).toEqual(new Uint8Array(64));
    expect(await openPrivateResponseV1(replyLarge, nextBucket.responsePrivateKey,
      nextBucket.request.requestId, destination.attestation.relayId)).toEqual(new Uint8Array(4_096));
  });

  it('keeps the operation unreadable to the entry and decrypts it only at the destination', async () => {
    const entry = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const destination = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const operation = decodeUTF8('private-publication-operation-canary');
    const entryReplay = new PrivateRequestReplayCacheV1();
    const destinationReplay = new PrivateRequestReplayCacheV1();

    const { request: outer, responsePrivateKey } = await createPrivateRequestV1(
      operation, entry.attestation, destination.attestation, NOW + 1,
    );
    const serialized = serializePrivateRequestLayerV1(outer);
    expect(serialized).not.toContain('private-publication-operation-canary');
    expect(serialized).not.toContain(destination.attestation.relayId);

    const inner = await openPrivateEntryRequestV1(
      parsePrivateRequestLayerV1(serialized), entry, entryReplay, NOW + 2,
    );
    expect(inner.relayId).toBe(destination.attestation.relayId);
    expect(serializePrivateRequestLayerV1(inner)).not.toContain('private-publication-operation-canary');
    await expect(openPrivateEntryRequestV1(outer, entry, entryReplay, NOW + 2))
      .rejects.toThrow('Replayed');
    await expect(openPrivateDestinationRequestV1(inner, entry, destinationReplay, NOW + 2))
      .rejects.toThrow();
    const opened = await openPrivateDestinationRequestV1(
      inner, destination, destinationReplay, NOW + 2,
    );
    expect(encodeUTF8(opened.data)).toBe('private-publication-operation-canary');
    const encryptedReply = await createPrivateResponseV1(
      decodeUTF8('signed-reply-canary'), opened.responseKey,
      outer.requestId, destination.attestation.relayId,
    );
    expect(serializePrivateResponseV1(encryptedReply)).not.toContain('signed-reply-canary');
    await expect(openPrivateResponseV1(
      encryptedReply, entry.privateKey, outer.requestId, destination.attestation.relayId,
    )).rejects.toThrow();
    expect(encodeUTF8(await openPrivateResponseV1(
      encryptedReply, responsePrivateKey, outer.requestId, destination.attestation.relayId,
    ))).toBe('signed-reply-canary');
    await expect(openPrivateResponseV1(
      encryptedReply, responsePrivateKey, 'A'.repeat(22), destination.attestation.relayId,
    )).rejects.toThrow();
    await expect(openPrivateDestinationRequestV1(inner, destination, destinationReplay, NOW + 2))
      .rejects.toThrow('Replayed');
  });

  it('verifies the relay signature, identity, public key, and key lifetime', async () => {
    const key = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    expect(verifyRelayTransportKeyV1(key.attestation)).toBe(true);
    expect(isRelayTransportKeyActiveV1(key.attestation, NOW + 1)).toBe(true);
    expect(isRelayTransportKeyActiveV1(key.attestation, key.attestation.expiresAt)).toBe(false);
    expect(verifyRelayTransportKeyV1({
      ...key.attestation, relayId: generateIdentity().did,
    })).toBe(false);
    expect(verifyRelayTransportKeyV1({
      ...key.attestation, publicKey: key.attestation.publicKey.slice(0, -4) + 'AAAA',
    })).toBe(false);
    expect(verifyRelayTransportKeyV1({
      ...key.attestation, expiresAt: key.attestation.expiresAt + 1,
    })).toBe(false);
    expect(verifyRelayTransportKeyV1({ ...key.attestation, extra: true })).toBe(false);
    expect(verifyRelayTransportKeyV1(Object.fromEntries(
      Object.entries(key.attestation).reverse(),
    ))).toBe(true);
  });

  it('binds stage, recipient, request ID, expiry, and ciphertext with HPKE AAD', async () => {
    const entry = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const destination = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const other = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const replay = new PrivateRequestReplayCacheV1();
    const { request: outer } = await createPrivateRequestV1(
      decodeUTF8('operation'), entry.attestation, destination.attestation, NOW + 1,
    );
    await expect(openPrivateEntryRequestV1(outer, other, replay, NOW + 2)).rejects.toThrow();
    await expect(openPrivateEntryRequestV1({
      ...outer, requestId: 'A'.repeat(22),
    }, entry, replay, NOW + 2)).rejects.toThrow();
    await expect(openPrivateEntryRequestV1({
      ...outer, expiresAt: outer.expiresAt - 1,
    }, entry, replay, NOW + 2)).rejects.toThrow();
    await expect(openPrivateEntryRequestV1({
      ...outer, stage: 'destination',
    }, entry, replay, NOW + 2)).rejects.toThrow();
    await expect(openPrivateEntryRequestV1({
      ...outer, ciphertext: outer.ciphertext.slice(0, -4) + 'AAAA',
    }, entry, replay, NOW + 2)).rejects.toThrow();
    await expect(openPrivateEntryRequestV1(outer, entry, replay, outer.expiresAt)).rejects.toThrow();
  });

  it('rejects missing routes, oversized operations, and malformed frames', async () => {
    const entry = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const destination = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    await expect(createPrivateRequestV1(
      decodeUTF8('operation'), entry.attestation, entry.attestation, NOW + 1,
    )).rejects.toThrow();
    await expect(createPrivateRequestV1(
      new Uint8Array(MAX_PRIVATE_REQUEST_BYTES + 1),
      entry.attestation, destination.attestation, NOW + 1,
    )).rejects.toThrow();
    const { request: outer } = await createPrivateRequestV1(
      decodeUTF8('operation'), entry.attestation, destination.attestation, NOW + 1,
    );
    expect(() => parsePrivateRequestLayerV1(JSON.stringify({ ...outer, extra: 1 }))).toThrow();
    expect(() => parsePrivateRequestLayerV1('x'.repeat(MAX_PRIVATE_FRAME_BYTES + 1))).toThrow();
    expect(() => parsePrivateRequestLayerV1(JSON.stringify({
      ...outer, enc: 'not-canonical!',
    }))).toThrow();
    const maximum = await createPrivateRequestV1(
      new Uint8Array(MAX_PRIVATE_REQUEST_BYTES), entry.attestation, destination.attestation, NOW + 1,
    );
    expect(decodeUTF8(serializePrivateRequestLayerV1(maximum.request)).length)
      .toBeLessThanOrEqual(MAX_PRIVATE_FRAME_BYTES);
    const maximumInner = await openPrivateEntryRequestV1(
      maximum.request, entry, new PrivateRequestReplayCacheV1(), NOW + 2,
    );
    expect((await openPrivateDestinationRequestV1(
      maximumInner, destination, new PrivateRequestReplayCacheV1(), NOW + 2,
    )).data.length).toBe(MAX_PRIVATE_REQUEST_BYTES);
  });

  it('fails closed when replay capacity is exhausted and reclaims expired entries', async () => {
    const entry = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const destination = await generateRelayTransportKeyV1(generateIdentity(), NOW);
    const replay = new PrivateRequestReplayCacheV1(1);
    const { request: first } = await createPrivateRequestV1(
      decodeUTF8('first'), entry.attestation, destination.attestation, NOW + 1,
    );
    const { request: second } = await createPrivateRequestV1(
      decodeUTF8('second'), entry.attestation, destination.attestation, NOW + 1,
    );
    await openPrivateEntryRequestV1(first, entry, replay, NOW + 2);
    await expect(openPrivateEntryRequestV1(second, entry, replay, NOW + 2))
      .rejects.toThrow('full');
    const { request: third } = await createPrivateRequestV1(
      decodeUTF8('third'), entry.attestation, destination.attestation, first.expiresAt,
    );
    await expect(openPrivateEntryRequestV1(third, entry, replay, first.expiresAt + 1))
      .resolves.toBeDefined();
  });
});
