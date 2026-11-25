import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexSearchRequestV1,
  createLeasedIndexLookupRequestV1,
  generateLeasedIndexKeyMaterialV1,
  generateSigningKeyPair,
  parseLeasedIndexOperationV1,
  serializeLeasedIndexOperationV1,
} from '@resonance/core';
import { createRelayClient } from '@resonance/node';
import {
  ActiveFixtureState,
  ValidationInconclusiveError,
  advanceFixtureOnAcknowledgment,
  validateSearchResults,
} from '../client-held-search-validation.js';
import { reconcileFixtureWithCurrent } from '../client-held-oracle-reconstruction.js';
import {
  ProcessRelay,
  admissionProvider,
  fixedIndex,
} from '../../../node/src/__tests__/fixtures/client-held-process-harness.js';

const directories: string[] = [];
const relays: ProcessRelay[] = [];
const clients: Array<{ disconnect(): void }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.allSettled(relays.splice(0).map(relay => relay.stop()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('client-held uncertain oracle integration', () => {
  it('keeps validation inconclusive after a committed write loses its acknowledgment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-uncertain-oracle-'));
    directories.push(directory);
    let relay = await ProcessRelay.start(join(directory, 'relay'));
    relays.push(relay);
    let network = createRelayClient({ relayUrl: relay.endpoint, admissionCapabilityProvider: admissionProvider });
    clients.push(network);
    const keys = generateLeasedIndexKeyMaterialV1();
    const operation = fixedIndex(keys, Date.now() - 1_000, Date.now() + 86_400_000);
    const operationBytes = serializeLeasedIndexOperationV1(operation);
    await relay.arm('index-save', operationBytes);
    const lost = network.submitLeasedIndexOperation(operationBytes);
    const lostRejected = expect(lost).rejects.toThrow();
    await lostRejected;
    await relay.kill('index-save');

    const state = new ActiveFixtureState();
    expect(advanceFixtureOnAcknowledgment(state, operation, {
      outcome: 'error', reason: 'connection_closed',
    })).toBe(false);
    expect(state.isUncertain(operation.publicationId)).toBe(true);
    expect(state.currentGenerationId(operation.publicationId)).toBeUndefined();
    network.disconnect();
    relay = await ProcessRelay.start(join(directory, 'relay'));
    relays.push(relay);
    network = createRelayClient({ relayUrl: relay.endpoint, admissionCapabilityProvider: admissionProvider });
    clients.push(network);

    const request = createLeasedIndexSearchRequestV1({
      groupId: 'public',
      itemType: 'offer',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64).fill(1),
      limit: 10,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    }, generateSigningKeyPair());
    const results = await network.searchLeasedIndexes(request);
    expect(results).toEqual([operationBytes]);
    expect(() => validateSearchResults({
      request,
      results,
      state,
      expectedPublicationId: operation.publicationId,
      expectedGenerationId: createLeasedIndexGenerationIdV1(operation),
      now: Date.now(),
    })).toThrow(ValidationInconclusiveError);

    const currentBytes = await network.lookupLeasedIndex(createLeasedIndexLookupRequestV1({
      publicationId: operation.publicationId,
      createdAt: Date.now(), expiresAt: Date.now() + 10_000,
    }, generateSigningKeyPair()));
    expect(currentBytes).toBe(operationBytes);
    const current = parseLeasedIndexOperationV1(currentBytes!);
    if (current.kind !== 'leased-discovery-index') throw new Error('Expected current discovery index');
    expect(reconcileFixtureWithCurrent(state, current, Date.now(), join(directory, 'relay', 'client-held'))).toMatchObject({
      status: 'reconciled', activeExactMatch: true,
    });
    expect(validateSearchResults({
      request,
      results,
      state,
      expectedPublicationId: operation.publicationId,
      expectedGenerationId: createLeasedIndexGenerationIdV1(operation),
      now: Date.now(),
    })).toHaveLength(1);
  }, 30_000);
});
