import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createChannelMessageOperationV2, createPairwiseChannelId, encryptChannelOperationV2,
  createMessage, generateIdentity, generateRelationshipKeyMaterial, MAILBOX_RESPONSE_MESSAGE_TYPE,
  MAX_SIGNED_MESSAGE_BYTES, MessageTypes, serializeMessage } from '@resonance/core';
import { createRelayClient } from '../relay-client.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const search = { groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64), itemType: 'need' as const, k: 5, threshold: 0.9 };
async function relay(answer: (socket: WebSocket, request: any) => void) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.on('connection', socket => socket.on('message', bytes => answer(socket, JSON.parse(bytes.toString()))));
  await once(server, 'listening');
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, client = createRelayClient({ relayUrl: endpoint });
  cleanup.push(() => client.disconnect()); return { server, client, endpoint };
}
const identity = generateIdentity();
const envelopeId = `env_${Buffer.alloc(32).toString('base64url')}`;

it.each(['null', 'missing-status', 'wrong-status', 'extra-field', 'wrong-ref', 'object-message'])('rejects a signed malformed acknowledgement: %s', async kind => {
  const { client } = await relay((socket, frame) => {
    const payload: any = { ref: frame.request.requestId, status: 'ok' };
    if (kind === 'missing-status') delete payload.status;
    if (kind === 'wrong-status') payload.status = 'accepted';
    if (kind === 'extra-field') payload.hidden = true;
    if (kind === 'wrong-ref') payload.ref = 'another request';
    if (kind === 'object-message') payload.message = {};
    socket.send(serializeMessage(createMessage(MessageTypes.ACK, kind === 'null' ? null : payload, identity)));
  });
  await expect(client.acknowledgeRelationshipMailbox(generateRelationshipKeyMaterial(), [envelopeId])).rejects.toThrow();
});

it.each(['null', 'extra-field', 'too-many', 'invalid-envelope', 'other-mailbox', 'duplicate-envelope'])('rejects a signed malformed mailbox response: %s', async kind => {
  const recipient = generateRelationshipKeyMaterial(), sender = generateRelationshipKeyMaterial();
  const operation = createChannelMessageOperationV2(createPairwiseChannelId(`match_${Buffer.alloc(32).toString('base64url')}`,
    sender.relationshipId, recipient.relationshipId), recipient.relationshipId, 1,
  { kind: 'disclosure', text: 'test', level: 'general', createdAt: Date.now() }, randomBytes(32), sender);
  const envelope = encryptChannelOperationV2(operation, { id: recipient.mailboxId, encryptionKey: Buffer.from(recipient.mailboxKeyPair.publicKey).toString('base64') });
  const { client } = await relay((socket, frame) => {
    const payload: any = { requestId: frame.request.requestId, mailboxId: recipient.mailboxId, envelopes: [envelope] };
    if (kind === 'extra-field') payload.hidden = true;
    if (kind === 'too-many') payload.envelopes = Array(101).fill(envelope);
    if (kind === 'invalid-envelope') payload.envelopes = [{ envelopeId: envelope.envelopeId }];
    if (kind === 'other-mailbox') payload.envelopes = [{ ...envelope, mailboxId: sender.mailboxId }];
    if (kind === 'duplicate-envelope') payload.envelopes = [envelope, envelope];
    socket.send(serializeMessage(createMessage(MAILBOX_RESPONSE_MESSAGE_TYPE, kind === 'null' ? null : payload, identity)));
  });
  await expect(client.fetchRelationshipMailbox(recipient)).rejects.toThrow();
});

it.each(['binary', 'signature', 'oversized', 'malformed-json'])('closes an invalid response socket: %s', async kind => {
  let closed: Promise<unknown> | undefined;
  const { client } = await relay((socket, frame) => {
    closed = once(socket, 'close'); socket.on('error', () => {});
    const message = createMessage(MessageTypes.ACK, { ref: frame.request.searchId, status: 'error', message: 'refused' }, identity);
    if (kind === 'signature') message.signature = Buffer.alloc(64).toString('base64');
    if (kind === 'oversized') socket.send(' '.repeat(MAX_SIGNED_MESSAGE_BYTES + 1));
    else if (kind === 'malformed-json') socket.send('{');
    else socket.send(serializeMessage(message), { binary: kind === 'binary' });
  });
  await expect(client.searchV2(search)).rejects.toThrow(); expect(closed).toBeDefined(); await closed;
});

it('cancels a dial before upgrade and never sends or retries after disconnect', async () => {
  let fallbackContacts = 0;
  const fallback = await relay(socket => { fallbackContacts++; socket.close(); });
  const server = createServer(), sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = createRelayClient({ relayUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, fallbackUrls: [fallback.endpoint] });
  cleanup.push(() => client.disconnect());
  const upgrade = once(server, 'upgrade'), pending = client.searchV2(search), result = expect(pending).rejects.toThrow('disconnected');
  const [, socket] = await upgrade, ended = once(socket, 'end');
  socket.resume(); client.disconnect(); await result; await ended; socket.destroy();
  expect(fallbackContacts).toBe(0);
});

it('bounds concurrent direct operations and cancels every pending socket', async () => {
  const { client } = await relay(() => {});
  const pending = Array.from({ length: 64 }, () => client.searchV2(search));
  const settled = Promise.allSettled(pending);
  await expect(client.searchV2(search)).rejects.toThrow('capacity'); client.disconnect();
  const results = await settled; expect(results.every(result => result.status === 'rejected' && String(result.reason).includes('disconnected'))).toBe(true);
});

it('does not begin another fallback when the shared deadline is exhausted', async () => {
  let secondSearches = 0, secondMailboxes = 0;
  const first = await relay(() => {}), second = await relay((socket, frame) => {
    if (frame.request.searchId) { secondSearches++; return; }
    secondMailboxes++;
    socket.send(serializeMessage(createMessage(MAILBOX_RESPONSE_MESSAGE_TYPE,
      { requestId: frame.request.requestId, mailboxId: frame.request.mailboxId, envelopes: [] }, identity)));
  });
  const client = createRelayClient({ relayUrl: first.endpoint, fallbackUrls: [second.endpoint] }); cleanup.push(() => client.disconnect());
  const start = performance.now(), mailbox = client.fetchRelationshipMailbox(generateRelationshipKeyMaterial());
  await expect(client.searchV2(search)).rejects.toThrow('timeout');
  expect(await mailbox).toEqual({ envelopes: [] }); // A timed-out copy cannot erase a valid parallel reply.
  expect(performance.now() - start).toBeLessThan(12_000); expect(secondSearches).toBe(0); expect(secondMailboxes).toBe(1);
}, 15_000);

it('contains local serialization failure before opening a socket', async () => {
  let contacts = 0; const { endpoint, server } = await relay(() => {}); server.on('connection', () => contacts++);
  const client = createRelayClient({ relayUrl: endpoint, admissionCapabilityProvider: () => { throw new Error('wallet unavailable'); } });
  await expect(client.searchV2(search)).rejects.toThrow('wallet unavailable'); expect(contacts).toBe(0); client.disconnect();
});

it('does not transmit a root identity through the disabled legacy session API', async () => {
  let contacts = 0; const { endpoint, server } = await relay(() => {}); server.on('connection', () => contacts++);
  const client = createRelayClient({ relayUrl: endpoint, identity: generateIdentity(), autoReconnect: true });
  await expect(client.connect()).rejects.toThrow('Legacy relay authentication is unavailable');
  expect(client.isConnected()).toBe(false); expect(contacts).toBe(0); client.disconnect();
});
