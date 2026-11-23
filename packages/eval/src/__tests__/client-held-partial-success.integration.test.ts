import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeasedIndexGenerationIdV1,
  createLeasedIndexSearchRequestV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateSigningKeyPair,
  serializeLeasedIndexOperationV1,
} from '@resonance/core';
import { createRelayClient } from '@resonance/node';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import {
  ActiveFixtureState,
  advanceFixtureOnAcknowledgment,
  validateSearchResults,
} from '../client-held-search-validation.js';

const directories: string[] = [];
const servers: RelayServer[] = [];
const clients: Array<{ disconnect(): void }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const server of servers.splice(0)) await server.stop({ graceful: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('client-held partial-success harness integration', () => {
  it('searches an accepting relay using only its independently acknowledged oracle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-partial-oracle-'));
    directories.push(directory);
    const server = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      persistDir: join(directory, 'accepting-relay'),
      privateEntryMix: false,
      privateReplyMix: false,
      relayDiscovery: {
        endpoints: ['ws://127.0.0.1:0/'],
        reachability: 'direct',
        supportedGroups: ['public'],
        storage: { capacityBytes: 1024 ** 2, availableBytes: 1024 ** 2 },
      },
    });
    servers.push(server);
    await server.start();
    const accepting = createRelayClient({ relayUrl: `ws://127.0.0.1:${server.getListeningPort()}/` });
    const unavailable = createRelayClient({ relayUrl: 'ws://127.0.0.1:1/' });
    clients.push(accepting, unavailable);
    const keys = generateLeasedIndexKeyMaterialV1();
    const operation = createLeasedIndexV1({
      groupId: 'public',
      itemType: 'need',
      derivationId: 'partial-oracle-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64),
      originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 86_400_000,
    }, keys);
    const states = [new ActiveFixtureState(), new ActiveFixtureState()];
    const accepted = await accepting.submitLeasedIndexOperation(serializeLeasedIndexOperationV1(operation));
    expect(accepted.status).toBe('ok');
    expect(advanceFixtureOnAcknowledgment(states[0], operation, {
      outcome: 'ok', reason: accepted.message ?? accepted.status,
    })).toBe(true);
    await expect(unavailable.submitLeasedIndexOperation(serializeLeasedIndexOperationV1(operation)))
      .rejects.toThrow();
    expect(advanceFixtureOnAcknowledgment(states[1], operation, {
      outcome: 'error', reason: 'connection_closed',
    })).toBe(false);
    expect(states[1].currentGenerationId(operation.publicationId)).toBeUndefined();

    const request = createLeasedIndexSearchRequestV1({
      groupId: 'public',
      itemType: 'offer',
      fingerprintEpoch: 'epoch-1',
      fingerprint: new Uint8Array(64),
      limit: 10,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    }, generateSigningKeyPair());
    const results = await accepting.searchLeasedIndexes(request);
    expect(validateSearchResults({
      request,
      results,
      state: states[0],
      expectedPublicationId: operation.publicationId,
      expectedGenerationId: createLeasedIndexGenerationIdV1(operation),
      now: Date.now(),
    })).toHaveLength(1);
  }, 30_000);
});
