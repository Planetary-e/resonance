import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { publicVerif } from '@cloudflare/privacypass-ts';
import {
  createBlindAdmissionRequestV2, createPublicationRecord, generatePublicationKeyMaterial,
  issueBlindAdmissionRequestV2,
} from '@resonance/core';
import { createLocalBlindAdmissionVerifierV2, createRelayServer, type RelayServer } from '@resonance/relay';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';
import { createRelayClient } from '../relay-client.js';
import { openPrivateRequestOutbox, type PrivateRequestOutbox } from '../private-request-outbox.js';
import { openPublicationOutbox, type PublicationOutbox } from '../publication-outbox.js';

const BASE_PORT = 46_000 + Math.floor(Math.random() * 1_000);
const ENTRY = `ws://127.0.0.1:${BASE_PORT}/`;
const DESTINATION = `ws://[::1]:${BASE_PORT + 1}/`;
const SAME_DOMAIN = `ws://127.0.0.1:${BASE_PORT + 2}/`;
const dirs = [0, 1, 2].map(index => `/tmp/resonance-private-client-${Date.now()}-${BASE_PORT}-${index}`);
const servers: RelayServer[] = [];

function relay(port: number, host: string, endpoint: string, persistDir: string): RelayServer {
  return createRelayServer({
    port, host, persistDir,
    relayDiscovery: {
      endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
      maxKnownRelays: 8,
    },
  });
}

beforeAll(async () => {
  servers.push(
    relay(BASE_PORT, '127.0.0.1', ENTRY, dirs[0]),
    relay(BASE_PORT + 1, '::1', DESTINATION, dirs[1]),
    relay(BASE_PORT + 2, '127.0.0.1', SAME_DOMAIN, dirs[2]),
  );
  for (const server of servers) await server.start();
  const destinationDescriptor = servers[1].getRelayDescriptor();
  const sameDomainDescriptor = servers[2].getRelayDescriptor();
  expect(destinationDescriptor).toBeDefined();
  expect(sameDomainDescriptor).toBeDefined();
  expect(servers[0].observeRelayDescriptor(destinationDescriptor!)).toBe('accepted');
  expect(servers[0].observeRelayDescriptor(sameDomainDescriptor!)).toBe('accepted');
});

