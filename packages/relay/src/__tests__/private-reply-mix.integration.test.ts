import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  MessageTypes, createPrivateRequestV1, createPublicationOperationFrame, createPublicationRecord,
  createRelayContactHintV1, decodeUTF8, encodeUTF8, generatePublicationKeyMaterial,
  openPrivateResponseV1, parseMessage, parsePrivateResponseV1,
  serializePrivateRequestLayerV1, serializePublicationOperationFrame, verifyMessage,
  type AckPayload, type Message,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';
import type { PrivateEntryMixOptions } from '../private-entry-mix.js';

const BASE_PORT = 50_000 + Math.floor(Math.random() * 1_000);
let entry: RelayServer | undefined;
let destination: RelayServer | undefined;
let directory: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await entry?.stop(); await destination?.stop();
  entry = destination = undefined;
  vi.restoreAllMocks();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function setup(replyMix: PrivateEntryMixOptions) {
  directory = mkdtempSync(join(tmpdir(), 'resonance-reply-mix-'));
  const entryEndpoint = `ws://127.0.0.1:${BASE_PORT}/`;
  const destinationEndpoint = `ws://127.0.0.1:${BASE_PORT + 1}/`;
  const makeRelay = (port: number, endpoint: string, name: string) => createRelayServer({
    port, host: '127.0.0.1', persistDir: join(directory, name),
    privateEntryMix: false, privateReplyMix: replyMix,
    relayDiscovery: { endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8 },
  });
  entry = makeRelay(BASE_PORT, entryEndpoint, 'entry');
  destination = makeRelay(BASE_PORT + 1, destinationEndpoint, 'destination');
  await entry.start(); await destination.start();
  const entryContact = await discoverRelayContactV1(createRelayContactHintV1('configured', entryEndpoint));
  const destinationContact = await discoverRelayContactV1(createRelayContactHintV1('configured', destinationEndpoint));
  expect(entry.observeRelayDescriptor(destinationContact.responder)).toBe('accepted');

  const arrivals = new Map<string, { at: number; raw: string }>();
  const originalEmit = WebSocket.prototype.emit;
  vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event, ...args) {
    // Observe the entry receiving an encrypted reply before its normal handler runs.
    if (event === 'message' && this.url === destinationEndpoint) {
      const raw = String(args[0]);
      const frame = JSON.parse(raw);
      if (frame.type === 'private_response') arrivals.set(frame.requestId, { at: Date.now(), raw });
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  });

  return {
    arrivals,
    async submit() {
      const now = Date.now();
      const publication = createPublicationRecord({
        groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(0xe5),
        itemType: 'offer', createdAt: now, expiresAt: now + 86_400_000,
      }, generatePublicationKeyMaterial());
      const exchange = await createPrivateRequestV1(
        decodeUTF8(serializePublicationOperationFrame(createPublicationOperationFrame(publication))),
        entryContact.transportKey!, destinationContact.transportKey!,
      );
      const socket = new WebSocket(entryEndpoint);
      sockets.push(socket);
      let receivedAt = 0;
      const response = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('Reply timed out')); }, 5_000);
        socket.once('message', data => { clearTimeout(timer); receivedAt = Date.now(); resolve(String(data)); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('close', (code, reason) => {
          clearTimeout(timer); reject(new Error(`Closed ${code}: ${reason}`));
        });
      });
      // Cancellation tests intentionally consume rejection after observing the destination reply.
      void response.catch(() => {});
      const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () => socket.send(serializePrivateRequestLayerV1(exchange.request),
          error => error ? reject(error) : resolve()));
      });
      return { socket, response, closed, requestId: exchange.request.requestId,
        receivedAt: () => receivedAt,
        async verify(raw: string) {
          const ack = parseMessage(encodeUTF8(await openPrivateResponseV1(
            parsePrivateResponseV1(raw), exchange.responsePrivateKey, exchange.request.requestId,
            destinationContact.responder.relayId,
          ))) as Message<AckPayload>;
          expect(verifyMessage(ack)).toBe(true);
          expect(ack.type).toBe(MessageTypes.ACK);
          expect(ack.payload).toMatchObject({ ref: publication.publicationId, status: 'ok' });
        },
      };
    },
  };
}

