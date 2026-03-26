import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import {
  generateIdentity,
  createMessage,
  serializeMessage,
  parseMessage,
  MessageTypes,
  normalize,
  hashEmbedding,
  getSharedProjectionMatrix,
  encodeBase64,
  type Identity,
  type Message,
  type AckPayload,
  type MatchPayload,
  type PublishPayload,
  type ConsentForwardPayload,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const PORT = 19090 + Math.floor(Math.random() * 1000);
let server: RelayServer;

function randomUnitVector(dims = 768): number[] {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.random() - 0.5;
  const n = normalize(v);
  return Array.from(n);
}

// Create a vector close to another
function similarVector(base: number[], noise = 0.05): number[] {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) v[i] = base[i] + (Math.random() - 0.5) * noise;
  const n = normalize(v);
  return Array.from(n);
}

const matrix = getSharedProjectionMatrix();
function toHash(vec: number[]): string {
  return encodeBase64(hashEmbedding(new Float32Array(vec), matrix));
}

function connectAndAuth(identity: Identity): Promise<{ ws: WebSocket; messages: Message[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const messages: Message[] = [];

    ws.on('open', () => {
      const authMsg = createMessage(MessageTypes.AUTH, {}, identity);
      ws.send(serializeMessage(authMsg));
    });

    ws.on('message', (data: Buffer) => {
      const msg = parseMessage(data.toString('utf-8'));
      messages.push(msg);

      // Resolve after auth ack
      if (msg.type === MessageTypes.ACK && (msg.payload as AckPayload).ref === 'auth') {
        resolve({ ws, messages });
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('connection timeout')), 5000);
  });
}

