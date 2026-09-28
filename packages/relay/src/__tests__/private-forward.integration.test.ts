import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  MessageTypes,
  createPrivateRequestV1,
  createMailboxRequest,
  createMailboxRequestFrame,
  createPublicationOperationFrame,
  createPublicationRecord,
  createSearchRequestFrameV2,
  createSearchRequestV2,
  createRelayContactHintV1,
  decodeUTF8,
  encodeUTF8,
  generatePublicationKeyMaterial,
  generateIdentity,
  generateRelayTransportKeyV1,
  parseMessage,
  parsePrivateResponseV1,
  openPrivateResponseV1,
  serializePrivateRequestLayerV1,
  serializeMailboxRequestFrame,
  serializePublicationOperationFrame,
  serializeSearchRequestFrameV2,
  verifyMessage,
  type AckPayload,
  type Message,
  type SearchResponsePayloadV2,
  type MailboxResponsePayload,
} from '@resonance/core';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';
import { PrivateReplayLog, PRIVATE_REPLAY_LOG_FILENAME } from '../private-replay-log.js';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 42_000 + Math.floor(Math.random() * 1_000);
const ENTRY_ENDPOINT = `ws://127.0.0.1:${BASE_PORT}/`;
const DESTINATION_ENDPOINT = `ws://127.0.0.1:${BASE_PORT + 1}/`;
const ENTRY_DIR = `/tmp/resonance-private-entry-${Date.now()}-${BASE_PORT}`;
const DESTINATION_DIR = `/tmp/resonance-private-destination-${Date.now()}-${BASE_PORT}`;
let entry: RelayServer;
let destination: RelayServer;

function relay(port: number, persistDir: string): RelayServer {
  return createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir,
    relayDiscovery: {
      endpoints: [`ws://127.0.0.1:${port}/`],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
      maxKnownRelays: 8,
    },
  });
}

function send(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENTRY_ENDPOINT);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Private request timed out'));
    }, 10_000);
    ws.on('open', () => ws.send(raw));
    ws.on('message', data => {
      clearTimeout(timeout);
      ws.close();
      resolve(data.toString('utf8'));
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (code !== 1000) reject(new Error(`Private request closed: ${code} ${reason}`));
    });
    ws.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

beforeAll(async () => {
  entry = relay(BASE_PORT, ENTRY_DIR);
  destination = relay(BASE_PORT + 1, DESTINATION_DIR);
  await entry.start();
  await destination.start();
});

afterAll(async () => {
  await destination.stop();
  await entry.stop();
  rmSync(ENTRY_DIR, { recursive: true, force: true });
  rmSync(DESTINATION_DIR, { recursive: true, force: true });
});

