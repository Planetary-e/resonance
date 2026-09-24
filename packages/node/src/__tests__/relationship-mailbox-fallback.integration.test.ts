import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  createChannelMessageOperationV2, createPairwiseChannelId,
  encryptChannelOperationV2, generateRelationshipKeyMaterial,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { createRelayClient } from '../relay-client.js';

const BASE_PORT = 42_000 + Math.floor(Math.random() * 1_000);
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const DIRS = [0, 1].map(index => `/tmp/resonance-relationship-client-${RUN_ID}-${index}`);
let relays: RelayServer[] = [];
const url = (index: number): string => `ws://127.0.0.1:${BASE_PORT + index}/`;

beforeAll(async () => {
  relays = [0, 1].map(index => createRelayServer({
    port: BASE_PORT + index, host: '127.0.0.1', persistDir: DIRS[index],
  }));
  await Promise.all(relays.map(relay => relay.start()));
});

afterAll(async () => {
  await Promise.all(relays.map(relay => relay.stop({ graceful: false })));
  for (const directory of DIRS) rmSync(directory, { recursive: true, force: true });
});

describe('relationship mailbox fallback reads', () => {
  it('finds an envelope beyond an empty primary and acknowledges each configured copy', async () => {
    const sender = generateRelationshipKeyMaterial();
    const recipient = generateRelationshipKeyMaterial();
    const operation = createChannelMessageOperationV2(
      createPairwiseChannelId('match_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sender.relationshipId, recipient.relationshipId),
      recipient.relationshipId, 1,
      { kind: 'disclosure', text: 'private message', level: 'general', createdAt: Date.now() },
      randomBytes(32), sender,
    );
    const envelope = encryptChannelOperationV2(operation, {
      id: recipient.mailboxId,
      encryptionKey: Buffer.from(recipient.mailboxKeyPair.publicKey).toString('base64'),
    });
    const first = createRelayClient({ relayUrl: url(0) });
    const second = createRelayClient({ relayUrl: url(1) });
    const multi = createRelayClient({ relayUrl: url(0), fallbackUrls: [url(1)] });

    await second.depositRelationshipMailboxEnvelope(recipient.relationshipId, sender, envelope);
    expect((await multi.fetchRelationshipMailbox(recipient)).envelopes.map(value => value.envelopeId))
      .toEqual([envelope.envelopeId]);
    await first.depositRelationshipMailboxEnvelope(recipient.relationshipId, sender, envelope);
    expect((await multi.fetchRelationshipMailbox(recipient)).envelopes.map(value => value.envelopeId))
      .toEqual([envelope.envelopeId]);
    await multi.acknowledgeRelationshipMailbox(recipient, [envelope.envelopeId]);
    expect((await first.fetchRelationshipMailbox(recipient)).envelopes).toEqual([]);
    expect((await second.fetchRelationshipMailbox(recipient)).envelopes).toEqual([]);
  });
});