describe('encrypted reply mixing over live relay sockets', () => {
  it('holds a shared reply batch and returns each unchanged ciphertext to its original client', async () => {
    const fixture = await setup({ windowMs: 500 });
    const exchanges = await Promise.all([fixture.submit(), fixture.submit(), fixture.submit()]);
    await expect.poll(() => fixture.arrivals.size, { interval: 10, timeout: 2_000 }).toBe(3);
    const firstArrival = Math.min(...[...fixture.arrivals.values()].map(arrival => arrival.at));
    for (const exchange of exchanges) {
      const raw = await exchange.response;
      expect(raw).toBe(fixture.arrivals.get(exchange.requestId)!.raw);
      expect(exchange.receivedAt() - firstArrival).toBeGreaterThanOrEqual(490);
      await exchange.verify(raw);
      expect(await exchange.closed).toBe(1000);
    }
    expect(destination!.getStats().stored_publications).toBe(3);
    expect(entry!.getStats().stored_publications).toBe(0);
  });

  it.each(['disconnect', 'shutdown'] as const)(
    'cancels a queued reply on %s while preserving the accepted publication', async reason => {
      const fixture = await setup({ windowMs: 500 });
      const exchange = await fixture.submit();
      await expect.poll(() => fixture.arrivals.has(exchange.requestId), { interval: 10, timeout: 2_000 }).toBe(true);
      expect(exchange.receivedAt()).toBe(0);
      expect(destination!.getStats().stored_publications).toBe(1);
      if (reason === 'disconnect') exchange.socket.terminate();
      else { await entry!.stop(); entry = undefined; }
      await exchange.closed;
      await expect(exchange.response).rejects.toThrow('Closed');
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(exchange.receivedAt()).toBe(0);
      expect(destination!.getStats().stored_publications).toBe(1);
    },
  );

  it('rejects an oversized reply without immediately returning it or undoing the accepted operation', async () => {
    const fixture = await setup({ windowMs: 100, maxBytes: 1 });
    const exchange = await fixture.submit();
    await expect(exchange.response).rejects.toThrow('4008: private_mix_unavailable');
    expect(fixture.arrivals.has(exchange.requestId)).toBe(true);
    expect(exchange.receivedAt()).toBe(0);
    expect(destination!.getStats().stored_publications).toBe(1);
  });

  it('keeps a stalled reply write charged to capacity and aborts it on shutdown', async () => {
    const fixture = await setup({ windowMs: 10, capacity: 1 });
    const originalSend = WebSocket.prototype.send;
    let heldCallback: ((error?: Error) => void) | undefined;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
      if (typeof data === 'string') {
        const frame = JSON.parse(data);
        if (frame.type === 'private_response' && fixture.arrivals.has(frame.requestId)) {
          // Withhold the entry's write callback to simulate a blocked client socket.
          heldCallback = args.find(value => typeof value === 'function');
          return;
        }
      }
      return Reflect.apply(originalSend, this, [data, ...args]);
    });
    const first = await fixture.submit();
    await expect.poll(() => !!heldCallback, { interval: 10, timeout: 2_000 }).toBe(true);
    const second = await fixture.submit();
    await expect(second.response).rejects.toThrow('4008: private_mix_unavailable');
    expect(destination!.getStats().stored_publications).toBe(2);
    await entry!.stop(); entry = undefined;
    await expect(first.response).rejects.toThrow('Closed');
    await first.closed;
    heldCallback?.(new Error('Late socket failure'));
    expect(first.receivedAt()).toBe(0);
  });
});