afterAll(async () => {
  for (const server of [...servers].reverse()) await server.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('personal client private transport', () => {
  it('does not allow the same relay URL to act as entry and destination', () => {
    expect(() => createRelayClient({ relayUrl: ENTRY, privateEntryUrls: [ENTRY] }))
      .toThrow('separate entry and destination');
  });

  it('sends publication, search, and mailbox operations through separate observed domains', async () => {
    const client = createRelayClient({
      relayUrl: DESTINATION,
      privateEntryUrls: [ENTRY],
    });
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, keys);
    const ack = await client.submitPublicationOperation(record);
    expect(ack).toMatchObject({ status: 'ok', ref: record.publicationId });
    expect(servers[0].getStats().stored_publications).toBe(0);
    expect(servers[1].getStats().stored_publications).toBe(1);

    const [search, mailbox] = await Promise.all([client.searchV2({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'need',
      k: 5, threshold: 0.9,
    }), client.fetchMailbox(record, keys)]);
    expect(search.results.some(result => result.publicationId === record.publicationId)).toBe(true);
    expect(mailbox.envelopes).toEqual([]);
  }, 10_000); // Includes discovery, client scheduling, and both entry collection windows.

  it.each(['disconnect', 'deadline'] as const)('closes active discovery on %s without starting another fallback', async reason => {
    const stalledEntry = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(stalledEntry, 'listening');
    const address = stalledEntry.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
    let connections = 0;
    stalledEntry.on('connection', () => { connections++; });
    const client = createRelayClient({
      relayUrl: DESTINATION, fallbackUrls: [SAME_DOMAIN, `ws://[::1]:${BASE_PORT + 9}/`],
      privateEntryUrls: [`ws://127.0.0.1:${address.port}/`],
      privateTraffic: { batchWindowMs: reason === 'deadline' ? 1_000 : 10, jitterMs: 0 },
    });
    try {
      const connected = once(stalledEntry, 'connection');
      const started = performance.now();
      const pending = client.connect();
      const outcome = expect(pending).rejects.toMatchObject({
        code: reason === 'deadline' ? 'PRIVATE_OPERATION_TIMEOUT' : 'PRIVATE_OPERATION_CANCELLED',
        outcome: 'not-sent',
      });
      const [socket] = await connected;
      const closed = once(socket, 'close');
      if (reason === 'disconnect') client.disconnect();
      await outcome;
      await closed;
      if (reason === 'deadline') {
        expect(performance.now() - started).toBeGreaterThanOrEqual(9_950);
        expect(performance.now() - started).toBeLessThan(11_000);
      }
      // Give any erroneously scheduled fallback time to open another socket.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(connections).toBe(reason === 'deadline' ? 2 : 1);
      expect(stalledEntry.clients.size).toBe(0);
    } finally {
      client.disconnect();
      for (const socket of stalledEntry.clients) socket.terminate();
      await new Promise<void>(resolve => stalledEntry.close(() => resolve()));
    }
  }, 12_000);

  it('fails closed when both reachable contacts share one observed IP domain', async () => {
    const client = createRelayClient({
      relayUrl: SAME_DOMAIN,
      privateEntryUrls: [ENTRY],
    });
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xc5), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, keys);
    await expect(client.submitPublicationOperation(record)).rejects.toThrow('overlap the entry network domain');
    expect(servers[2].getStats().stored_publications).toBe(0);
  });

  it('does not discover or reserve a capability when a publication expires while waiting locally', async () => {
    const provider = vi.fn();
    const client = createRelayClient({ relayUrl: DESTINATION, privateEntryUrls: [ENTRY],
      admissionCapabilityProvider: provider, privateTraffic: { batchWindowMs: 100, jitterMs: 0 } });
    const now = Date.now();
    const record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xb4), itemType: 'offer', createdAt: now, expiresAt: now + 50,
    }, generatePublicationKeyMaterial());
    const wire = vi.spyOn(WebSocket.prototype, 'send');
    try {
      await expect(client.submitPublicationOperation(record)).rejects.toMatchObject({ outcome: 'not-sent' });
      expect(provider).not.toHaveBeenCalled(); expect(wire).not.toHaveBeenCalled();
    } finally { wire.mockRestore(); client.disconnect(); }
  });

  it('keeps a lost search response uncertain and creates a fresh admission binding only on explicit rerun', async () => {
    const bindings: string[] = [];
    const options: Parameters<typeof openPrivateRequestOutbox>[0] = {
      path: join(dirs[0], 'saved-searches.json'), encryptionKey: randomBytes(32),
      admissionCapabilityProvider: context => { bindings.push(context.requestBinding); return undefined; },
      execute: async (intent, client) => {
        if (intent.kind !== 'search') throw new Error('Expected search');
        const reply = await client.searchV2({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
          fingerprint: Buffer.from(intent.fingerprint, 'base64'), itemType: intent.itemType, k: 10, threshold: 0.65 });
        return { kind: 'search', results: reply.results };
      },
    };
    let box: PrivateRequestOutbox = openPrivateRequestOutbox(options);
    const held = box.hold({ kind: 'search', text: 'Saved search', itemType: 'need', fingerprint: Buffer.alloc(64, 0xb5).toString('base64') },
      { relayUrl: DESTINATION, fallbackUrls: [], privateEntryUrls: [ENTRY] });
    box.close(); box = openPrivateRequestOutbox(options); expect(bindings).toHaveLength(0);
    const originalSend = WebSocket.prototype.send; let lostReply = false;
    const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
      const port = (this as WebSocket & { _socket?: { localPort: number } })._socket?.localPort;
      if (port === BASE_PORT && typeof data === 'string' && JSON.parse(data).type === 'private_response') { lostReply = true; return; }
      return Reflect.apply(originalSend, this, [data, ...args]);
    });
    try {
      await expect(box.release(held.id)).rejects.toThrow('deadline');
      expect(lostReply).toBe(true); expect(box.list()[0].state).toBe('outcome-unknown'); expect(bindings).toHaveLength(1);
      box.close(); box = openPrivateRequestOutbox(options); expect(bindings).toHaveLength(1);
      spy.mockRestore();
      expect((await box.release(held.id)).kind).toBe('search');
      expect(bindings).toHaveLength(2); expect(bindings[0]).not.toBe(bindings[1]);
      expect(box.list()[0]).toMatchObject({ state: 'completed', attempts: 2 });
    } finally { spy.mockRestore(); box.close(); }
  }, 16_000);

  it('preserves an accepted publication and exact blind-token retry after the shared deadline loses its reply', async () => {
    const entryEndpoint = `ws://127.0.0.1:${BASE_PORT + 3}/`;
    const destinationEndpoint = `ws://[::1]:${BASE_PORT + 4}/`;
    const entryDir = `${dirs[0]}-blind-entry`;
    const destinationDir = `${dirs[0]}-blind-destination`;
    const scope = { issuer: 'community-test', community: 'public', epoch: '2026-09' };
    const mode = publicVerif.BlindRSAMode.PSS;
    const keys = await publicVerif.Issuer.generateKey(mode, {
      modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]),
    });
    const issuer = new publicVerif.Issuer(mode, scope.issuer, keys.privateKey, keys.publicKey);
    const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey);
    const token = await blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request));
    const wallet = openBlindAdmissionWalletV2({
      path: join(entryDir, 'client-wallet.json'), encryptionKey: randomBytes(32),
      issuerPublicKey: keys.publicKey, scope,
    });
    expect(await wallet.importTokens([token])).toBe(1);
    const verifier = createLocalBlindAdmissionVerifierV2({
      directory: destinationDir, scope, issuerPublicKey: keys.publicKey,
    });
    const entry = relay(BASE_PORT + 3, '127.0.0.1', entryEndpoint, entryDir);
    const destination = createRelayServer({
      port: BASE_PORT + 4, host: '::1', persistDir: destinationDir,
      admissionVerifier: verifier,
      relayDiscovery: {
        endpoints: [destinationEndpoint], reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8,
      },
    });
    await entry.start();
    await destination.start();
    let replySpy: ReturnType<typeof vi.spyOn> | undefined;
    let outbox: PublicationOutbox | undefined;
    try {
      expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
      const client = createRelayClient({
        relayUrl: destinationEndpoint,
        privateEntryUrls: [entryEndpoint],
        admissionCapabilityProvider: context => wallet.capabilityFor(context),
      });
      const now = Date.now();
      const record = createPublicationRecord({
        groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
        fingerprint: new Uint8Array(64).fill(0xd6), itemType: 'offer',
        createdAt: now, expiresAt: now + 86_400_000,
      }, generatePublicationKeyMaterial());
      const cancelled = client.submitPublicationOperation(record);
      client.disconnect();
      await expect(cancelled).rejects.toThrow('disconnected');
      expect(wallet.available()).toBe(1);
      const originalSend = WebSocket.prototype.send;
      let heldSocket: WebSocket | undefined;
      let heldCallback: ((error?: Error) => void) | undefined;
      replySpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
        const port = (this as WebSocket & { _socket?: { localPort: number } })._socket?.localPort;
        if (port === BASE_PORT + 3 && typeof data === 'string' && JSON.parse(data).type === 'private_response') {
          // Destination accepted the record; hold the entry's final write to the client.
          heldSocket = this;
          heldCallback = args.find(value => typeof value === 'function');
          return;
        }
        return Reflect.apply(originalSend, this, [data, ...args]);
      });
      const outboxOptions = { path: join(entryDir, 'outbox.json'), encryptionKey: randomBytes(32),
        admissionCapabilityProvider: (context: Parameters<typeof wallet.capabilityFor>[0]) => wallet.capabilityFor(context) };
      outbox = openPublicationOutbox(outboxOptions);
      const held = outbox.hold(record, { relayUrl: destinationEndpoint, fallbackUrls: [], privateEntryUrls: [entryEndpoint] });
      expect(wallet.available()).toBe(1);
      expect(destination.getStats().stored_publications).toBe(0);
      await expect(outbox.release(held.id)).rejects.toMatchObject({
        code: 'PRIVATE_OPERATION_TIMEOUT', outcome: 'unknown',
      });
      expect(outbox.list()[0].state).toBe('outcome-unknown');
      outbox.close(); outbox = openPublicationOutbox(outboxOptions);
      expect(outbox.list()[0].state).toBe('outcome-unknown');
      expect(heldCallback).toBeDefined();
      expect(destination.getStats().stored_publications).toBe(1);
      expect(wallet.available()).toBe(0);
      await expect.poll(() => heldSocket?.readyState).toBe(WebSocket.CLOSED);
      replySpy.mockRestore();
      heldCallback?.(new Error('Late write failure'));
      // The original signed operation reuses its reserved capability; no new token is available.
      expect((await outbox.release(held.id)).status).toBe('ok');
      expect(outbox.list()[0].state).toBe('delivered');
      expect(entry.getStats().stored_publications).toBe(0);
      expect(destination.getStats().stored_publications).toBe(1);
      expect(wallet.available()).toBe(0);
    } finally {
      replySpy?.mockRestore();
      outbox?.close();
      wallet.close();
      await destination.stop();
      await entry.stop();
      verifier.close();
      rmSync(entryDir, { recursive: true, force: true });
      rmSync(destinationDir, { recursive: true, force: true });
    }
  }, 20_000);
});