describe('private request forwarding over live volunteer relays', () => {
  it('delivers an encrypted publication through an entry that does not store it', async () => {
    const entryContact = await discoverRelayContactV1(
      createRelayContactHintV1('configured', ENTRY_ENDPOINT),
    );
    const destinationContact = await discoverRelayContactV1(
      createRelayContactHintV1('configured', DESTINATION_ENDPOINT),
    );
    expect(entryContact.transportKey?.relayId).toBe(entryContact.responder.relayId);
    expect(destinationContact.transportKey?.relayId).toBe(destinationContact.responder.relayId);
    expect(entry.observeRelayDescriptor(destinationContact.responder)).toBe('accepted');

    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const publication = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xa5),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, keys);
    const operation = serializePublicationOperationFrame(
      createPublicationOperationFrame(publication),
    );
    const outer = await createPrivateRequestV1(
      decodeUTF8(operation), entryContact.transportKey!, destinationContact.transportKey!,
    );
    const outerRaw = serializePrivateRequestLayerV1(outer.request);
    expect(outerRaw).not.toContain(publication.publicationId);

    const encryptedAck = parsePrivateResponseV1(await send(outerRaw));
    expect(JSON.stringify(encryptedAck)).not.toContain(publication.publicationId);
    const ack = parseMessage(encodeUTF8(await openPrivateResponseV1(
      encryptedAck, outer.responsePrivateKey, outer.request.requestId,
      destinationContact.responder.relayId,
    ))) as Message<AckPayload>;
    expect(verifyMessage(ack)).toBe(true);
    expect(ack.from).toBe(destinationContact.responder.relayId);
    expect(ack.type).toBe(MessageTypes.ACK);
    expect(ack.payload).toMatchObject({ ref: publication.publicationId, status: 'ok' });
    expect(entry.getStats().stored_publications).toBe(0);
    expect(destination.getStats().stored_publications).toBe(1);
    expect(readFileSync(join(ENTRY_DIR, PRIVATE_REPLAY_LOG_FILENAME), 'utf8'))
      .toContain(`entry:${entryContact.responder.relayId}:${entryContact.transportKey!.keyId}:${outer.request.requestId}`);
    const destinationEvidence = new PrivateReplayLog(DESTINATION_DIR).load();
    expect(destinationEvidence.some(record => record.id ===
      `destination:${destinationContact.responder.relayId}:${destinationContact.transportKey!.keyId}:${outer.request.requestId}`))
      .toBe(true);
    await expect(send(outerRaw)).rejects.toThrow('4003');

    const search = createSearchRequestV2({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xa5),
      itemType: 'need',
      k: 5,
      threshold: 0.9,
    });
    const searchRaw = serializeSearchRequestFrameV2(createSearchRequestFrameV2(search));
    const searchOuter = await createPrivateRequestV1(
      decodeUTF8(searchRaw), entryContact.transportKey!, destinationContact.transportKey!,
    );
    const encryptedSearch = parsePrivateResponseV1(await send(
      serializePrivateRequestLayerV1(searchOuter.request),
    ));
    expect(JSON.stringify(encryptedSearch)).not.toContain(publication.publicationId);
    const searchResponse = parseMessage(encodeUTF8(await openPrivateResponseV1(
      encryptedSearch, searchOuter.responsePrivateKey, searchOuter.request.requestId,
      destinationContact.responder.relayId,
    ))) as Message<SearchResponsePayloadV2>;
    expect(verifyMessage(searchResponse)).toBe(true);
    expect(searchResponse.from).toBe(destinationContact.responder.relayId);
    expect(searchResponse.payload.results.some(
      result => result.publicationId === publication.publicationId,
    )).toBe(true);

    const mailboxRequest = createMailboxRequest('fetch', publication, keys);
    const mailboxRaw = serializeMailboxRequestFrame(createMailboxRequestFrame(mailboxRequest));
    const mailboxOuter = await createPrivateRequestV1(
      decodeUTF8(mailboxRaw), entryContact.transportKey!, destinationContact.transportKey!,
    );
    const encryptedMailbox = parsePrivateResponseV1(await send(
      serializePrivateRequestLayerV1(mailboxOuter.request),
    ));
    expect(JSON.stringify(encryptedMailbox)).not.toContain(publication.mailbox.id);
    const mailboxResponse = parseMessage(encodeUTF8(await openPrivateResponseV1(
      encryptedMailbox, mailboxOuter.responsePrivateKey, mailboxOuter.request.requestId,
      destinationContact.responder.relayId,
    ))) as Message<MailboxResponsePayload>;
    expect(verifyMessage(mailboxResponse)).toBe(true);
    expect(mailboxResponse.payload.mailboxId).toBe(publication.mailbox.id);
    expect(mailboxResponse.payload.envelopes).toEqual([]);
  });

  it('fails closed when the entry has no authenticated route to the destination', async () => {
    const entryContact = await discoverRelayContactV1(
      createRelayContactHintV1('configured', ENTRY_ENDPOINT),
    );
    const unknown = await generateRelayTransportKeyV1(generateIdentity());
    const outer = await createPrivateRequestV1(
      decodeUTF8('unreachable-operation'), entryContact.transportKey!, unknown.attestation,
    );
    await expect(send(serializePrivateRequestLayerV1(outer.request)))
      .rejects.toThrow('4004');
  });
});