function waitForMessage(messages: Message[], type: string, timeout = 3000): Promise<Message> {
  return new Promise((resolve, reject) => {
    // Check existing messages first
    const existing = messages.find(m => m.type === type);
    if (existing) return resolve(existing);

    const start = Date.now();
    const interval = setInterval(() => {
      const found = messages.find(m => m.type === type);
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for message type: ${type}`));
      }
    }, 10);
  });
}

beforeAll(async () => {
  server = createRelayServer({
    port: PORT,
    host: '127.0.0.1',
    maxAuthAttemptsPerMin: 100, // High limit for tests
    persistDir: `/tmp/resonance-integration-test-${Date.now()}`,
    persistIntervalMs: 999_999, // Don't persist during tests
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe('Relay integration', () => {
  it('authenticates a client', async () => {
    const identity = generateIdentity();
    const { ws, messages } = await connectAndAuth(identity);

    const ack = messages.find(m => m.type === MessageTypes.ACK)!;
    expect((ack.payload as AckPayload).status).toBe('ok');
    expect((ack.payload as AckPayload).ref).toBe('auth');

    ws.close();
  });

  it('rejects invalid signature', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Send a tampered auth message
    const identity = generateIdentity();
    const authMsg = createMessage(MessageTypes.AUTH, {}, identity);
    (authMsg as any).signature = 'AAAA' + authMsg.signature.slice(4); // tamper
    ws.send(serializeMessage(authMsg));

    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4002);
  });

  it('handles publish → match notification flow', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    const aliceConn = await connectAndAuth(alice);
    const bobConn = await connectAndAuth(bob);

    // Alice publishes an offer
    const offerVec = randomUnitVector();
    const publishOffer = createMessage<PublishPayload>(MessageTypes.PUBLISH, {
      itemId: 'offer-1',
      hash: toHash(offerVec),
      itemType: 'offer',
      ttl: 86400,
    }, alice);
    aliceConn.ws.send(serializeMessage(publishOffer));

    // Wait for Alice's ACK
    await waitForMessage(aliceConn.messages, MessageTypes.ACK);

    // Bob publishes a similar need
    const needVec = similarVector(offerVec, 0.03);
    const publishNeed = createMessage<PublishPayload>(MessageTypes.PUBLISH, {
      itemId: 'need-1',
      hash: toHash(needVec),
      itemType: 'need',
      ttl: 86400,
    }, bob);
    bobConn.ws.send(serializeMessage(publishNeed));

    // Both should receive MATCH notifications
    const bobMatch = await waitForMessage(bobConn.messages, MessageTypes.MATCH);
    const aliceMatch = await waitForMessage(aliceConn.messages, MessageTypes.MATCH);

    const bobPayload = bobMatch.payload as MatchPayload;
    const alicePayload = aliceMatch.payload as MatchPayload;

    expect(bobPayload.partnerDID).toBe(alice.did);
    expect(alicePayload.partnerDID).toBe(bob.did);
    expect(bobPayload.similarity).toBeGreaterThan(0.5);
    expect(bobPayload.matchId).toBe(alicePayload.matchId);

    aliceConn.ws.close();
    bobConn.ws.close();
  });

  it('forwards consent between parties', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    const aliceConn = await connectAndAuth(alice);
    const bobConn = await connectAndAuth(bob);

    // Publish complementary items
    const vec = randomUnitVector();
    aliceConn.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
      itemId: 'o2', hash: toHash(vec), itemType: 'offer', ttl: 86400,
    }, alice)));

    await waitForMessage(aliceConn.messages, MessageTypes.ACK);

    bobConn.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
      itemId: 'n2', hash: toHash(similarVector(vec, 0.03)), itemType: 'need', ttl: 86400,
    }, bob)));

    const bobMatch = await waitForMessage(bobConn.messages, MessageTypes.MATCH);
    const matchId = (bobMatch.payload as MatchPayload).matchId;

    // Bob sends consent
    const consentMsg = createMessage(MessageTypes.CONSENT, {
      matchId,
      accept: true,
      encryptedForPartner: 'base64_encrypted_key_data',
    }, bob);
    bobConn.ws.send(serializeMessage(consentMsg));

    // Alice should receive consent forward
    const forward = await waitForMessage(aliceConn.messages, MessageTypes.CONSENT_FORWARD);
    const fwdPayload = forward.payload as ConsentForwardPayload;
    expect(fwdPayload.matchId).toBe(matchId);
    expect(fwdPayload.fromDID).toBe(bob.did);
    expect(fwdPayload.encrypted).toBe('base64_encrypted_key_data');

    aliceConn.ws.close();
    bobConn.ws.close();
  });

  it('delivers pending notifications on reconnect', async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    // Alice publishes an offer and disconnects
    const aliceConn1 = await connectAndAuth(alice);
    const offerVec = randomUnitVector();
    aliceConn1.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
      itemId: 'offline-offer', hash: toHash(offerVec), itemType: 'offer', ttl: 86400,
    }, alice)));
    await waitForMessage(aliceConn1.messages, MessageTypes.ACK);
    aliceConn1.ws.close();

    // Wait for disconnect to register
    await new Promise(r => setTimeout(r, 100));

    // Bob publishes a complementary need — Alice is offline
    const bobConn = await connectAndAuth(bob);
    bobConn.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
      itemId: 'offline-need', hash: toHash(similarVector(offerVec, 0.03)), itemType: 'need', ttl: 86400,
    }, bob)));
    // Bob gets the match immediately
    const bobMatch = await waitForMessage(bobConn.messages, MessageTypes.MATCH);
    expect((bobMatch.payload as MatchPayload).partnerDID).toBe(alice.did);
    bobConn.ws.close();

    // Alice reconnects — should receive pending match notification
    const aliceConn2 = await connectAndAuth(alice);
    const aliceMatch = await waitForMessage(aliceConn2.messages, MessageTypes.MATCH, 5000);
    expect((aliceMatch.payload as MatchPayload).partnerDID).toBe(bob.did);
    expect((aliceMatch.payload as MatchPayload).matchId).toBe((bobMatch.payload as MatchPayload).matchId);

    aliceConn2.ws.close();
  });

  it('/health returns 200', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('/stats returns correct shape', async () => {
    const res = await fetch(`http://localhost:${PORT}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('indexed_embeddings');
    expect(body).toHaveProperty('connected_nodes');
    expect(body).toHaveProperty('matches_today');
    expect(body).toHaveProperty('uptime');
  });
});
